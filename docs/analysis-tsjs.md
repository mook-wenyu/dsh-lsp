# dsh-lsp 增加 TS/JS 语言支持 —— 深度分析报告

> 生成：2026-08-25（Q&A 五轮全部确认后）· 资料时点：2026-08-25 · 分析对象：`D:\TSProjects\dsh-lsp`（`@echocore/dsh-lsp-client` v0.1.0）
> 配套文档：`docs/goal-tsjs.md`（Q&A 决策记录）、`docs/plan-tsjs.md`（实现计划）

## 1. 结论先行

在 `@echocore/dsh-lsp-client`（DSH/LSP 客户端插件，现绑定 C#/csharp-ls）中新增 **TypeScript/JavaScript（.ts/.tsx/.js/.jsx）语言支持**：与 C# 并存，14 个工具接口全部保留并按文件语言自动路由，引入语言服务器注册表（LanguageServerRegistry）抽象。服务器选型 **typescript-language-server（tsserver 包装）**，插件内置（bundled）分发。**tsgo（TypeScript 7 原生）LSP 未成熟，不采用**。实现涉及 8 个源模块中的 7 个，核心风险 5 项（见 §6），均有对应设计与验证。

## 2. 现状画像（代码级证据）

### 2.1 结构与耦合点

8 模块单向依赖无环：index → tools/lsp-client/server-manager/workspace-pool/workspace-resolver/prompt/types。**C# 绑定点**（改造面）：

| 位置 | 绑定细节 |
|---|---|
| `src/index.ts` L98 | `command: config.serverCommand ?? 'csharp-ls'` |
| `src/index.ts` L120 | 错误「无法确定 C# 项目根目录」 |
| `src/index.ts` L157 | tools/result 诊断注入正则 `/\.cs$/` |
| `src/tools.ts` | 全部 14 个 description 写死「C#/.cs/csharp-ls/CS0029」 |
| `src/lsp-client.ts` L484 | `format()` 硬编码 `{ tabSize: 4, insertSpaces: false }` |
| `src/server-manager.ts` L209 | env 注入 `DOTNET_CLI_TELEMETRY_OPTOUT` |
| `src/server-manager.ts` L295+ | initialize 能力集 + `initializationOptions: {}` 空 |
| `src/server-manager.ts`（整文件） | 无 server→client 请求 handler（ts-ls 需要 `workspace/configuration`） |
| `src/workspace-resolver.ts` L23 | 项目标记只认 `.slnx/.sln/.csproj` |
| `src/prompt.ts` L40 | 提示词整段 C# 专属，探测复用 resolver |

语言无关可直接复用：`workspace-pool.ts`（键格式需加语言维）、`lsp-client.ts` 的 URI 归一化/文件同步/结果精简、`types.ts`、`server-manager.ts` 的进程生命周期骨架/重启退避/诊断缓存。

### 2.2 不可回退的契约（contract.test.ts 46 项 + 全套 166 项基线全绿）

- A：注册必须是 defineTool 编译产物；B：缺参抛 ToolArgsError；C：output.schema 顶层形状=实返；D：懒启动先 start()。
- 无损 JSON（toJson 剥 undefined）、fire-and-forget 通知 `.catch(()=>{})`、normalizeUri Windows 小写盘符、诊断统一缓存（pull 结果写入、workspaceDiagnostics 聚合）。

### 2.3 已知边界（现状即文档）

- `lsp_call_hierarchy` 在 csharp-ls 0.26.0 下返回服务器错误（已知非缺陷）。
- `organize_imports` 在 csharp-ls 下不删未使用 using（服务端限制）。
- 测试语义绑定 Windows 单平台。

## 3. 需求拆解（Q&A 五轮已确认）

| 决策 | 内容 | 轮次 |
|---|---|---|
| 载体 | 插件内新增 TS/JS，与 C# 并存，注册表架构 | 1 |
| 覆盖 | `.ts/.tsx/.js/.jsx` × 14 工具全量一次交付 | 2 |
| 安装 | typescript-language-server+typescript 内置为 dependencies；serverCommand 保留覆盖；基线 5.1.3（6.0.0 候补） | 3 |
| 判定/注入 | 项目标记 = package.json/tsconfig.json/jsconfig.json 任一；按语言分段注入；monorepo 并列；无标记零注入 | 4 |
| 交付终点 | 本地全绿（含真实 ts-ls 集成测试）+ 完整部署仪式（重启 DSH） | 5 |

## 4. 外部调研（2026-08 时点）

### 4.1 选型：typescript-language-server 5.1.3/6.0.0

- 定位：VS Code 官方 typescript-language-features（tsserver 私有协议）的 LSP 薄封装；[README](https://github.com/typescript-language-server/typescript-language-server) 明确 TS7 原生将「包含 LSP 实现并有望取代本项目」。
- [npm 最新 6.0.0](https://registry.npmjs.org/typescript-language-server/latest)（2026-08-20，周下载 138 万）；本机已验证 **5.1.3 + typescript 5.9.3**。5.1.3 为单文件 ESM CLI（`lib/cli.mjs`），**零运行时依赖**；`typescript` 自工作区解析，可经 `initializationOptions.tsserver.path/fallbackPath` 指定。

### 4.2 不采用 tsgo 的证据链

- [TS Native Previews 公告](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/)（2025-05-22）：编辑器侧 find-all-references/rename/signature 当时未实现。
- [withastro roadmap #1321](https://github.com/withastro/roadmap/discussions/1321)（2026-03/08）：CLI 检查近 5.8 平价，但**可编程 Language Service API 仍在进行**、TS7 不携带稳定 API，嵌入式语言生态（Vue/Astro/…）依赖 TS6；[TS7 Dec 2025 进度](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/) 佐证。
- 结论：tsgo 仅记录为「后续演进观察项」；客户端能力探测机制（现有 supportsPull 等）已为未来换服务器留好接口。

### 4.3 能力矩阵（14 工具 × 两服务器）

| 工具 | csharp-ls 0.26 | ts-ls 5.1.3+ | 差异处理 |
|---|---|---|---|
| hover/definition/references/implement/documentSymbols/completion/signature/format/prepareRename+rename/codeAction(quickfix) | ✅ | ✅ | 无 |
| callHierarchy | ❌ 未声明 | ✅（自 0.3.7） | prompt 按语言标注差异，诚实化 |
| organizeImports | ⚠️ 不删未使用 | ✅ `source.organizeImports.ts` 可删未使用（mode 支持） | 工具描述按语言诚实化 |
| 诊断 pull（3.17） | ✅ 声明 | ❌ 未声明（push-only） | TS 走 push 缓存 + **等推送机制**（见 §6-2） |
| workspace/diagnostic pull | ✅ | ❌ | TS 回退「已探明文件」聚合（与现描述一致） |

### 4.4 文献与最佳实践

- 本项目 prompt.ts 已引 EMNLP 2025《Tool Preferences in Agentic LLMs are Unreliable》（双向决策边界式提示词）。
- [Lanser-CLI（arXiv:2510.22907，Princeton，2025-10）](https://ar5iv.labs.arxiv.org/html/2510.22907)：LSP 作为 agent「过程奖励」——preview-first/安全围栏与本项目「编辑计划不落盘」一致；「诊断增量」可作为后续演进方向（不入本次范围）。
- LSP 3.17 规范（pull diagnostics/workspace/configuration）：[spec](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)。

## 5. 设计总览（对应计划各阶段）

新模块 `src/languages.ts`（注册表）：`LanguageId = 'csharp' | 'typescript'`，描述符含：文件扩展名→languageId 映射、项目标记（suffix 型 `.slnx/.sln/.csproj` / filename 型 `package.json/tsconfig.json/jsconfig.json`）、默认命令与**内置 bin 解析**、env、initialize 选项（tsserver.path/fallbackPath/preferences、hostInfo）、格式默认值（csharp 4/false；typescript 2/true）、提示词段文本、push 诊断等待默认值。

变更面：resolver（多语言联合探测，保持 C# 语义不变）、pool（键加语言维）、server-manager（语言化 env/initOptions + `workspace/configuration` handler + formatDefaults 暴露）、lsp-client（push 等待、format 选项、codeAction/organizeImports 支持 documentChanges）、index（按文件语言路由 + 错误文案 + hook 正则扩展）、tools（描述中性化 + 诚实化）、prompt（分段注入）。

## 6. 关键风险与对策（实现计划必须覆盖）

1. **ts-ls 向客户端发 `workspace/configuration`**（5.1.0+ 每文件请求 formattingOptions）：vscode-jsonrpc 无 handler 回 MethodNotFound。对策：server-manager 注册 onRequest，按 scopeUri/语言返回格式默认值；未知 section 返回 null。
2. **诊断竞态（push-only）**：didOpen/didChange 后诊断异步推送，现有实现立即读缓存恒空。对策：!supportsPull 时轮询缓存（100ms 间隔），直至命中或 `diagnosticWatchMs`（默认 5000ms，可配置）超时；失败返回当前缓存（可能为空）不抛错。
3. **内置服务器命令解析**：插件位于 profile node_modules 深处，PATH 上未必有 `.bin`。对策：以本包为锚点 `require.resolve('typescript-language-server/package.json')` 取 bin 映射 → `node <cli.js> --stdio`（Windows 免 .cmd 兼容问题）；解析失败回退原命令串。
4. **WorkspaceEdit 形态差异**：ts-ls 的 codeAction/rename 可能携带 `documentChanges` 而非 `changes`。对策：codeAction/organizeImports/rename 统一兼容两种形态（changes + documentChanges[TextDocumentEdit]）。
5. **monorepo 同根双语言**：池键加语言维（`session\0lang\0root`），C# 与 TS 服务器实例互不干扰；`agent/disposed` 前缀匹配仍成立。
6. **语义边界诚实化**：workspace_diagnostics 对 TS 仅覆盖「已探明文件」；organize_imports 对 TS 会删未使用 import（与 C# 相反）；call_hierarchy 对 TS 可用（与 C# 相反）——均写入工具描述与 prompt，避免模型误判。
7. **非目标**（明确不做）：tsgo 原生 LSP、.vue/.svelte/.astro 嵌入式语言（需 Volar 等）、semantic tokens/inlay hints 新工具、编辑自动落盘应用。

## 7. 验收基线（执行前已锁定）

- 单测基线 166/166 全绿；实现后全量必须保持全绿并新增 TS/JS 覆盖。
- 集成测试：新增真实 typescript-language-server 进程测试（tsconfig 工程 + jsconfig 工程夹具）。
- 契约 A/B/C/D 回归锁不得放宽。
- 冒烟：部署重启 DSH 后，在真实 TS 会话（本仓库即 TS 工程）验证注入与 14 工具。