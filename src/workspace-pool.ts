import { resolve } from 'node:path'
import type { LanguageId } from './languages.js'
import type { LspClient } from './lsp-client.js'
import type { LspServerManager } from './server-manager.js'

/** 一个 session + language + projectRoot 的隔离 LSP 运行实例。 */
export interface LspWorkspaceInstance {
  readonly client: LspClient
  readonly manager: LspServerManager
}

export type LspWorkspaceFactory = (projectRoot: string, languageId: LanguageId) => LspWorkspaceInstance

/** 键含语言维：monorepo 同根多语言（C#+TS/JS）各持独立服务器实例，互不干扰。 */
function keyOf(sessionId: string, languageId: LanguageId, projectRoot: string): string {
  return `${sessionId}\0${languageId}\0${resolve(projectRoot)}`
}

/**
 * 按会话、语言和项目根目录隔离 LSP 实例，避免未保存文档、诊断和重启状态串线。
 * 实例自身保持懒启动；池只负责生命周期与复用。
 */
export class LspWorkspacePool {
  private readonly instances = new Map<string, LspWorkspaceInstance>()

  constructor(private readonly factory: LspWorkspaceFactory) {}

  get(sessionId: string, languageId: LanguageId, projectRoot: string): LspWorkspaceInstance {
    const key = keyOf(sessionId, languageId, projectRoot)
    const existing = this.instances.get(key)
    if (existing !== undefined) return existing
    const instance = this.factory(resolve(projectRoot), languageId)
    this.instances.set(key, instance)
    return instance
  }

  get size(): number {
    return this.instances.size
  }

  async disposeSession(sessionId: string): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [key, instance] of this.instances) {
      if (!key.startsWith(`${sessionId}\0`)) continue
      this.instances.delete(key)
      pending.push(instance.manager.dispose())
    }
    await Promise.all(pending)
  }

  async dispose(): Promise<void> {
    const pending = [...this.instances.values()].map((instance) => instance.manager.dispose())
    this.instances.clear()
    await Promise.all(pending)
  }
}