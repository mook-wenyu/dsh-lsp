import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectProjectRootSync, resolveProjectRoot } from '../src/workspace-resolver.js'

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
