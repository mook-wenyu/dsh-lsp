/**
 * LSP 客户端封装：将 vscode-jsonrpc 连接映射为语义化方法调用。
 *
 * 每次请求前自动同步文件内容（didOpen/didChange），
 * 返回精简的结构化结果以减少 token 消耗。
 *
 * @module @echocore/dsh-lsp-client/lsp-client
 */

import { readFileSync } from 'node:fs';
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  type Hover,
  type Location,
  type LocationLink,
  type DocumentSymbol,
  type Diagnostic,
  type CodeAction,
  type CodeActionContext,
  type CompletionItem,
  type CompletionList,
  type SignatureHelp,
  type TextEdit,
  type TextDocumentEdit,
  type WorkspaceEdit,
  type Location as ImplementationLocation,
  type DocumentFormattingParams,
  type DocumentRangeFormattingParams,
  type PublishDiagnosticsParams,
  type CallHierarchyIncomingCall,
  type CallHierarchyOutgoingCall,
  type CallHierarchyItem,
  DiagnosticSeverity,
  SymbolKind,
  InsertTextFormat,
  CompletionItemKind,
} from 'vscode-languageserver-protocol';
import type { LspServerManager } from './server-manager.js';
import { normalizeUri } from './server-manager.js';
import { lspLanguageIdOf } from './languages.js';
import type { LspLocation } from './types.js';

/** 符号类型中文映射，用于紧凑展示。 */
const SYMBOL_KIND_MAP: Record<number, string> = {
  [SymbolKind.File]: '文件',
  [SymbolKind.Module]: '模块',
  [SymbolKind.Namespace]: '命名空间',
  [SymbolKind.Package]: '包',
  [SymbolKind.Class]: '类',
  [SymbolKind.Method]: '方法',
  [SymbolKind.Property]: '属性',
  [SymbolKind.Field]: '字段',
  [SymbolKind.Constructor]: '构造函数',
  [SymbolKind.Enum]: '枚举',
  [SymbolKind.Interface]: '接口',
  [SymbolKind.Function]: '函数',
  [SymbolKind.Variable]: '变量',
  [SymbolKind.Constant]: '常量',
  [SymbolKind.String]: '字符串',
  [SymbolKind.Number]: '数字',
  [SymbolKind.Boolean]: '布尔',
  [SymbolKind.Array]: '数组',
  [SymbolKind.Object]: '对象',
  [SymbolKind.Key]: '键',
  [SymbolKind.Null]: 'null',
  [SymbolKind.EnumMember]: '枚举成员',
  [SymbolKind.Struct]: '结构体',
  [SymbolKind.Event]: '事件',
  [SymbolKind.Operator]: '运算符',
  [SymbolKind.TypeParameter]: '类型参数',
};

/**
 * LSP 客户端：封装 6 个核心 LSP 操作为语义化方法。
 *
 * 依赖 LspServerManager 提供的活跃连接，
 * 每次请求前自动同步文件内容。
 */
export class LspClient {
  constructor(private readonly manager: LspServerManager) {}

  /** 文件同步缓存：filePath → { version, text }，避免重复 didOpen 违反 LSP 协议。 */
  private readonly fileCache = new Map<string, { version: number; text: string }>();

  /** 标记 pull 诊断失败的真实错误是否已记录一次，避免重复警告日志。 */
  private _diagnosticsPullLogged = false;

  /** 获取活跃连接，未就绪时抛出。 */
  private get connection(): MessageConnection {
    const conn = this.manager.activeConnection;
    if (!conn) {
      throw new Error('LSP 服务器未就绪，请先调用 serverManager.start()');
    }
    return conn;
  }

  /**
   * 宿主输出契约执行点：execute 返回值必须是无损 JSON
   * （含 undefined 值的键、NaN 等都会被宿主以 "not lossless JSON" 拒绝）。
   * LSP 可选字段缺失时对象字面量会携带 key: undefined，此处统一经
   * JSON round-trip 剥离。领域对象均为纯数据，round-trip 无损。
   * 仅需应用于含可选字段的构造出口；全必填形状无需包裹。
   */
  private toJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /**
   * 同步文件内容到 LSP server。
   * 首次打开文件发送 didOpen，内容变化时发送 didChange。
   * 使用缓存避免重复发送相同的文件内容。
   * 返回是否实际发送了同步通知（didOpen/didChange），供诊断等待判定「新鲜度」。
   */
  private syncDocument(filePath: string): boolean {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch {
      // 文件不存在时发送空内容
      text = '';
    }

    const uri = this.toUri(filePath);
    const cached = this.fileCache.get(filePath);

    if (!cached) {
      // 首次打开：发送 didOpen 通知
      const version = 1;
      this.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: this.inferLanguageId(filePath),
          version,
          text,
        },
        // fire-and-forget：服务器崩溃后子进程 stdin 已销毁，写入会拒绝。
        // 未处理的拒绝会终止宿主进程（ERR_STREAM_DESTROYED / fatal load failure），
        // 必须就地吞掉；连接废弃后此处根本不会到达（getter 先抛"未就绪"）。
      }).catch(() => {});
      this.fileCache.set(filePath, { version, text });
      return true;
    } else if (cached.text !== text) {
      // 内容变化：发送 didChange 通知（增量更新）
      const newVersion = cached.version + 1;
      this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: newVersion },
        contentChanges: [{ text }],
        // 同 didOpen：写入失败必须吞掉，避免未处理拒绝使宿主崩溃
      }).catch(() => {});
      this.fileCache.set(filePath, { version: newVersion, text });
      return true;
    }
    // 内容未变化时跳过通知，避免不必要的网络开销
    return false;
  }

  /**
   * hover — 获取光标位置的类型信息和文档注释。
   */
  async hover(filePath: string, line: number, character: number): Promise<HoverResult> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/hover', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
    }) as Hover | null;

    if (!result) {
      return { found: false, summary: '未找到类型信息' };
    }

    // 将 MarkupContent | MarkedString | MarkedString[] 统一提取为纯文本
    let content: string;
    if (typeof result.contents === 'string') {
      content = result.contents;
    } else if (Array.isArray(result.contents)) {
      content = result.contents
        .map((c) => (typeof c === 'string' ? c : c.value))
        .join('\n');
    } else {
      content = result.contents.value ?? '';
    }

    // range 无消费方（render/模型只用 found+summary），且 LSP range 可选——
    // 携带 undefined 会违反宿主无损 JSON 契约，故不返回。
    return this.toJson({ found: true, summary: content.trim() });
  }

  /**
   * definition — 跳转到符号定义位置。
   */
  async definition(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/definition', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
    }) as Location | Location[] | LocationLink[] | null;

    if (!result) return [];

    // 统一转换为 LspLocation[]
    const items = Array.isArray(result) ? result : [result];
    return items.map((item) => {
      if ('targetUri' in item) {
        // LocationLink
        return {
          filePath: this.fromUri(item.targetUri),
          range: item.targetRange,
        };
      }
      return {
        filePath: this.fromUri(item.uri),
        range: item.range,
      };
    });
  }

  /**
   * references — 查找符号的所有引用位置。
   */
  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<LspLocation[]> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/references', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
      context: { includeDeclaration },
    }) as Location[] | null;

    if (!result) return [];

    return result.map((loc) => ({
      filePath: this.fromUri(loc.uri),
      range: loc.range,
    }));
  }

  /**
   * diagnostics — 获取文件的编译诊断信息。
   *
   * 优先级：pull model（LSP 3.17+）> push 缓存（server-manager 缓存）。
   * csharp-ls 同时支持 push 和 pull；pull 返回更完整的诊断集。
   */
  async diagnostics(filePath: string): Promise<DiagnosticResult[]> {
    const fresh = this.syncDocument(filePath);
    const uri = normalizeUri(this.toUri(filePath));

    // csharp-ls 等支持 pull 的服务器：pull 是唯一权威诊断通道
    // （声明 pull 能力后服务器不再 push，原 push 缓存恒空，回退无意义）。
    if (this.manager.supportsPull) {
      try {
        const result = await this.connection.sendRequest('textDocument/diagnostic', {
          textDocument: { uri },
        }) as { kind: 'full'; items: Diagnostic[] } | null;

        if (result && 'items' in result) {
          // pull 结果写入统一诊断缓存（Bug G 回归）：workspaceDiagnostics 聚合
          // 所有已探明文件；干净文件写入空数组同样成立。
          this.manager.updateDiagnosticsCache(uri, result.items);
          return result.items.map((d) => this.formatDiagnostic(d));
        }
        // 返回空报告（kind:'full' 但无 items）
        return [];
      } catch (err) {
        // pull 抛错（项目未加载 / 连接未就绪 / URI 失配等）：记录真实错误，
        // 回退到 push 缓存（对 csharp-ls 恒空，对 pull-only 服务器才有效）。
        if (!this._diagnosticsPullLogged) {
          this._diagnosticsPullLogged = true;
          const code = (err as { code?: unknown })?.code;
          const msg = (err as { message?: string })?.message ?? String(err);
          console.warn(
            `[dsh-lsp-client] textDocument/diagnostic 失败（pull 为主，不再回退空 push 缓存）: code=${code ?? '?'} ${msg}`,
          );
        }
        return this.manager.getDiagnostics(uri).map((d) => this.formatDiagnostic(d));
      }
    }

    // 非 pull（push-only）服务器（typescript-language-server 等）：
    // didOpen/didChange 后诊断由服务器异步 publishDiagnostics 推送——
    // 立即读缓存必得空（推送未到）；且 tsserver 首推常为空（项目加载中），
    // 需等「首推 + 稳定窗口」再读缓存（详见 waitForPushDiagnostics）。
    return await this.waitForPushDiagnostics(uri, fresh);
  }

  /** push 诊断稳定窗口（ms）：首推到达后再等一小段，等待项目加载后的真实重推。 */
  private static readonly PUSH_SETTLE_MS = 300;

  /**
   * push-only 路径：等待该 URI 的诊断推送并按需稳定。
   *
   * - fresh=false（本次未发 didOpen/didChange）：缓存已有内容直接读回；
   * - fresh=true（刚同步或首次）：等待首个推送到达；此后每次缓存内容变化
   *   （tsserver 冷启动时序为「空推送(项目加载中) → 就绪后重推真实诊断」）
   *   重置计时，直到内容连续稳定 PUSH_SETTLE_MS 才返回；
   * - 全程不超过语言 diagnosticWatchMs；超时返回当前缓存（可能为空），不抛错。
   */
  private async waitForPushDiagnostics(uri: string, fresh: boolean): Promise<DiagnosticResult[]> {
    const deadline = Date.now() + this.manager.diagnosticWatchMs;
    let lastContent: string | null = null;
    let lastChangeAt = fresh ? -1 : 0; // 非新同步：立即满足稳定条件
    while (true) {
      if (this.manager.hasDiagnostics(uri)) {
        const content = JSON.stringify(this.manager.getDiagnostics(uri));
        if (content !== lastContent) {
          lastContent = content;
          lastChangeAt = Date.now();
        }
        if (Date.now() - lastChangeAt >= LspClient.PUSH_SETTLE_MS) break;
      }
      if (Date.now() >= deadline) break;
      await this.sleep(100);
    }
    return this.manager.getDiagnostics(uri).map((d) => this.formatDiagnostic(d));
  }

  /** 可注入的休眠（单元测试可用 fake timers 控制）。 */
  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  /**
   * documentSymbols — 获取文件内所有符号。
   */
  async documentSymbols(filePath: string): Promise<DocumentSymbolResult[]> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri: this.toUri(filePath) },
    }) as DocumentSymbol[] | null;

    if (!result) return [];

    return result.map((sym) => this.formatDocumentSymbol(sym, 0));
  }

  // ─── codeAction: 获取代码修复建议 ──────────────────────────────

  /**
   * codeAction — 获取指定范围的代码修复建议（quickfix / refactor）。
   *
   * 向 csharp-ls 发送 textDocument/codeAction 请求，
   * 返回可用的修复操作列表（含 WorkspaceEdit）。
   */
  async codeAction(
    filePath: string,
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
    diagnostics: DiagnosticResult[],
    only?: string[],
  ): Promise<CodeActionResult[]> {
    this.syncDocument(filePath);

    // 将 DiagnosticResult[] 转回 LSP Diagnostic 格式（codeAction 需要）
    const severityMap: Record<string, number> = {
      error: DiagnosticSeverity.Error,
      warning: DiagnosticSeverity.Warning,
      information: DiagnosticSeverity.Information,
      hint: DiagnosticSeverity.Hint,
    };
    const lspDiagnostics: Diagnostic[] = diagnostics.map((d) => ({
      severity: (severityMap[d.severity] ?? DiagnosticSeverity.Information) as DiagnosticSeverity,
      message: d.message,
      range: d.range,
      source: d.source,
      code: d.code,
      data: d.data,
    }));

    const context: CodeActionContext = {
      diagnostics: lspDiagnostics,
      only: only as any,
    };

    const result = await this.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri: this.toUri(filePath) },
      range,
      context,
    }) as CodeAction[] | null;

    if (!result) return [];

    return this.toJson(
      result.map((action) => ({
        title: action.title,
        kind: action.kind ?? undefined,
        isPreferred: action.isPreferred ?? false,
        // 提取 WorkspaceEdit 中的所有文件编辑（changes + documentChanges 双形态兼容）
        edits: action.edit ? this.collectFileEdits(action.edit) : [],
      })),
    );
  }

  /**
   * WorkspaceEdit → 扁平文件编辑列表。兼容两种形态：
   * - changes: Record<uri, TextEdit[]>
   * - documentChanges: TextDocumentEdit[]（resource 变更 CreateFile/RenameFile/DeleteFile 跳过）
   * typescript-language-server 的 codeAction/rename 可能返回 documentChanges 形态，
   * csharp-ls（Roslyn）用 changes——归一后上层无需区分。
   */
  private collectFileEdits(edit: WorkspaceEdit): { filePath: string; range: TextEdit['range']; newText: string }[] {
    const out: { filePath: string; range: TextEdit['range']; newText: string }[] = [];
    for (const [uri, textEdits] of Object.entries(edit.changes ?? {})) {
      for (const te of textEdits as TextEdit[]) {
        out.push({ filePath: this.fromUri(uri), range: te.range, newText: te.newText });
      }
    }
    for (const docChange of edit.documentChanges ?? []) {
      // TextDocumentEdit 才有 textDocument+edits；CreateFile/RenameFile/DeleteFile 跳过
      if ('textDocument' in docChange && 'edits' in docChange) {
        const tde = docChange as TextDocumentEdit;
        if ('uri' in tde.textDocument && Array.isArray(tde.edits)) {
          for (const te of tde.edits as TextEdit[]) {
            out.push({ filePath: this.fromUri(tde.textDocument.uri), range: te.range, newText: te.newText });
          }
        }
      }
    }
    return out;
  }

  // ─── callHierarchy: 调用层级 ──────────────────────────────────────

  /**
   * callHierarchy — 获取符号的调用层级（入调用 + 出调用）。
   */
  async callHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<CallHierarchyResult> {
    this.syncDocument(filePath);

    // 第一步：prepare → 获取 CallHierarchyItem
    const items = await this.connection.sendRequest('callHierarchy/prepareCallHierarchy', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
    }) as CallHierarchyItem[] | null;

    if (!items || items.length === 0) {
      return { incoming: [], outgoing: [] };
    }

    // 取第一个匹配的 CallHierarchyItem
    const item = items[0]!;

    // 第二步：并行获取 incoming + outgoing
    const [incoming, outgoing] = await Promise.all([
      this.connection.sendRequest('callHierarchy/incomingCalls', { item }) as Promise<
        CallHierarchyIncomingCall[] | null
      >,
      this.connection.sendRequest('callHierarchy/outgoingCalls', { item }) as Promise<
        CallHierarchyOutgoingCall[] | null
      >,
    ]);

    return {
      incoming: (incoming ?? []).map((call) => ({
        from: this.formatCallHierarchyItem(call.from),
        ranges: call.fromRanges,
      })),
      outgoing: (outgoing ?? []).map((call) => ({
        to: this.formatCallHierarchyItem(call.to),
        ranges: call.fromRanges,
      })),
    };
  }

  // ─── completion: 智能补全 ──────────────────────────────────

  /**
   * completion — 获取光标位置的智能补全建议（IntelliSense）。
   *
   * 返回补全项列表，含插入文本、类型、文档等。
   * 用于 agent 在编写代码时获取上下文感知的补全。
   */
  async completion(filePath: string, line: number, character: number): Promise<CompletionResult[]> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/completion', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
    }) as CompletionItem[] | CompletionList | null;

    if (!result) return [];

    // CompletionList 或 CompletionItem[] 统一处理
    const items = Array.isArray(result) ? result : result.items;
    return this.toJson(
      items.slice(0, 30).map((item) => ({
        label: item.label,
        kind: this.completionItemKindName(item.kind),
        detail: item.detail,
        documentation: typeof item.documentation === 'string'
          ? item.documentation
          : item.documentation?.value,
        insertText: typeof item.insertText === 'string' ? item.insertText : undefined,
      })),
    );
  }

  // ─── signature: 方法签名提示 ──────────────────────────────

  /**
   * signatureHelp — 获取方法参数签名信息。
   *
   * 返回当前活跃参数的签名文档和参数列表。
   * 用于 agent 调用方法时了解参数类型和说明。
   */
  async signatureHelp(filePath: string, line: number, character: number): Promise<SignatureResult | null> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/signatureHelp', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
    }) as SignatureHelp | null;

    if (!result || result.signatures.length === 0) return null;

    const sig = result.signatures[result.activeSignature ?? 0]!;
    return this.toJson({
      label: sig.label,
      documentation: typeof sig.documentation === 'string'
        ? sig.documentation
        : sig.documentation?.value,
      parameters: sig.parameters?.map((p) => ({
        label: typeof p.label === 'string' ? p.label : sig.label.slice(p.label[0], p.label[1]),
        documentation: typeof p.documentation === 'string'
          ? p.documentation
          : p.documentation?.value,
      })) ?? [],
      activeParameter: result.activeParameter ?? 0,
    });
  }

  // ─── format: 文档格式化 ──────────────────────────────────

  /**
   * format — 格式化整个 C# 文件（或指定范围）。
   *
   * 返回 TextEdit[]，客户端应将这些编辑应用到文件。
   * 如果传入 range，则只格式化该范围。
   */
  async format(
    filePath: string,
    range?: { start: { line: number; character: number }; end: { line: number; character: number } },
  ): Promise<FormatEditResult[]> {
    this.syncDocument(filePath);
    const uri = this.toUri(filePath);
    // 格式化选项按语言默认值（C# 4/false；TS/JS 2/true），与 workspace/configuration 应答一致
    const options = { ...this.manager.formatDefaults };

    let result: TextEdit[] | null;
    if (range) {
      // 范围格式化
      result = await this.connection.sendRequest('textDocument/rangeFormatting', {
        textDocument: { uri },
        range,
        options,
      } as DocumentRangeFormattingParams) as TextEdit[] | null;
    } else {
      // 全文格式化
      result = await this.connection.sendRequest('textDocument/formatting', {
        textDocument: { uri },
        options,
      } as DocumentFormattingParams) as TextEdit[] | null;
    }

    if (!result) return [];
    return result.map((te) => ({
      range: te.range,
      newText: te.newText,
    }));
  }

  // ─── rename: 跨文件重命名 ──────────────────────────────

  /**
   * rename — 重命名符号并更新所有引用。
   *
   * 返回 WorkspaceEdit（包含所有需要修改的文件和位置）。
   * csharp-ls 使用 Roslyn 的 Renamer 实现跨文件重命名。
   */
  async rename(filePath: string, line: number, character: number, newName: string): Promise<RenameResult | null> {
    this.syncDocument(filePath);

    // 先检查是否可以重命名
    try {
      await this.connection.sendRequest('textDocument/prepareRename', {
        textDocument: { uri: this.toUri(filePath) },
        position: { line, character },
      });
    } catch {
      return null; // 无法重命名（元数据符号等）
    }

    const result = await this.connection.sendRequest('textDocument/rename', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
      newName,
    }) as WorkspaceEdit | null;

    if (!result?.changes && !result?.documentChanges) return null;

    // 统计影响范围（changes + documentChanges 双形态归一）
    const fileEdits: { filePath: string; edits: { range: any; newText: string }[] }[] = [];
    let totalEdits = 0;
    const collected = this.collectFileEdits(result);
    const byFile = new Map<string, { range: any; newText: string }[]>();
    for (const fe of collected) {
      const list = byFile.get(fe.filePath) ?? [];
      list.push(fe);
      byFile.set(fe.filePath, list);
      totalEdits++;
    }
    for (const [fp, edits] of byFile) {
      fileEdits.push({ filePath: fp, edits });
    }

    return this.toJson({ newName, affectedFiles: fileEdits.length, totalEdits, fileEdits });
  }

  // ─── implement: 跳转到实现 ──────────────────────────────

  /**
   * implementation — 查找接口/抽象方法的实现位置。
   *
   * 用于理解接口被哪些类实现、抽象方法被哪些子类重写。
   */
  async implementation(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/implementation', {
      textDocument: { uri: this.toUri(filePath) },
      position: { line, character },
    }) as Location | Location[] | LocationLink[] | null;

    if (!result) return [];

    const items = Array.isArray(result) ? result : [result];
    return items.map((item) => {
      if ('targetUri' in item) {
        return { filePath: this.fromUri(item.targetUri), range: item.targetRange };
      }
      return { filePath: this.fromUri(item.uri), range: item.range };
    });
  }

  // ─── organizeImports: 自动整理 using ──────────────────────

  /**
   * organizeImports — 自动组织和排序 using 语句。
   *
   * 通过 codeAction 的 source.organizeImports kind 实现。
   * 返回 TextEdit[] 供客户端应用。
   */
  async organizeImports(filePath: string): Promise<FormatEditResult[]> {
    this.syncDocument(filePath);
    const result = await this.connection.sendRequest('textDocument/codeAction', {
      textDocument: { uri: this.toUri(filePath) },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      context: {
        diagnostics: [],
        only: ['source.organizeImports'],
      },
    }) as CodeAction[] | null;

    if (!result || result.length === 0) return [];

    // 提取第一个 organizeImports 动作的编辑（changes + documentChanges 双形态归一）
    const action = result[0]!;
    if (!action.edit?.changes && !action.edit?.documentChanges) return [];

    return this.collectFileEdits(action.edit).map((fe) => ({
      range: fe.range,
      newText: fe.newText,
    }));
  }

  // ─── workspaceDiagnostics: 全局诊断 ──────────────────────

  /**
   * workspaceDiagnostics — 获取所有打开文件的诊断信息。
   *
   * 从 push 缓存中读取所有已知 URI 的诊断。
   * 用于全局代码健康概览。
   */
  async workspaceDiagnostics(): Promise<WorkspaceDiagnosticResult[]> {
    // 支持工作区 pull 的服务器：用 workspace/diagnostic 拉取全局诊断并刷新缓存，
    // 再统一从缓存聚合（与单文件 pull 共用归一化键，避免大小写失配）。
    // 对 csharp-ls：其声明 pull 能力后不 push，旧实现直接读 push 缓存会恒空（Bug G 同源）。
    if (this.manager.supportsWorkspaceDiagnostic) {
      try {
        const report = (await this.connection.sendRequest('workspace/diagnostic', {
          identifier: 'dsh-lsp-client',
        })) as
          | { items?: Array<{ uri?: string; kind?: string; diagnostics?: Diagnostic[] }>; relatedDocuments?: Record<string, { kind?: string; diagnostics?: Diagnostic[] }> }
          | null;

        for (const it of report?.items ?? []) {
          // 'unchanged' 项复用上一轮结果，不覆盖缓存
          if (it?.kind === 'unchanged' || !it?.uri) continue;
          this.manager.updateDiagnosticsCache(normalizeUri(it.uri), it.diagnostics ?? []);
        }
        const related = report?.relatedDocuments;
        if (related && typeof related === 'object') {
          for (const [u, rd] of Object.entries(related)) {
            if ((rd as { kind?: string })?.kind === 'unchanged') continue;
            const rdDiags = (rd as { diagnostics?: Diagnostic[] })?.diagnostics;
            if (Array.isArray(rdDiags)) this.manager.updateDiagnosticsCache(normalizeUri(u), rdDiags);
          }
        }
      } catch {
        // 拉取失败，回退已有缓存
      }
    }

    return this.manager.getAllDiagnostics().map(({ uri, diagnostics }) => ({
      filePath: this.fromUri(uri),
      // 箭头包装绑定 this——formatDiagnostic 依赖 this.toJson，
      // 未绑定的 map(this.formatDiagnostic) 在缓存非空时必炸（Bug G 连带修复）
      diagnostics: diagnostics.map((d) => this.formatDiagnostic(d)),
    }));
  }

  // ─── 辅助方法 ────────────────────────────────────────────

  /** 文件路径 → file:// URI（经归一化，Windows 小写盘符，消除大小写失配）。 */
  private toUri(filePath: string): string {
    return normalizeUri(`file:///${filePath.replace(/\\/g, '/')}`);
  }

  /** file:// URI → 文件路径。使用 URL 对象进行健壮解析。 */
  private fromUri(uri: string): string {
    // 标准 file:// URI 解析
    try {
      const url = new URL(uri);
      // Windows: /C:/path → C:\path
      let path = decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && path.startsWith('/')) {
        path = path.slice(1);
      }
      return path.replace(/\//g, '\\');
    } catch {
      // 回退到简单替换
      return uri
        .replace(/^file:\/\//, '')
        .replace(/^\/([A-Z]:)/, '$1') // Windows: /C: → C:
        .replace(/\//g, '\\');
    }
  }

  /** 从文件扩展名推断 LSP languageId（委托语言注册表，按实例语言路由）。 */
  private inferLanguageId(filePath: string): string {
    return lspLanguageIdOf(filePath, this.manager.languageId);
  }

  /** CompletionItemKind → 中文名映射。 */
  private completionItemKindName(kind?: number): string {
    if (kind == null) return '未知';
    const map: Record<number, string> = {
      [CompletionItemKind.Method]: '方法',
      [CompletionItemKind.Function]: '函数',
      [CompletionItemKind.Constructor]: '构造函数',
      [CompletionItemKind.Field]: '字段',
      [CompletionItemKind.Variable]: '变量',
      [CompletionItemKind.Class]: '类',
      [CompletionItemKind.Interface]: '接口',
      [CompletionItemKind.Module]: '模块',
      [CompletionItemKind.Property]: '属性',
      [CompletionItemKind.Unit]: '单位',
      [CompletionItemKind.Value]: '值',
      [CompletionItemKind.Enum]: '枚举',
      [CompletionItemKind.Keyword]: '关键字',
      [CompletionItemKind.Snippet]: '代码片段',
      [CompletionItemKind.Text]: '文本',
      [CompletionItemKind.Color]: '颜色',
      [CompletionItemKind.File]: '文件',
      [CompletionItemKind.Reference]: '引用',
      [CompletionItemKind.Struct]: '结构体',
      [CompletionItemKind.Event]: '事件',
      [CompletionItemKind.Operator]: '运算符',
      [CompletionItemKind.TypeParameter]: '类型参数',
    };
    return map[kind] ?? `kind_${kind}`;
  }

  /** 格式化诊断信息为紧凑结构。保留 code/tags/data 供 codeAction 使用。 */
  private formatDiagnostic(d: Diagnostic): DiagnosticResult {
    // toJson 剥离可选字段缺失时产生的 key: undefined（宿主无损 JSON 契约）
    return this.toJson({
      severity: (['error', 'warning', 'information', 'hint'] as const)[
        (d.severity ?? 3) - 1
      ] ?? 'information',
      message: typeof d.message === 'string' ? d.message : d.message.value,
      range: d.range,
      source: d.source,
      code: d.code != null ? String(d.code) : undefined,
      tags: d.tags,
      data: d.data,
    });
  }

  /** 格式化文档符号为紧凑树结构。 */
  private formatDocumentSymbol(sym: DocumentSymbol, depth: number): DocumentSymbolResult {
    return {
      name: sym.name,
      kind: SYMBOL_KIND_MAP[sym.kind] ?? `kind_${sym.kind}`,
      range: sym.range,
      depth,
      children: sym.children?.map((c) => this.formatDocumentSymbol(c, depth + 1)) ?? [],
    };
  }

  /** 格式化 CallHierarchyItem 为紧凑结构。 */
  private formatCallHierarchyItem(item: CallHierarchyItem): CallHierarchyItemSummary {
    return {
      name: item.name,
      kind: SYMBOL_KIND_MAP[item.kind] ?? `kind_${item.kind}`,
      filePath: this.fromUri(item.uri),
      range: item.range,
    };
  }
}

// ─── 返回类型 ────────────────────────────────────────────
// 全部使用 type alias（对象字面量类型带隐式 index signature）且不使用 readonly 数组：
// 工具输出经 defineTool 契约必须可赋给宿主的 JsonValue 形状（2026-08-23 定）。

/** 工具输出的 JSON 数据约束（csharp-ls 返回本就是纯 JSON）。 */
type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

/** hover 结果。range 无消费方且 LSP 可选——不进入输出（无损 JSON 契约）。 */
export type HoverResult = {
  readonly found: boolean;
  readonly summary: string;
};

/** 诊断结果（含 code/tags/data 供 codeAction 关联）。 */
export type DiagnosticResult = {
  readonly severity: 'error' | 'warning' | 'information' | 'hint';
  readonly message: string;
  readonly range: { start: { line: number; character: number }; end: { line: number; character: number } };
  readonly source?: string;
  /** 诊断代码（如 'CS0029'），用于关联 codeAction。 */
  readonly code?: string;
  /** LSP Diagnostic tags（如 Unnecessary=1, Deprecated=2）。 */
  readonly tags?: number[];
  /** csharp-ls 扩展数据，供 codeAction/resolve 使用。 */
  readonly data?: JsonLike;
};

/** 文档符号结果（递归树）。 */
export type DocumentSymbolResult = {
  readonly name: string;
  readonly kind: string;
  readonly range: { start: { line: number; character: number }; end: { line: number; character: number } };
  readonly depth: number;
  readonly children: DocumentSymbolResult[];
};

/** 调用层级结果。 */
export type CallHierarchyResult = {
  readonly incoming: CallHierarchyIncoming[];
  readonly outgoing: CallHierarchyOutgoing[];
};

/** 入调用摘要。 */
export type CallHierarchyIncoming = {
  readonly from: CallHierarchyItemSummary;
  readonly ranges: { start: { line: number; character: number }; end: { line: number; character: number } }[];
};

/** 出调用摘要。 */
export type CallHierarchyOutgoing = {
  readonly to: CallHierarchyItemSummary;
  readonly ranges: { start: { line: number; character: number }; end: { line: number; character: number } }[];
};

/** CallHierarchyItem 紧凑摘要。 */
export type CallHierarchyItemSummary = {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly range: { start: { line: number; character: number }; end: { line: number; character: number } };
};

/** CodeAction 结果（含编辑操作）。 */
export type CodeActionResult = {
  readonly title: string;
  readonly kind?: string;
  readonly isPreferred: boolean;
  /** WorkspaceEdit 中的文件编辑列表。 */
  readonly edits: {
    readonly filePath: string;
    readonly range: { start: { line: number; character: number }; end: { line: number; character: number } };
    readonly newText: string;
  }[];
};

/** 补全项结果。 */
export type CompletionResult = {
  readonly label: string;
  readonly kind: string;
  readonly detail?: string;
  readonly documentation?: string;
  readonly insertText?: string;
};

/** 方法签名结果。 */
export type SignatureResult = {
  readonly label: string;
  readonly documentation?: string;
  readonly parameters: { readonly label: string; readonly documentation?: string }[];
  readonly activeParameter: number;
};

/** 格式化编辑结果。 */
export type FormatEditResult = {
  readonly range: { start: { line: number; character: number }; end: { line: number; character: number } };
  readonly newText: string;
};

/** 重命名结果。 */
export type RenameResult = {
  readonly newName: string;
  readonly affectedFiles: number;
  readonly totalEdits: number;
  readonly fileEdits: {
    readonly filePath: string;
    readonly edits: { readonly range: any; readonly newText: string }[];
  }[];
};

/** 工作区诊断结果（按文件分组）。 */
export type WorkspaceDiagnosticResult = {
  readonly filePath: string;
  readonly diagnostics: DiagnosticResult[];
}
