import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { LspWorkspacePool } from '../src/workspace-pool.js'

describe('LspWorkspacePool', () => {
  it('同一 session、语言与 projectRoot 复用 manager/client', () => {
    const create = vi.fn((root: string, lang: string) => ({ root, lang }))
    const pool = new LspWorkspacePool(create as never)

    const first = pool.get('session-a', 'typescript', 'D:/repo/app')
    const second = pool.get('session-a', 'typescript', 'D:/repo/app')

    expect(second).toBe(first)
    expect(create).toHaveBeenCalledOnce()
  })

  it('不同 session / 语言 / projectRoot 隔离实例（含 monorepo 同根双语言）', () => {
    const create = vi.fn((root: string, lang: string) => ({ root, lang }))
    const pool = new LspWorkspacePool(create as never)

    const a = pool.get('session-a', 'typescript', 'D:/repo/app')
    const b = pool.get('session-b', 'typescript', 'D:/repo/app')
    const c = pool.get('session-a', 'typescript', 'D:/repo/server')
    // monorepo 同根：C# 与 TS/JS 各持独立服务器实例
    const d = pool.get('session-a', 'csharp', 'D:/repo/app')
    // 同语言同根复用
    const e = pool.get('session-a', 'typescript', 'D:/repo/app')

    expect(new Set([a, b, c, d]).size).toBe(4)
    expect(e).toBe(a)
    expect(create).toHaveBeenCalledTimes(4)
    expect(create).toHaveBeenCalledWith(resolve('D:/repo/app'), 'csharp')
    expect(create).toHaveBeenCalledWith(resolve('D:/repo/app'), 'typescript')
  })

  it('disposeSession 只释放目标会话实例（含同会话多语言）', async () => {
    const disposeA = vi.fn().mockResolvedValue(undefined)
    const disposeB = vi.fn().mockResolvedValue(undefined)
    const disposeTs = vi.fn().mockResolvedValue(undefined)
    const pool = new LspWorkspacePool((root: string, lang: string) => ({
      manager: {
        dispose: lang === 'typescript'
          ? disposeTs
          : root.endsWith('app') ? disposeA : disposeB,
      } as never,
      client: {} as never,
    }))

    pool.get('session-a', 'csharp', 'D:/repo/app')
    pool.get('session-a', 'csharp', 'D:/repo/server')
    pool.get('session-a', 'typescript', 'D:/repo/app')
    pool.get('session-b', 'csharp', 'D:/repo/app')
    await pool.disposeSession('session-a')

    expect(disposeA).toHaveBeenCalledOnce()
    expect(disposeB).toHaveBeenCalledOnce()
    expect(disposeTs).toHaveBeenCalledOnce()
    expect(pool.size).toBe(1)
  })
})