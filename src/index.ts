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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { LspServerManager } from './server-manager.js';
import { LspClient } from './lsp-client.js';
import { createLspTools } from './tools.js';
import type { LspServerState } from './types.js';
import { installLspPrompt } from './prompt.js';
import { resolveProjectRootFor, detectProjectLanguages, detectProjectLanguagesSync } from './workspace-resolver.js';
import { LspWorkspacePool } from './workspace-pool.js';
import {
  LANGUAGES,
  languageOfFile,
  DEFAULT_LANGUAGE,
  resolveServerLaunch,
  type LanguageId,
} from './languages.js';
import type { LspExecutionContext } from './tools.js';

/** Cordis Context 扩展类型（声明 dsh-tools 注入的 tools 服务 + systemPrompt 服务）。 */
type ExtendedContext = Omit<Context, 'tools' | 'systemPrompt'> & {
  tools: {
    register(definition: unknown): () => void;
  };
  systemPrompt: {
    section(entry: { name: string; order: number; text: (context: any) => string }): void;
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
  /** push-only 语言服务器（TS/JS）的诊断等待上限（毫秒）。默认按语言 5000。 */
  diagnosticWaitMs?: number;
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 LSP 客户端'),
  serverCommand: Schema.string().description('覆盖语言服务器命令（默认按语言：csharp-ls / 内置 typescript-language-server）'),
  serverArgs: Schema.array(Schema.string()).default([]).description('传递给 LSP server 的额外参数（覆盖时生效）'),
  workspaceRoot: Schema.string().description('可选 LSP 工作区根目录；未配置时按会话动态发现'),
  startupTimeoutMs: Schema.number().default(30000).description('initialize 握手超时（毫秒）'),
  autoStart: Schema.boolean().default(false).description('插件加载时自动启动 server'),
  logLevel: Schema.union(['off', 'error', 'warn', 'info', 'debug']).default('warn').description('日志级别'),
  diagnosticWaitMs: Schema.number().description('push-only 语言服务器（TS/JS）诊断等待上限（毫秒，默认按语言 5000）'),
});

/**
 * Cordis 插件入口函数。
 *
 * 1. 验证配置
 * 2. 创建 LspServerManager + LspClient
 * 3. 注册 LSP 提示词段到 systemPrompt.section
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

  // 语言注册表驱动：每语言描述符决定服务器启动方式（内置/外部）、env、格式默认值等。
  // 用户 serverCommand/serverArgs 仍可覆盖（兼容既有 C# 先例，且对全部语言生效）。
  const pool = new LspWorkspacePool((projectRoot, languageId: LanguageId) => {
    const { command, args } = resolveServerLaunch(
      languageId,
      config.serverCommand,
      config.serverArgs,
    );
    const serverManager = new LspServerManager({
      languageId,
      command,
      args,
      workspaceRoot: projectRoot,
      startupTimeoutMs: config.startupTimeoutMs ?? 30_000,
      diagnosticWaitMs: config.diagnosticWaitMs,
      logLevel: config.logLevel ?? 'warn',
      onStateChange: (state: LspServerState) => {
        ctx.logger.info(`[lsp-client] ${languageId}:${projectRoot} 服务器状态: ${state}`);
      },
      onLog: (level: string, message: string) => {
        if (level === 'error') ctx.logger.error(`[lsp-client] ${languageId}:${projectRoot} ${message}`);
        else if (level === 'warn') ctx.logger.warn(`[lsp-client] ${languageId}:${projectRoot} ${message}`);
        else ctx.logger.info(`[lsp-client] ${languageId}:${projectRoot} ${message}`);
      },
    });
    return { manager: serverManager, client: new LspClient(serverManager) };
  });

  /**
   * 文件 → 语言路由：
   * - 有 file_path：按扩展名路由（.cs → csharp；.ts/.tsx/.js/.jsx → typescript）。
   * - 无 file_path（如 lsp_workspace_diagnostics）：按会话 cwd 的项目标记探测；
   *   多语言同命中按注册顺序取默认（csharp），单语言命中取该语言，无标记回退默认。
   */
  const resolveLanguage = async (filePath: string | undefined, sessionCwd: string | undefined): Promise<LanguageId> => {
    if (filePath !== undefined) {
      const lang = languageOfFile(filePath);
      if (lang !== undefined) return lang;
    }
    if (sessionCwd !== undefined) {
      const detected = await detectProjectLanguages(sessionCwd);
      const langs = Object.keys(LANGUAGES) as LanguageId[];
      const hit = langs.filter((l) => detected[l] !== undefined);
      if (hit.length === 1) return hit[0]!;
    }
    return DEFAULT_LANGUAGE;
  };

  const resolveWorkspace = async (filePath: string | undefined, exec?: LspExecutionContext) => {
    const sessionId = exec?.agent?.id ?? 'anonymous';
    const sessionCwd = exec?.agent?.session?.header?.cwd;
    const languageId = await resolveLanguage(filePath, sessionCwd);
    const projectRoot = workspaceRootOverride ?? await resolveProjectRootFor(languageId, filePath, sessionCwd);
    if (projectRoot === undefined) {
      throw new Error('无法确定项目根目录（C# 或 TS/JS）：请从带 session cwd 的会话调用，或配置 workspaceRoot');
    }
    return pool.get(sessionId, languageId, projectRoot);
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

  ctx.logger.info(`[lsp-client] 已注册 ${tools.length} 个 LSP 工具（按语言路由：C# + TS/JS）`);

  // Agent 会话结束时释放该会话的全部语言服务器实例，避免 Roslyn/tsserver 进程泄漏。
  (ctx as any).on?.('agent/disposed', (payload: { agent: { id: string } }) => {
    void pool.disposeSession(payload.agent.id);
  });

  // ── tools/post-execute hook：编辑 .cs/.ts/.tsx/.js/.jsx 文件后自动注入诊断摘要 ──
  // 使用 DSH 推荐的 tools/post-execute（可附加 additionalContexts），替代旧 tools/result + steer。
  // 每次诊断按 session + language + projectRoot 选取对应实例，避免多项目串线。
  const codeFilePattern = /\.(cs|ts|tsx|js|jsx)$/i;
  const lspToolPattern = /^lsp_/;
  const diagnosticCooldown = new Map<string, number>();
  const DIAGNOSTIC_COOLDOWN_MS = 30_000;
  const lastDiagnosticFingerprints = new Map<string, string>();
  // push-only 服务器（TS/JS）编辑后诊断异步到达：内联先短等，拿不到再交后台补注。
  const INLINE_DIAGNOSTIC_WAIT_MS = 1_000;

  const extractEditedFilePath = (args: unknown): string | undefined => {
    const record = args as { file_path?: string; path?: string } | undefined;
    return record?.file_path ?? record?.path;
  };
  const fingerprintOf = (diags: { range: { start: { line: number } }; code?: string; message: string }[]): string =>
    diags.map((d) => `${d.range.start.line}:${d.code ?? ''}:${d.message}`).join('|');
  const diagnosticHint = (errors: { range: { start: { line: number } }; code?: string; message: string }[]): string => {
    const summary = errors.slice(0, 5).map(
      (d) => `  行${d.range.start.line + 1}: ${d.code ? `[${d.code}] ` : ''}${d.message}`,
    ).join('\n');
    return `[lsp] 编辑后发现 ${errors.length} 个编译错误：\n${summary}\n使用 lsp_diagnostics + lsp_code_action 验证和修复。`;
  };
  const createDiagnosticMessage = (hint: string) =>
    createUserMessage({
      content: [{ type: 'text', text: hint }],
      source: { kind: 'plugin', plugin: 'lsp-client' },
    });

  try {
    (ctx as any).on?.('tools/post-execute', async (exec: any, result: any, next: any) => {
      try {
        const toolName = exec?.name as string | undefined;
        if (!toolName || lspToolPattern.test(toolName)) return next();
        // 只处理成功的编辑/写入工具结果
        if (result?.isError !== false) return next();

        const filePath = extractEditedFilePath(exec?.arguments);
        if (!filePath || !codeFilePattern.test(filePath)) return next();

        const execution = exec as LspExecutionContext;
        const sessionId = execution.agent?.id ?? 'anonymous';
        const now = Date.now();
        const cooldownKey = `${sessionId}\0${filePath}`;
        const lastInjection = diagnosticCooldown.get(cooldownKey) ?? 0;
        if (now - lastInjection < DIAGNOSTIC_COOLDOWN_MS) return next();
        diagnosticCooldown.set(cooldownKey, now);

        const { manager, client } = await resolveWorkspace(filePath, execution);
        await manager.start();

        // 内联短等待：常见快路径直接附加到本次工具结果（C# pull 立即返回）
        const diags = await client.diagnostics(filePath, { waitMs: INLINE_DIAGNOSTIC_WAIT_MS });
        const errors = diags.filter((d) => d.severity === 'error');
        if (errors.length > 0) {
          const fingerprint = fingerprintOf(errors);
          if (fingerprint !== lastDiagnosticFingerprints.get(cooldownKey)) {
            lastDiagnosticFingerprints.set(cooldownKey, fingerprint);
            const hint = diagnosticHint(errors);
            ctx.logger.info(`[lsp-client] 自动诊断注入: ${errors.length} 个错误 (${filePath.split(/[/\\]/).pop()})`);
            return { kind: 'accept', additionalContexts: [createDiagnosticMessage(hint)] };
          }
        }

        // push-only（TS/JS）内联未拿到新错误：启动晚到补注，不阻塞编辑结果返回。
        if (!manager.supportsPull) {
          void (async () => {
            try {
              const lateDiags = await client.diagnostics(filePath);
              const lateErrors = lateDiags.filter((d) => d.severity === 'error');
              if (lateErrors.length === 0) return;
              const lateFingerprint = fingerprintOf(lateErrors);
              if (lateFingerprint === lastDiagnosticFingerprints.get(cooldownKey)) return;
              lastDiagnosticFingerprints.set(cooldownKey, lateFingerprint);
              const hint = diagnosticHint(lateErrors);
              ctx.logger.info(`[lsp-client] 晚到诊断补注: ${lateErrors.length} 个错误 (${filePath.split(/[/\\]/).pop()})`);
              execution.agent?.inject?.(createDiagnosticMessage(hint));
            } catch {
              // 晚到补注失败不阻塞工具主流程。
            }
          })();
        }

        return next();
      } catch {
        // hook 执行异常不阻塞工具主流程。
        return next();
      }
    });
  } catch {
    // 非所有宿主版本都提供 tools/post-execute 事件。
  }

  if (config.autoStart && workspaceRootOverride) {
    // 自动启动：按 cwd 探测语言（同步版）；多语言命中取注册默认（csharp），无标记取默认。
    const detected = detectProjectLanguagesSync(workspaceRootOverride);
    const hit = (Object.keys(LANGUAGES) as LanguageId[]).filter((l) => detected[l] !== undefined);
    const languageId = hit.length === 1 ? hit[0]! : DEFAULT_LANGUAGE;
    const instance = pool.get('startup', languageId, workspaceRootOverride);
    instance.manager.start().catch((err) => {
      ctx.logger.error(`[lsp-client] 自动启动失败: ${err}`);
    });
  }

  ctx.effect(() => () => {
    void pool.dispose();
  }, 'lsp-client workspace pool');
}
