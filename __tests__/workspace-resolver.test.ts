import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectProjectRootSync,
  resolveProjectRoot,
  detectProjectLanguages,
  detectProjectLanguagesSync,
  resolveProjectRootFor,
} from '../src/workspace-resolver.js'

describe('detectProjectRootSync', () => {
  it('cwd 向上命中项目文件返回该目录（提示词条件注入判定）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-detect-'))
    const nested = join(root, 'a', 'b')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'Probe.csproj'), '')

    expect(detectProjectRootSync(nested)).toBe(root)
  })

  it('无项目文件时返回 undefined（不回退 cwd，非 C# 会话零注入）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-nodetect-'))

    expect(detectProjectRootSync(root)).toBeUndefined()
  })
})

describe('resolveProjectRoot', () => {
  it('优先从文件目录向上发现最近的 solution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-root-'))
    const project = join(root, 'src', 'App')
    const file = join(project, 'Program.cs')
    await mkdir(project, { recursive: true })
    await writeFile(join(root, 'App.slnx'), '')
    await writeFile(file, 'class Program {}')

    await expect(resolveProjectRoot(file, root)).resolves.toBe(root)
  })

  it('同目录按 .slnx > .sln > .csproj 优先', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-priority-'))
    const file = join(root, 'Program.cs')
    await writeFile(file, 'class Program {}')
    await writeFile(join(root, 'App.csproj'), '')
    await writeFile(join(root, 'App.sln'), '')
    await writeFile(join(root, 'App.slnx'), '')

    await expect(resolveProjectRoot(file, root)).resolves.toBe(root)
  })

  it('无项目标记时回退到 session cwd，无上下文时返回 undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-fallback-'))
    const file = join(root, 'Program.cs')
    await writeFile(file, 'class Program {}')

    await expect(resolveProjectRoot(file, root)).resolves.toBe(root)
    await expect(resolveProjectRoot(file, undefined)).resolves.toBeUndefined()
  })

  it('常规命名的 .csproj 按扩展名命中（Bug E 回归锁：字面名比对曾漏检）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-named-'))
    const project = join(root, 'test-project')
    const file = join(project, 'Program.cs')
    await mkdir(project, { recursive: true })
    // 常规命名：前缀任意 + 扩展名匹配（旧实现只认字面文件名 ".csproj"，此处必挂）
    await writeFile(join(project, 'TestProject.csproj'), '')
    await writeFile(file, 'class Program {}')

    await expect(resolveProjectRoot(file, root)).resolves.toBe(project)
  })
})

// ─── 多语言联合探测（2026-08-25 新增）────────────────────────────────
describe('detectProjectLanguages（TS/JS 标记）', () => {
  it('package.json 命中 → typescript；无任何标记 → 空对象', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-tspkg-'))
    const nested = join(root, 'a', 'b')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')

    expect(detectProjectLanguagesSync(nested)).toEqual({ typescript: root })

    const empty = await mkdtemp(join(tmpdir(), 'dsh-lsp-empty-'))
    expect(detectProjectLanguagesSync(empty)).toEqual({})
  })

  it('tsconfig.json / jsconfig.json 同样视为 TS/JS 项目标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-tscfg-'))
    const nested = join(root, 'src')
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'tsconfig.json'), '{}')
    expect(detectProjectLanguagesSync(nested)).toEqual({ typescript: root })

    const jsRoot = await mkdtemp(join(tmpdir(), 'dsh-lsp-jscfg-'))
    await writeFile(join(jsRoot, 'jsconfig.json'), '{}')
    expect(detectProjectLanguagesSync(jsRoot)).toEqual({ typescript: jsRoot })
  })

  it('monorepo 同根双语言：C# 与 TS/JS 各自命中（池按语言分实例的依据）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-mono-'))
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'App.slnx'), '')

    const detected = detectProjectLanguagesSync(join(root, 'sub'))
    expect(detected).toEqual({ csharp: root, typescript: root })
  })

  it('最近命中优先（子目录 tsconfig 优先于父目录 package.json）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-nearest-'))
    const sub = join(root, 'lib')
    await mkdir(sub, { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(sub, 'tsconfig.json'), '{}')

    expect(detectProjectLanguagesSync(sub)).toEqual({ typescript: sub })
    // 但子目录无标记时向上命中父目录
    expect(detectProjectLanguagesSync(root)).toEqual({ typescript: root })
  })

  it('异步版 detectProjectLanguages 与同步版一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-async-'))
    await writeFile(join(root, 'pnpm-workspace.yaml'), '')
    await writeFile(join(root, 'package.json'), '{}')

    await expect(detectProjectLanguages(root)).resolves.toEqual({ typescript: root })
  })
})

describe('resolveProjectRootFor（按语言）', () => {
  it('typescript：tsconfig 命中返回项目根', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-tsroot-'))
    const file = join(root, 'src', 'app.ts')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'tsconfig.json'), '{}')
    await writeFile(file, 'export const a = 1')

    await expect(resolveProjectRootFor('typescript', file, root)).resolves.toBe(root)
  })

  it('typescript：无标记时回退 session cwd；无 cwd 返回 undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-tsfallback-'))
    const file = join(root, 'app.js')
    await writeFile(file, 'console.log(1)')

    await expect(resolveProjectRootFor('typescript', file, root)).resolves.toBe(root)
    await expect(resolveProjectRootFor('typescript', file, undefined)).resolves.toBeUndefined()
  })

  it('语言独立：.ts 文件不回退到 C# 标记（同根双语言各取所需）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-tsinmixed-'))
    const file = join(root, 'app.ts')
    await writeFile(join(root, 'App.csproj'), '')
    await writeFile(file, 'export {}')

    await expect(resolveProjectRootFor('typescript', file, root)).resolves.toBe(root)
    await expect(resolveProjectRootFor('csharp', file, root)).resolves.toBe(root)
  })
})
