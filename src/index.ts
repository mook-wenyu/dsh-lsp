/**
 * dsh-lsp-client 插件入口：Cordis 插件注册 + 工具绑定。
 *
 * 在 DSH web profile 中通过 cordis.yml 配置加载：
 * ```yaml
 * - id: lsp-client
 *   name: '@echocore/dsh-lsp-client'
 *   config:
 *     enabled: true
 *     serverCommand: csharp-ls
 *     workspaceRoot: /path/to/csharp/project
 * ```
 *
 * @module @echocore/dsh-lsp-client
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { LspServerManager } from './server-manager.js';
import { LspClient } from './lsp-client.js';
import { createLspTools } from './tools.js';
import type { LspServerState } from './types.js';
import { installLspPrompt } from './prompt.js';
import { resolveProjectRoot } from './workspace-resolver.js';
import { LspWorkspacePool } from './workspace-pool.js';
import type { LspExecutionContext } from './tools.js';

/** Cordis Context 扩展类型（声明 dsh-tools 注入的 tools 服务 + systemPrompt 服务）。 */
type ExtendedContext = Omit<Context, 'tools' | 'systemPrompt'> & {
  tools: {
    register(definition: unknown): () => void;
  };
  systemPrompt: {
    context(entry: { name: string; order: number; text: (assembly: any) => string }): void;
  };
};

/** 插件名称（Cordis loader 诊断用）。 */
export const name = 'lsp-client';

/** 插件依赖声明。 */
export const inject: string[] = ['tools', 'systemPrompt'];

/**
 * 插件配置 schema（Schemastery / Standard Schema V1）。
 * Cordis 在 Fiber 构造时自动调用 Config["~standard"].validate(config)。
 */
interface LspClientConfig {
  /** 是否启用 LSP 客户端。默认 true。 */
  enabled?: boolean;
  /** LSP server 命令。默认 'csharp-ls'。 */
  serverCommand?: string;
  /** 传递给 LSP server 的额外参数。 */
  serverArgs?: string[];
  /** 可选固定工作区根目录；未配置时按当前会话和目标文件动态发现。 */
  workspaceRoot?: string;
  /** initialize 握手超时（毫秒）。默认 30000。 */
  startupTimeoutMs?: number;
  /** 插件加载时自动启动 server。默认 false（首次工具调用时启动）。 */
  autoStart?: boolean;
  /** 日志级别。默认 'warn'。 */
  logLevel?: 'off' | 'error' | 'warn' | 'info' | 'debug';
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 LSP 客户端'),
  serverCommand: Schema.string().default('csharp-ls').description('LSP server 命令'),
  serverArgs: Schema.array(Schema.string()).default([]).description('传递给 LSP server 的额外参数'),
  workspaceRoot: Schema.string().description('可选 LSP 工作区根目录；未配置时按会话动态发现'),
  startupTimeoutMs: Schema.number().default(30000).description('initialize 握手超时（毫秒）'),
  autoStart: Schema.boolean().default(false).description('插件加载时自动启动 server'),
  logLevel: Schema.union(['off', 'error', 'warn', 'info', 'debug']).default('warn').description('日志级别'),
});

/**
 * Cordis 插件入口函数。
 *
 * 1. 验证配置
 * 2. 创建 LspServerManager + LspClient
 * 3. 注册 LSP 提示词段到 systemPrompt.context
 * 4. 注册 14 个 LSP 工具到 ctx.tools
 * 5. 监听 tools/result 事件，编辑 .cs 文件后自动注入诊断摘要
 * 6. 可选自动启动
 * 7. ctx.dispose() 时优雅关闭
 */
export function apply(ctx: ExtendedContext, config: LspClientConfig): void {
  // 配置守卫：enabled=false 时不注册任何内容
  if (config.enabled === false) {
    ctx.logger.info('[lsp-client] 已禁用，跳过注册');
    return;
  }

  // workspaceRoot 可选：未配置时按当前工具调用的 session cwd + file_path 动态发现。
  const workspaceRootOverride = config.workspaceRoot;

  const pool = new LspWorkspacePool((projectRoot) => {
    const serverManager = new LspServerManager({
      command: config.serverCommand ?? 'csharp-ls',
      args: config.serverArgs ?? [],
      workspaceRoot: projectRoot,
      startupTimeoutMs: config.startupTimeoutMs ?? 30_000,
      logLevel: config.logLevel ?? 'warn',
      onStateChange: (state: LspServerState) => {
        ctx.logger.info(`[lsp-client] ${projectRoot} 服务器状态: ${state}`);
      },
      onLog: (level: string, message: string) => {
        if (level === 'error') ctx.logger.error(`[lsp-client] ${projectRoot} ${message}`);
        else if (level === 'warn') ctx.logger.warn(`[lsp-client] ${projectRoot} ${message}`);
        else ctx.logger.info(`[lsp-client] ${projectRoot} ${message}`);
      },
    });
    return { manager: serverManager, client: new LspClient(serverManager) };
  });

  const resolveWorkspace = async (filePath: string | undefined, exec?: LspExecutionContext) => {
    const sessionId = exec?.agent?.id ?? 'anonymous';
    const sessionCwd = exec?.agent?.session?.header?.cwd;
    const projectRoot = workspaceRootOverride ?? await resolveProjectRoot(filePath, sessionCwd);
    if (projectRoot === undefined) {
      throw new Error('无法确定 C# 项目根目录：请从带 session cwd 的会话调用，或配置 workspaceRoot');
    }
    return pool.get(sessionId, projectRoot);
  };

  // 懒启动：池实例创建时不拉起 server，首次真正使用前必须就绪。
  // start() 幂等（ready/starting 双守卫），并发调用安全。
  const resolveClient = async (filePath: string | undefined, exec?: LspExecutionContext) => {
    const instance = await resolveWorkspace(filePath, exec);
    await instance.manager.start();
    return instance.client;
  };

  // 注册 LSP 提示词段
  installLspPrompt(ctx);

  // 创建并注册 14 个 LSP 工具
  // defineTool 已在 tools.ts 内完成 parameters/output schema 编译与 execute 校验包装，
  // 此处直接注册，禁止再对编译产物做二次处理。
  const tools = createLspTools(resolveClient);
  const disposers: (() => void)[] = [];

  for (const tool of tools) {
    const dispose = ctx.tools.register(tool);
    disposers.push(dispose);
  }

  ctx.logger.info(`[lsp-client] 已注册 ${tools.length} 个 LSP 工具（动态工作区模式）`);

  // Agent 会话结束时释放该会话的所有 csharp-ls 实例，避免 Roslyn 进程泄漏。
  (ctx as any).on?.('agent/disposed', (payload: { agent: { id: string } }) => {
    void pool.disposeSession(payload.agent.id);
  });

  // ── tools/result hook：编辑 .cs 文件后自动注入诊断摘要 ──
  // 使用 DSH 当前 tools/result 协议字段：name、arguments、agent。
  // 每次诊断按 session + projectRoot 选取对应实例，避免多项目串线。
  const csFilePattern = /\.cs$/;
  const lspToolPattern = /^lsp_/;
  const diagnosticCooldown = new Map<string, number>();
  const DIAGNOSTIC_COOLDOWN_MS = 30_000;
  const lastDiagnosticFingerprints = new Map<string, string>();

  try {
    (ctx as any).on?.('tools/result', (exec: any, _result: any) => {
      try {
        const toolName = exec?.name as string | undefined;
        if (!toolName || lspToolPattern.test(toolName)) return;

        const args = exec?.arguments as { file_path?: string; path?: string } | undefined;
        const filePath = args?.file_path ?? args?.path;
        if (!filePath || !csFilePattern.test(filePath)) return;

        const execution = exec as LspExecutionContext;
        const sessionId = execution.agent?.id ?? 'anonymous';
        const now = Date.now();
        const cooldownKey = `${sessionId}\\0${filePath}`;
        const lastInjection = diagnosticCooldown.get(cooldownKey) ?? 0;
        if (now - lastInjection < DIAGNOSTIC_COOLDOWN_MS) return;
        diagnosticCooldown.set(cooldownKey, now);

        resolveWorkspace(filePath, execution).then(async ({ manager, client }) => {
          await manager.start();
          const diags = await client.diagnostics(filePath);
          const errors = diags.filter((d) => d.severity === 'error');
          if (errors.length === 0) return;

          const fingerprint = errors.map((d) => `${d.range.start.line}:${d.code}:${d.message}`).join('|');
          if (fingerprint === lastDiagnosticFingerprints.get(cooldownKey)) return;
          lastDiagnosticFingerprints.set(cooldownKey, fingerprint);

          const summary = errors.slice(0, 5).map(
            (d) => `  行${d.range.start.line + 1}: ${d.code ? `[${d.code}] ` : ''}${d.message}`,
          ).join('\\n');
          const hint = `[lsp] 编辑后发现 ${errors.length} 个编译错误：\\n${summary}\\n使用 lsp_diagnostics + lsp_code_action 验证和修复。`;
          ctx.logger.info(`[lsp-client] 自动诊断注入: ${errors.length} 个错误 (${filePath.split(/[/\\\\]/).pop()})`);
          execution.agent?.steer?.({ source: { kind: 'plugin' }, content: [{ type: 'text', text: hint }] } as any);
        }).catch(() => {
          // 诊断失败不阻塞工具主流程。
        });
      } catch {
        // hook 执行异常不阻塞工具主流程。
      }
    });
  } catch {
    // 非所有宿主版本都提供 tools/result 事件。
  }

  if (config.autoStart && workspaceRootOverride) {
    const instance = pool.get('startup', workspaceRootOverride);
    instance.manager.start().catch((err) => {
      ctx.logger.error(`[lsp-client] 自动启动失败: ${err}`);
    });
  }

  ctx.effect(() => () => {
    void pool.dispose();
  }, 'lsp-client workspace pool');
}
