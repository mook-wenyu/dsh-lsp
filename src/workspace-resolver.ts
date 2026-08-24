/**
 * 根据当前会话和目标文件解析 C# 工区根目录。
 *
 * 解析顺序：文件所在目录向上查找最近的含 .slnx/.sln/.csproj 文件的目录
 * （按扩展名匹配，如 TestProject.csproj、EchoCore.sln；2026-08-23 修复：
 * 原实现用字面名 ".csproj" 精确比对，常规命名的项目文件全部漏检）。
 * 没有项目标记时回退到会话 cwd。返回目录而不是文件，供 csharp-ls
 * 的 rootUri 与子进程 cwd 使用。
 */
import { readdir, stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 项目文件扩展名（按优先级排列；同目录命中任一即返回该目录）。 */
const PROJECT_SUFFIXES = ['.slnx', '.sln', '.csproj'] as const

function canonical(path: string): string {
  return normalize(resolve(path))
}

function hasProjectName(names: readonly string[]): boolean {
  return names.some((name) =>
    (PROJECT_SUFFIXES as readonly string[]).some((suffix) => name.endsWith(suffix)),
  )
}

async function hasProjectFile(dir: string): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // 无权限/不存在：视同无标记，向上层继续
    return false
  }
  return hasProjectName(names)
}

/** 同步版探测：供 systemPrompt.context 的同步 text 回调使用。 */
function hasProjectFileSync(dir: string): boolean {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  return hasProjectName(names)
}

/** 向上遍历的公共骨架；hit 决定命中判定方式，miss 决定未命中时的归宿。 */
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

/**
 * 纯探测：dir 及其祖先是否含项目文件；命中返回该目录，未命中返回 undefined。
 * 与 resolveProjectRoot 不同——不回退 session cwd，专供「是否 C# 项目」判定。
 */
export async function detectProjectRoot(dir: string): Promise<string | undefined> {
  return walkUp(canonical(dir), hasProjectFile)
}

/**
 * 同步纯探测：语义同 detectProjectRoot。
 * systemPrompt.context 的 text 回调同步执行（宿主不 await），必须用此版本；
 * 组装期每步一次调用的阻塞可忽略。
 */
export function detectProjectRootSync(dir: string): string | undefined {
  let current = canonical(dir)
  while (true) {
    if (hasProjectFileSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * 解析当前文件对应的项目根目录。
 *
 * 显式 root 由调用方在上层处理；本函数只负责文件路径和 session cwd。
 * 未发现项目且没有 cwd 时返回 undefined，避免启动错误工作区的语言服务。
 */
export async function resolveProjectRoot(
  filePath: string | undefined,
  sessionCwd: string | undefined,
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
  // 命中项目文件 → 项目根；全程未命中 → 回退会话 cwd（原语义）
  return (await walkUp(start, hasProjectFile)) ??
    (sessionCwd === undefined ? undefined : canonical(sessionCwd))
}
