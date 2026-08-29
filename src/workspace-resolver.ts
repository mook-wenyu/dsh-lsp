/**
 * 工作区项目根解析（多语言化，2026-08-25）。
 *
 * 按「语言标记」向上探测项目根：
 * - C#：.slnx/.sln/.csproj（后缀匹配）
 * - TS/JS：package.json/tsconfig.json/jsconfig.json（精确文件名匹配）
 *
 * 解析顺序：文件所在目录向上查找最近的含该语言标记的目录；没有标记时回退
 * 会话 cwd。返回目录而不是文件，供语言服务器的 rootUri 与子进程 cwd 使用。
 *
 * 兼容性：detectProjectRoot/detectProjectRootSync/resolveProjectRoot 签名与
 * C# 语义保持不变（内部委托联合探测的 csharp 字段）。
 */
import { readdir, stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import { LANGUAGES, type LanguageId, type ProjectMarker } from './languages.js'

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function canonical(path: string): string {
  return normalize(resolve(path))
}

function matchesMarker(name: string, marker: ProjectMarker): boolean {
  return marker.kind === 'suffix' ? name.endsWith(marker.value) : name === marker.value
}

function hasMarkers(names: readonly string[], markers: readonly ProjectMarker[]): boolean {
  return markers.some((m) => names.some((n) => matchesMarker(n, m)))
}

/** 向上遍历；hit 决定命中判定，返回首个命中目录；到文件系统根仍未命中返回 undefined。 */
async function walkUp(
  start: string,
  hit: (dir: string) => Promise<boolean>,
): Promise<string | undefined> {
  let current = start
  while (true) {
    if (await hit(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** 单目录是否有某语言的项目标记（读目录失败视同无标记）。 */
async function hasLanguageMarkers(dir: string, markers: readonly ProjectMarker[]): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return false
  }
  return hasMarkers(names, markers)
}

/** 同步版单目录判定（供 systemPrompt.context 同步回调）。 */
function hasLanguageMarkersSync(dir: string, markers: readonly ProjectMarker[]): boolean {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  return hasMarkers(names, markers)
}

/**
 * 联合探测：dir 及其祖先中，每种语言最近命中的项目根。
 * 单次向上遍历；某语言命中后不再为其继续探测，全部语言命中即提前停止。
 * 返回 Partial<Record<LanguageId, string>>：语言 → 最近命中目录（可能为空对象）。
 */
export async function detectProjectLanguages(
  dir: string,
): Promise<Partial<Record<LanguageId, string>>> {
  const langs = Object.keys(LANGUAGES) as LanguageId[]
  const found: Partial<Record<LanguageId, string>> = {}
  let current = canonical(dir)
  while (true) {
    const missing = langs.filter((l) => !found[l])
    if (missing.length === 0) break
    let dirNames: string[] | undefined
    try {
      dirNames = await readdir(current)
    } catch {
      dirNames = undefined
    }
    if (dirNames !== undefined) {
      for (const lang of missing) {
        if (hasMarkers(dirNames, LANGUAGES[lang].projectMarkers)) found[lang] = current
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}

/** 同步联合探测（语义同 detectProjectLanguages；供同步 text 回调）。 */
export function detectProjectLanguagesSync(
  dir: string,
): Partial<Record<LanguageId, string>> {
  const langs = Object.keys(LANGUAGES) as LanguageId[]
  const found: Partial<Record<LanguageId, string>> = {}
  let current = canonical(dir)
  while (true) {
    const missing = langs.filter((l) => !found[l])
    if (missing.length === 0) break
    let dirNames: string[] | undefined
    try {
      dirNames = readdirSync(current)
    } catch {
      dirNames = undefined
    }
    if (dirNames !== undefined) {
      for (const lang of missing) {
        if (hasMarkers(dirNames, LANGUAGES[lang].projectMarkers)) found[lang] = current
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}

/**
 * 纯探测：dir 及其祖先是否含 C# 项目文件；命中返回该目录，未命中返回 undefined。
 * 与 resolveProjectRoot 不同——不回退 session cwd，专供「是否 C# 项目」判定。
 */
export async function detectProjectRoot(dir: string): Promise<string | undefined> {
  return (await detectProjectLanguages(dir)).csharp
}

/**
 * 同步纯探测：语义同 detectProjectRoot。
 * systemPrompt.context 的 text 回调同步执行（宿主不 await），必须用此版本。
 */
export function detectProjectRootSync(dir: string): string | undefined {
  return detectProjectLanguagesSync(dir).csharp
}

/**
 * 按语言解析当前文件对应的项目根目录。
 *
 * 显式 root 由调用方在上层处理；本函数只负责文件路径和 session cwd。
 * 未发现项目且没有 cwd 时返回 undefined，避免启动错误工作区的语言服务。
 */
async function resolveProjectRootForLanguage(
  filePath: string | undefined,
  sessionCwd: string | undefined,
  lang: LanguageId,
): Promise<string | undefined> {
  if (filePath === undefined && sessionCwd === undefined) return undefined
  const candidate = filePath ?? sessionCwd!
  const start = canonical(
    await isDirectory(candidate)
      ? candidate
      : isAbsolute(candidate)
        ? dirname(candidate)
        : sessionCwd ?? candidate,
  )
  const markers = LANGUAGES[lang].projectMarkers
  // 命中该语言项目标记 → 项目根；全程未命中 → 回退会话 cwd（原语义）
  return (await walkUp(start, (d) => hasLanguageMarkers(d, markers))) ??
    (sessionCwd === undefined ? undefined : canonical(sessionCwd))
}

/** 按语言解析项目根（无文件参数场景：workspace_diagnostics 等）。 */
export async function resolveProjectRootFor(
  lang: LanguageId,
  filePath: string | undefined,
  sessionCwd: string | undefined,
): Promise<string | undefined> {
  return resolveProjectRootForLanguage(filePath, sessionCwd, lang)
}

/**
 * [兼容保留] 解析 C# 文件对应的项目根目录。语义不变：
 * 文件/目录 → 向上找 .slnx/.sln/.csproj → 未命中回退会话 cwd。
 */
export async function resolveProjectRoot(
  filePath: string | undefined,
  sessionCwd: string | undefined,
): Promise<string | undefined> {
  return resolveProjectRootForLanguage(filePath, sessionCwd, 'csharp')
}