/**
 * LSP 服务器子进程生命周期管理。
 *
 * 职责：
 * - 启动 csharp-ls（或其他 LSP server）作为 stdio 子进程
 * - 通过 vscode-jsonrpc 建立 JSON-RPC 2.0 连接
 * - 执行 LSP initialize/initialized 握手
 * - 提供优雅关闭（shutdown → exit）
 * - 崩溃后自动重启（指数退避）
 *
 * @module @echocore/dsh-lsp-client/server-manager
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import {
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
  type Diagnostic,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import type { LspServerState } from './types.js';

/** 子进程重启策略常量。 */
const RESTART = {
  /** 首次重启延迟（毫秒）。 */
  INITIAL_DELAY_MS: 2000,
  /** 最大重启延迟（毫秒）。 */
  MAX_DELAY_MS: 30_000,
  /** 最大连续失败次数（超过后停止重试）。 */
  MAX_CONSECUTIVE_FAILURES: 5,
} as const;

/** LSP 服务器管理器配置。 */
export interface ServerManagerOptions {
  /** LSP server 可执行文件路径或命令名。默认 'csharp-ls'。 */
  readonly command: string;
  /** 传递给 LSP server 的额外参数。 */
  readonly args: readonly string[];
  /** LSP 工作区根目录。 */
  readonly workspaceRoot: string;
  /** initialize 握手超时（毫秒）。 */
  readonly startupTimeoutMs: number;
  /** 服务器日志级别。 */
  readonly logLevel: string;
  /** 状态变更回调。 */
  readonly onStateChange?: (state: LspServerState) => void;
  /** 日志回调。 */
  readonly onLog?: (level: string, message: string) => void;
}

/** 合法状态转换表：当前状态 → 允许的目标状态。 */
const VALID_TRANSITIONS: Record<LspServerState, readonly LspServerState[]> = {
  idle: ['starting', 'disposed'],
  starting: ['ready', 'error', 'disposed'],
  ready: ['error', 'disposed'],
  error: ['starting', 'disposed'],
  disposed: [], // 终态，不可转换
};

/**
 * 管理一个 LSP 服务器子进程的完整生命周期。
 *
 * 通过 JSON-RPC 2.0 over stdio 与 LSP server 通信。
 * 支持自动重启和指数退避。
 */
export class LspServerManager {
  private readonly options: ServerManagerOptions;
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private state: LspServerState = 'idle';
  private consecutiveFailures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private _capabilities: ServerCapabilities | null = null;
  private _serverInfo: { name: string; version?: string } | null = null;

  /** push 诊断缓存：uri → Diagnostic[]。由 textDocument/publishDiagnostics 通知更新。 */
  private _diagnosticsCache = new Map<string, Diagnostic[]>();

  constructor(options: ServerManagerOptions) {
    this.options = options;
  }

  /** 当前服务器状态。 */
  get currentState(): LspServerState {
    return this.state;
  }

  /** 服务器声明的 capabilities（initialize 后可用）。 */
  get serverCapabilities(): ServerCapabilities | null {
    return this._capabilities;
  }

  /** 服务器信息（name + version）。 */
  get serverInfo(): { name: string; version?: string } | null {
    return this._serverInfo;
  }

  /** 活跃的 JSON-RPC 连接（ready 状态后可用）。 */
  get activeConnection(): MessageConnection | null {
    return this.connection;
  }

  /** 获取指定 URI 的 push 诊断缓存。 */
  getDiagnostics(uri: string): Diagnostic[] {
    return this._diagnosticsCache.get(uri) ?? [];
  }

  /** 获取所有缓存的诊断（按 URI 分组）。用于 workspaceDiagnostics。 */
  getAllDiagnostics(): { uri: string; diagnostics: Diagnostic[] }[] {
    return [...this._diagnosticsCache.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
  }

  /**
   * 启动 LSP 服务器并完成 initialize 握手。
   *
   * 如果服务器已在运行，返回已有连接。
   * 如果正在启动中，返回已有的启动 Promise。
   */
  async start(): Promise<MessageConnection> {
    if (this.state === 'ready' && this.connection) {
      return this.connection;
    }

    if (this.state === 'starting' && this._pendingStart) {
      return this._pendingStart;
    }

    this._pendingStart = this._doStart();
    return this._pendingStart;
  }

  private _pendingStart: Promise<MessageConnection> | null = null;

  /** 内部启动流程。 */
  private async _doStart(): Promise<MessageConnection> {
    this.setState('starting');
    this.log('info', `启动 LSP 服务器: ${this.options.command} ${this.options.args.join(' ')}`);

    try {
      await this.spawnProcess();
      await this.initializeHandshake();
      this.consecutiveFailures = 0;
      this.setState('ready');
      this.log('info', `LSP 服务器就绪: ${this._serverInfo?.name ?? 'unknown'}`);
      return this.connection!;
    } catch (err) {
      this.consecutiveFailures++;
      this.setState('error');
      this.log('error', `LSP 服务器启动失败 (${this.consecutiveFailures}/${RESTART.MAX_CONSECUTIVE_FAILURES}): ${err}`);
      this.cleanupProcess();
      throw err;
    } finally {
      this._pendingStart = null;
    }
  }

  /** 启动子进程并建立 JSON-RPC 连接。 */
  private spawnProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
      // Windows 上 .NET 全局工具是 .cmd 文件，需要 shell 解析才能找到。
      // 使用 shell: true 仅在 Windows 上，避免 DEP0190 警告的安全影响
      // （此处 command 来自用户配置的白名单，非任意输入）。
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        shell: process.platform === 'win32',
      });

      child.on('error', (err) => {
        this.log('error', `子进程错误: ${err.message}`);
        reject(new Error(`无法启动 LSP 服务器 '${this.options.command}': ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        this.log('warn', `子进程退出: code=${code}, signal=${signal}`);
        if (this.state === 'starting') {
          reject(new Error(`LSP 服务器在初始化前退出 (code=${code})`));
        } else if (this.state === 'ready') {
          // 运行中崩溃 → 触发重启
          this.setState('error');
          this.cleanupProcess();
          this.scheduleRestart();
        }
      });

      if (!child.stdin || !child.stdout) {
        reject(new Error('子进程缺少 stdin/stdout'));
        child.kill();
        return;
      }

      // stderr 仅用于日志，不阻塞
      if (child.stderr) {
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (data: string) => {
          this.log('debug', `[server stderr] ${data.trimEnd()}`);
        });
      }

      // 建立 JSON-RPC 连接（vscode-jsonrpc/node.js 接受 Node.js Readable/Writable）
      const connection = createMessageConnection(
        child.stdout as any,
        child.stdin as any,
      );

      this.process = child;
      this.connection = connection;

      // 连接关闭监听
      connection.onClose(() => {
        this.log('warn', 'JSON-RPC 连接关闭');
        if (this.state === 'ready') {
          this.setState('error');
          this.cleanupProcess();
          this.scheduleRestart();
        }
      });

      connection.onError((err) => {
        this.log('error', `JSON-RPC 连接错误: ${err}`);
      });

      // 监听 push 诊断通知（csharp-ls 默认推送模式），
      // 缓存到 _diagnosticsCache 供 LspClient.diagnostics() 读取。
      connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
        this._diagnosticsCache.set(params.uri, params.diagnostics);
      });

      // 必须在 initialize 请求前启动 JSON-RPC 读取循环；否则真实连接会抛出
      // "Call listen() first"，集成测试若直接自建 connection 无法覆盖此生产装配路径。
      connection.listen();

      resolve();
    });
  }

  /** 执行 LSP initialize/initialized 握手。 */
  private async initializeHandshake(): Promise<void> {
    if (!this.connection) {
      throw new Error('无活跃的 JSON-RPC 连接');
    }

    const params: InitializeParams = {
      processId: process.pid,
      rootUri: `file:///${this.options.workspaceRoot.replace(/\\/g, '/')}`,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
          // 声明 pull 诊断能力（LSP 3.17+），让 csharp-ls 启用 pull 模式
          diagnostic: { dynamicRegistration: false },
          // 声明 codeAction 能力，支持 quickfix + refactor + organizeImports
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ['quickfix', 'refactor', 'source', 'source.organizeImports'] },
            },
          },
          // 智能补全（IntelliSense）
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
          // 方法签名提示
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
          // 文档格式化 + 范围格式化
          formatting: {},
          rangeFormatting: {},
          // 重命名
          rename: { prepareSupport: true },
          // 跳转到实现
          implementation: { linkSupport: true },
        },
        workspace: {
          didChangeConfiguration: { dynamicRegistration: false },
        },
        window: {},
      },
      initializationOptions: {},
    };

    // initialize 请求，带超时
    const result = await Promise.race([
      this.connection.sendRequest('initialize', params) as Promise<InitializeResult>,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`initialize 握手超时 (${this.options.startupTimeoutMs}ms)`)),
          this.options.startupTimeoutMs,
        ),
      ),
    ]);

    this._capabilities = result.capabilities;
    this._serverInfo = result.serverInfo ?? null;

    // initialized 通知（无需等待响应）
    this.connection.sendNotification('initialized', {});
  }

  /** 优雅关闭 LSP 服务器。 */
  async dispose(): Promise<void> {
    // 取消待定的重启
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.connection) {
      try {
        // shutdown 请求
        await Promise.race([
          this.connection.sendRequest('shutdown'),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
        // exit 通知
        this.connection.sendNotification('exit');
      } catch {
        // 忽略关闭过程中的错误
      }
      this.connection.dispose();
      this.connection = null;
    }

    this.cleanupProcess();
    this.setState('disposed');
  }

  /** 清理子进程引用（终止子进程 + 移除监听器）。 */
  private cleanupProcess(): void {
    if (this.process) {
      this.process.removeAllListeners();
      // 终止子进程，防止资源泄漏
      try {
        this.process.kill();
      } catch {
        // 进程可能已退出，忽略 kill 错误
      }
      this.process = null;
    }
    this._capabilities = null;
    this._serverInfo = null;
    this._diagnosticsCache.clear();
  }

  /** 安排延迟重启（指数退避）。 */
  private scheduleRestart(): void {
    if (this.consecutiveFailures >= RESTART.MAX_CONSECUTIVE_FAILURES) {
      this.log('error', `连续失败 ${this.consecutiveFailures} 次，停止重启`);
      return;
    }

    const delay = Math.min(
      RESTART.INITIAL_DELAY_MS * Math.pow(2, this.consecutiveFailures),
      RESTART.MAX_DELAY_MS,
    );

    this.log('info', `将在 ${delay}ms 后尝试重启...`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch(() => {
        // 错误已在 _doStart 中记录
      });
    }, delay);
  }

  /** 设置状态并触发回调。 */
  private setState(state: LspServerState): void {
    if (this.state === state) return;

    // 验证状态转换合法性，防止非法转换（如 disposed → ready）
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(state)) {
      this.log('error', `非法状态转换: ${this.state} → ${state}，已忽略`);
      return;
    }

    this.state = state;
    this.options.onStateChange?.(state);
  }

  /** 记录日志。根据 options.logLevel 过滤日志输出。 */
  private log(level: string, message: string): void {
    // 日志级别优先级：off < error < warn < info < debug
    const levels = ['off', 'error', 'warn', 'info', 'debug'];
    const configured = levels.indexOf(this.options.logLevel);
    const current = levels.indexOf(level);

    // 如果配置为 'off' 或级别未识别，不输出任何日志
    if (configured <= 0 || current < 0) {
      return;
    }

    // 只输出不高于配置级别的日志（数值越大级别越高）
    // 例如：配置 'warn'，则 'warn' 和 'error' 可输出，'info' 和 'debug' 不输出
    if (current <= configured) {
      this.options.onLog?.(level, message);
    }
  }
}
