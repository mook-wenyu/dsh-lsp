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
  type ConfigurationParams,
} from 'vscode-languageserver-protocol';
import { LANGUAGES, type LanguageId } from './languages.js';
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

/**
 * 规范化 URI，用于诊断缓存键与 pull 请求。
 *
 * 两重归一（缺一即键失配，2026-08-25 集成实测）：
 * 1. 解码百分号转义：typescript-language-server(tsserver) 推送的 URI 会把盘符
 *    冒号编码为 %3A（file:///d%3A/...），本客户端查询/缓存键是未经编码的
 *    file:///d:/...，若不解码则 publishDiagnostics 永远写不进缓存（push 诊断恒空）。
 * 2. Windows 统一小写盘符（file:///D:/x → file:///d:/x）：csharp-ls 按客户端传入的
 *    URI 原样登记文档，盘符大小写不一致时 pull 请求会失配返回空诊断。
 * 全链路统一走归一化 URI 可消除这两类失配。
 */
export function normalizeUri(uri: string): string {
  try {
    const u = new URL(uri);
    // 百分号解码全平台生效（tsserver 编码盘符冒号为 %3A 等）；盘符小写仅 Windows
    //（Linux 上 /C:/ 是大小写敏感合法路径，不得改写）
    u.pathname = decodeURIComponent(u.pathname);
    if (process.platform === 'win32') {
      u.pathname = u.pathname.replace(/^\/([a-zA-Z]):/, (_m, d: string) => `/${d.toLowerCase()}:`);
    }
    return u.toString();
  } catch {
    return uri
      .replace(/%3a/gi, ':')
      .replace(/^file:\/\/([a-zA-Z]):/, (_m, d: string) => `file:///${d.toLowerCase()}:`);
  }
}

/** LSP 服务器管理器配置。 */
export interface ServerManagerOptions {
  /** 语言 id（决定 env/initOptions/格式默认值等语言差异）。默认 'csharp'（兼容旧调用）。 */
  readonly languageId?: LanguageId;
  /** LSP server 可执行文件路径或命令名。默认 'csharp-ls'。 */
  readonly command: string;
  /** 传递给 LSP server 的额外参数。 */
  readonly args: readonly string[];
  /** LSP 工作区根目录。 */
  readonly workspaceRoot: string;
  /** initialize 握手超时（毫秒）。 */
  readonly startupTimeoutMs: number;
  /** push 诊断等待上限（ms）覆盖；缺省按语言描述符默认（TS/JS 5000）。 */
  readonly diagnosticWaitMs?: number;
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
  /** 服务器是否支持 pull 诊断（LSP 3.17 textDocument/diagnostic）。csharp-ls 0.26 支持。 */
  private _supportsPull = false;
  /** 服务器是否支持工作区级 pull 诊断（workspace/diagnostic）。 */
  private _supportsWorkspaceDiagnostic = false;

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

  /** 服务器是否支持 pull 诊断（textDocument/diagnostic）。 */
  get supportsPull(): boolean {
    return this._supportsPull;
  }

  /** 服务器是否支持工作区级 pull 诊断（workspace/diagnostic）。 */
  get supportsWorkspaceDiagnostic(): boolean {
    return this._supportsWorkspaceDiagnostic;
  }

  /** 活跃的 JSON-RPC 连接（ready 状态后可用）。 */
  get activeConnection(): MessageConnection | null {
    return this.connection;
  }

  /** 本实例的语言 id（默认 csharp，兼容未传入的旧调用）。 */
  get languageId(): LanguageId {
    return this.options.languageId ?? 'csharp';
  }

  /** 该语言的格式化默认值（lsp_format 请求参数 + workspace/configuration 应答）。 */
  get formatDefaults(): { tabSize: number; insertSpaces: boolean } {
    return LANGUAGES[this.languageId].formatDefaults;
  }

  /** 该语言 push 诊断等待上限（ms；pull 服务器为 0；可用诊断等待配置覆盖）。 */
  get diagnosticWatchMs(): number {
    return this.options.diagnosticWaitMs ?? LANGUAGES[this.languageId].diagnosticWatchMs;
  }

  /** 指定 URI 是否已有诊断推送到达（与「空诊断」区分：推送空数组也算到达）。 */
  hasDiagnostics(uri: string): boolean {
    return this._diagnosticsCache.has(normalizeUri(uri));
  }

  /** 获取指定 URI 的诊断缓存（键经归一化，消除大小写失配）。 */
  getDiagnostics(uri: string): Diagnostic[] {
    return this._diagnosticsCache.get(normalizeUri(uri)) ?? [];
  }

  /** 获取所有缓存的诊断（按 URI 分组）。用于 workspaceDiagnostics。 */
  getAllDiagnostics(): { uri: string; diagnostics: Diagnostic[] }[] {
    return [...this._diagnosticsCache.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
  }

  /**
   * 写入/更新指定 URI 的诊断缓存（键经归一化）。
   *
   * pull model（textDocument/diagnostic / workspace/diagnostic）结果由此进入统一缓存——
   * csharp-ls 主用 pull 时 push 通知几乎不发生，旧实现两通路割裂导致 workspaceDiagnostics
   * 恒空（Bug G，2026-08-24 真实项目实测）。pull 成功结果写入统一缓存同样成立。
   */
  updateDiagnosticsCache(uri: string, diagnostics: Diagnostic[]): void {
    this._diagnosticsCache.set(normalizeUri(uri), diagnostics);
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
      // 语言特定 env（C#：关遥测；TS/JS：无附加项）
      const env = { ...process.env, ...LANGUAGES[this.languageId].extraEnv };
      // shell 需求按语言声明：外部 .cmd shim（csharp-ls）在 Windows 需 shell 解析；
      // bundled 语言（node 绝对路径）严禁 shell——shell:true 只做空格拼接不转义，
      // 路径含空格会被 cmd 拆炸（'D:\Program' is not recognized 实测定案）。
      const needShell = LANGUAGES[this.languageId].useShell ?? false;
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        shell: needShell && process.platform === 'win32',
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

      // 监听 push 诊断通知（pull-only 服务器的兜底通道；csharp-ls 声明 pull 能力后
      // 不再推送，此时缓存恒空，诊断改由 pull 请求获取）。
      // 键经归一化，避免服务器推送 URI 与查询 URI 大小写不一致导致缓存失配。
      connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
        this._diagnosticsCache.set(normalizeUri(params.uri), params.diagnostics);
      });

      // 必须在 initialize 请求前启动 JSON-RPC 读取循环；否则真实连接会抛出
      // "Call listen() first"，集成测试若直接自建 connection 无法覆盖此生产装配路径。
      connection.listen();

      // 处理 server→client 请求（部分服务器依赖客户端应答，缺 handler 会回 MethodNotFound）：
      // 1. workspace/configuration（typescript-language-server 5.1+ 按文件请求
      //    formattingOptions 的 tabSize/insertSpaces，用于格式化/整理导入等编辑）；
      //    按该语言 formatDefaults 应答；未知 section 返回 null。
      // 2. window/workDoneProgress/create：客户端未声明 progress 能力，不会收到；
      //    注册 null 应答仅为防御，避免意外请求导致返回方法未找到。
      connection.onRequest('workspace/configuration', (params: ConfigurationParams | null) => {
        const items = params?.items;
        if (!items) return null;
        return items.map((item) => {
          if (item?.section === 'formattingOptions') {
            const f = this.formatDefaults;
            return { tabSize: f.tabSize, insertSpaces: f.insertSpaces };
          }
          return null;
        });
      });
      connection.onRequest('window/workDoneProgress/create', () => null);

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
          // 调用层级：声明客户端能力——typescript-language-server 按客户端声明
          // 选择性注册处理器（不声明则返回 Method not found）
          callHierarchy: {},
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
      initializationOptions: LANGUAGES[this.languageId].initializationOptions ?? {},
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

    // 探测服务器诊断能力（LSP 3.17）：决定 diagnostics()/workspaceDiagnostics() 走 pull 还是 push。
    // csharp-ls 0.26 声明 diagnosticProvider 且 workspaceDiagnostics=true。
    const caps = result.capabilities as ServerCapabilities & {
      diagnosticProvider?: boolean | { workspaceDiagnostics?: boolean };
    };
    this._supportsPull = !!(
      caps?.diagnosticProvider || (caps as any)?.textDocument?.diagnostic
    );
    this._supportsWorkspaceDiagnostic = !!(
      caps?.diagnosticProvider &&
      (caps.diagnosticProvider === true || (caps.diagnosticProvider as any)?.workspaceDiagnostics)
    );

    // initialized 通知（无需等待响应）。fire-and-forget 写入失败（如流已销毁）
    // 必须吞掉，否则成为未处理拒绝使宿主进程崩溃。
    this.connection.sendNotification('initialized', {}).catch(() => {});
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
        // exit 通知（fire-and-forget，但写入失败绝不能变成未处理拒绝使宿主崩溃）
        this.connection.sendNotification('exit').catch(() => {});
      } catch {
        // 忽略关闭过程中的错误
      }
      // connection.dispose() 在死流上也可能抛，必须就地吞掉
      try {
        this.connection.dispose();
      } catch {
        // 连接可能已部分销毁
      }
      this.connection = null;
    }

    this.cleanupProcess();
    this.setState('disposed');
  }

  /** 清理子进程引用（终止子进程 + 移除监听器 + 废弃连接）。 */
  private cleanupProcess(): void {
    // 子进程已死，其 stdin/stdout 流随之销毁；若保留 this.connection 引用，
    // 后续 sendRequest/sendNotification 会写入已销毁流并抛出 ERR_STREAM_DESTROYED，
    // 该拒绝一旦未被处理即终止宿主进程（"fatal load failure"）。
    // 此处显式废弃连接：activeConnection 返回 null → LspClient.connection getter
    // 抛干净的"未就绪"错误，而非写入死流。
    if (this.connection) {
      try {
        this.connection.dispose();
      } catch {
        // 连接可能已部分销毁
      }
      this.connection = null;
    }

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

    // 幂等：exit 与 onClose 都会触发重启，避免重复定时器拉起多个 csharp-ls
    if (this.restartTimer !== null) return;

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
