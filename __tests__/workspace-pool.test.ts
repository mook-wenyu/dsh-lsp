import { describe, expect, it, vi } from 'vitest'
import { LspWorkspacePool } from '../src/workspace-pool.js'

describe('LspWorkspacePool', () => {
  it('同一 session 与 projectRoot 复用 manager/client', () => {
    const create = vi.fn((root: string) => ({ root }))
    const pool = new LspWorkspacePool(create as never)

    const first = pool.get('session-a', 'D:/repo/app')
    const second = pool.get('session-a', 'D:/repo/app')

    expect(second).toBe(first)
    expect(create).toHaveBeenCalledOnce()
  })

  it('不同 session 或 projectRoot 隔离实例', () => {
    const create = vi.fn((root: string) => ({ root }))
    const pool = new LspWorkspacePool(create as never)

    const a = pool.get('session-a', 'D:/repo/app')
    const b = pool.get('session-b', 'D:/repo/app')
    const c = pool.get('session-a', 'D:/repo/server')

    expect(new Set([a, b, c]).size).toBe(3)
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('disposeSession 只释放目标会话实例', async () => {
    const disposeA = vi.fn().mockResolvedValue(undefined)
    const disposeB = vi.fn().mockResolvedValue(undefined)
    const pool = new LspWorkspacePool((root: string) => ({
      manager: { dispose: root.endsWith('app') ? disposeA : disposeB } as never,
      client: {} as never,
    }))

    pool.get('session-a', 'D:/repo/app')
    pool.get('session-a', 'D:/repo/server')
    pool.get('session-b', 'D:/repo/app')
    await pool.disposeSession('session-a')

    expect(disposeA).toHaveBeenCalledOnce()
    expect(disposeB).toHaveBeenCalledOnce()
    expect(pool.size).toBe(1)
  })
})
