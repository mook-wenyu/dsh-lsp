/**
 * 语言服务器注册表（多语言化核心，2026-08-25 新增）。
 *
 * 每个受支持语言一个描述符，集中声明：
 * - 文件→语言路由（扩展名正则）与 LSP languageId 映射
 * - 项目标记（工作区探测用）
 * - 服务器启动方式（内置 bundled / 外部命令）+ env + initialize 选项
 * - 协议差异参数：诊断等待、格式默认值
 * - 提示词段（prompt.ts 按会话探测结果取用）
 *
 * 设计约束（对齐协议差异实测）：
 * - typescript-language-server（tsserver 包装，内置分发）为 push-only 诊断服务器：
 *   didOpen/didChange 后异步 publishDiagnostics，lsp-client 需按 diagnosticWatchMs 等待推送。
 * - 其向客户端发 workspace/configuration（formattingOptions）请求，server-manager 应答。
 * - ts-ls 的 organizeImports 会删除未使用 import（与 csharp-ls 相反），提示词/描述需诚实化。
 *
 * @module @echocore/dsh-lsp-client/languages
 */

import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 受支持的语言 id。 */
export type LanguageId = 'csharp' | 'typescript';

/** 项目标记：按文件名后缀或精确文件名匹配，用于向上探测工作区根。 */
export type ProjectMarker = {
  readonly kind: 'suffix' | 'filename';
  readonly value: string;
};

/** 每语言服务器启动解析结果。 */
export interface ServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/** 语言服务器描述符。 */
export interface LanguageServerDescriptor {
  readonly id: LanguageId;
  /** 文件扩展名路由正则（大小写不敏感）。 */
  readonly filePattern: RegExp;
  /** 工作区项目标记。 */
  readonly projectMarkers: readonly ProjectMarker[];
  /** 是否由插件内置分发（bundled）。 */
  readonly bundled: boolean;
  /** 非 bundled 时的默认启动方式（外部命令名）。 */
  readonly defaultServerCommand: string;
  /** bundled 语言必需的固定启动参数（如 ts-ls 的 --stdio）。 */
  readonly defaultServerArgs?: readonly string[];
  /**
   * 是否需经 shell 启动（仅 Windows 生效）。外部命令若是 .cmd/.bat shim
   * （如 dotnet 全局工具 csharp-ls）需要 shell 解析；bundled 语言用 node
   * 绝对路径启动，绝不使用 shell——shell:true 下 Node 仅做空格拼接不转义，
   * 路径含空格（如 D:\Program Files\...\node.exe）会被 cmd 拆成乱命令
   * （2026-08-25 集成实测：'D:\Program' is not recognized）。
   */
  readonly useShell?: boolean;
  /** 附加子进程 env（如 C# 关遥测）。 */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** initialize 请求的 initializationOptions（语言特定）。 */
  readonly initializationOptions?: Readonly<Record<string, unknown>>;
  /** 格式化默认值（lsp_format 请求参数 + workspace/configuration 应答）。 */
  readonly formatDefaults: { readonly tabSize: number; readonly insertSpaces: boolean };
  /** push-only 服务器诊断等待上限（ms）。pull 服务器忽略。 */
  readonly diagnosticWatchMs: number;
  /** 该语言的 prompt 段（双向决策边界式，中文）。 */
  readonly promptSection: string;
}

// ─── bundled 服务器启动解析（惰性 + 缓存）──────────────────────────────

// 以自身文件的真实路径为 require 锚点：生产部署形态是 pnpm isolated 布局的
// 符号链接（node_modules/@echocore/dsh-lsp-client → .pnpm/.../node_modules/...），
// Node 对符号链接路径做 node_modules 向上查找时基于链接路径链，够不到
// .pnpm/<pkg>/node_modules 兄弟目录（2026-08-25 部署对账实测 MODULE_NOT_FOUND）；
// realpathSync 后锚点落在真实目录，依赖解析恢复正常。
const requireFromHere = createRequire(realpathSync(fileURLToPath(import.meta.url)));

/** bundle 服务器启动缓存：LanguageId → {command,args} | null（null=解析失败，回退外部命令）。 */
const bundledLaunchCache = new Map<LanguageId, ServerLaunch | null>();

/**
 * 解析插件内置语言服务器的实际启动方式。
 *
 * typescript-language-server 为单文件 ESM CLI（bin → lib/cli.mjs，零运行时依赖）。
 * 插件在 DSH profile 深处安装，PATH 未必含其 .bin；因此以本包为锚点 resolve 其
 * package.json，读出 bin 入口后用 host node（process.execPath）直接启动：
 * node <cli> --stdio  —— 跨平台无需 shell/.cmd 兼容。
 * 解析失败返回 null（调用方回退外部命令名）。
 */
function bundledLaunch(lang: LanguageId, pkgName: string): ServerLaunch | null {
  const cached = bundledLaunchCache.get(lang);
  if (cached !== undefined) return cached;
  let result: ServerLaunch | null = null;
  try {
    const pkgPath = requireFromHere.resolve(`${pkgName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const binEntry = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin ? Object.values(pkg.bin)[0] : undefined);
    if (binEntry) {
      result = { command: process.execPath, args: [join(dirname(pkgPath), binEntry)] };
    }
  } catch {
    // 解析失败：回退外部命令名（PATH 查找），由调用方兜底
  }
  bundledLaunchCache.set(lang, result);
  return result;
}

/** tsserver fallbackPath：插件内置 typescript 的 lib 目录（工作区版本仍优先）。 */
function bundledTypescriptLib(): string | undefined {
  try {
    const pkgPath = requireFromHere.resolve('typescript/package.json');
    return join(dirname(pkgPath), 'lib');
  } catch {
    return undefined;
  }
}

// ─── 描述符 ────────────────────────────────────────────────────────────

/**
 * 解析服务器启动方式（用户覆盖优先）。
 *
 * - 用户配置了 serverCommand → 原样使用（+serverArgs 追加），兼容现有 C# 覆盖先例。
 * - 否则 bundled 语言 → 内置 node <cli>；失败回退外部命令名。
 * - 外部语言（csharp）→ defaultServerCommand + serverArgs。
 */
export function resolveServerLaunch(
  lang: LanguageId,
  overrideCommand?: string,
  overrideArgs?: readonly string[],
): ServerLaunch {
  const d = LANGUAGES[lang];
  if (overrideCommand) {
    return { command: overrideCommand, args: [...(overrideArgs ?? [])] };
  }
  if (d.bundled) {
    const launch = bundledLaunch(lang, TYPESCRIPT_SERVER_PACKAGE);
    if (launch) {
      // bundled 启动：node <cli> [默认固定参数]（如 ts-ls 的 --stdio 必填）
      return { command: launch.command, args: [...launch.args, ...(d.defaultServerArgs ?? [])] };
    }
  }
  return { command: d.defaultServerCommand, args: [...(overrideArgs ?? [])] };
}

/** 内置 typescript-language-server 包名。 */
export const TYPESCRIPT_SERVER_PACKAGE = 'typescript-language-server';

/** 全部支持语言的描述符（注册顺序即优先级：cwd 同时命中多语言时按此序取默认）。 */
export const LANGUAGES: Readonly<Record<LanguageId, LanguageServerDescriptor>> = {
  csharp: {
    id: 'csharp',
    filePattern: /\.cs$/i,
    projectMarkers: [
      { kind: 'suffix', value: '.slnx' },
      { kind: 'suffix', value: '.sln' },
      { kind: 'suffix', value: '.csproj' },
    ],
    bundled: false,
    defaultServerCommand: 'csharp-ls',
    // dotnet 全局工具是 .cmd shim，Windows 需经 shell 解析
    useShell: true,
    extraEnv: { DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
    initializationOptions: {},
    formatDefaults: { tabSize: 4, insertSpaces: false },
    // csharp-ls 为 pull 诊断服务器，无等待需求（保留字段供统一逻辑）。
    diagnosticWatchMs: 0,
    promptSection:
      '## C# LSP 工具（14 个）\n' +
      '\n' +
      '### 符号级问题必须用 lsp（优于 read/grep：语义精确、跨文件、零整文件加载）\n' +
      '- 查定义/跳转 → `lsp_definition`；查类型签名/文档 → `lsp_hover`\n' +
      '- 改名或重构前的影响面 → `lsp_references` 全量引用 + `lsp_implement` 实现\n' +
      '- 编辑 .cs 后 → `lsp_diagnostics` 确认零错误才算完成；有错配 `lsp_code_action`\n' +
      '\n' +
      '### 文本搜索仍用 grep/read（不要绕道 lsp）\n' +
      '- 搜注释/字符串/TODO 等文本模式\n' +
      '- 不知道符号名的广度探索\n' +
      '\n' +
      '### 其余\n' +
      '- 编写辅助：`lsp_completion`/`lsp_signature`；结构速览：`lsp_document_symbols`\n' +
      '- 清理：`lsp_organize_imports`（csharp-ls 不删未使用 using）+`lsp_format`；全局：`lsp_workspace_diagnostics`\n' +
      '- 注意：`lsp_call_hierarchy` 受 csharp-ls 0.26.0 限制返回服务器错误\n' +
      '- 行列 0-indexed；`file_path` 绝对路径',
  },
  typescript: {
    id: 'typescript',
    filePattern: /\.(ts|tsx|js|jsx)$/i,
    projectMarkers: [
      { kind: 'filename', value: 'package.json' },
      { kind: 'filename', value: 'tsconfig.json' },
      { kind: 'filename', value: 'jsconfig.json' },
    ],
    bundled: true,
    defaultServerCommand: 'typescript-language-server',
    // ts-ls CLI 要求 --stdio（无此参数直接退出/打印帮助）
    defaultServerArgs: ['--stdio'],
    extraEnv: {},
    initializationOptions: {
      hostInfo: 'dsh-lsp-client',
      preferences: {
        // 与 VS Code TS 服务默认对齐的最小偏好集；其余走 tsserver 默认
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
        includeCompletionsWithSnippetText: true,
      },
      tsserver: {
        // 工作区 typescript 优先；仅在无工作区版本时回退内置（兜底）
        fallbackPath: bundledTypescriptLib(),
      },
    },
    // tsserver 惯例（prettier 相近默认）
    formatDefaults: { tabSize: 2, insertSpaces: true },
    // push-only 服务器：didOpen/didChange 后诊断异步到达，等待上限 5s
    diagnosticWatchMs: 5000,
    promptSection:
      '## TS/JS LSP 工具（14 个）\n' +
      '\n' +
      '### 符号级问题必须用 lsp（优于 read/grep：语义精确、跨文件、零整文件加载）\n' +
      '- 查定义/跳转 → `lsp_definition`；查类型签名/文档 → `lsp_hover`；查实现 → `lsp_implement`\n' +
      '- 改名或重构前的影响面 → `lsp_references` 全量引用\n' +
      '- 编辑 .ts/.tsx/.js/.jsx 后 → `lsp_diagnostics` 确认零错误才算完成；有错配 `lsp_code_action`\n' +
      '\n' +
      '### 文本搜索仍用 grep/read（不要绕道 lsp）\n' +
      '- 搜注释/字符串/TODO 等文本模式\n' +
      '- 不知道符号名的广度探索\n' +
      '\n' +
      '### 其余\n' +
      '- 编写辅助：`lsp_completion`/`lsp_signature`；结构速览：`lsp_document_symbols`\n' +
      '- 清理：`lsp_organize_imports`（会删除未使用 import）+`lsp_format`；全局：`lsp_workspace_diagnostics`（仅覆盖已探明文件）\n' +
      '- 注意：`lsp_call_hierarchy` 受 typescript-language-server 5.x 限制返回服务器错误（声明能力但处理器未注册）\n' +
      '- 行列 0-indexed；`file_path` 绝对路径',
  },
};

/** 默认语言（文件无法路由时按注册顺序取第一个）：lsp_workspace_diagnostics 无文件参数场景。 */
export const DEFAULT_LANGUAGE: LanguageId = 'csharp';

/**
 * 按文件扩展名路由语言。未识别返回 undefined（调用方按 DEFAULT_LANGUAGE/探测逻辑处理）。
 */
export function languageOfFile(filePath: string): LanguageId | undefined {
  for (const lang of Object.keys(LANGUAGES) as LanguageId[]) {
    if (LANGUAGES[lang].filePattern.test(filePath)) return lang;
  }
  return undefined;
}

/** 文件 → LSP languageId（原生扩展映射；未识别扩展返回小写扩展名兜底，保留旧语义）。 */
export function lspLanguageIdOf(filePath: string, lang: LanguageId | undefined): string {
  if (lang === 'typescript') {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
    };
    return map[ext] ?? ext;
  }
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    cs: 'csharp',
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
  };
  return map[ext] ?? ext;
}