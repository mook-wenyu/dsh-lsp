# dsh-lsp 目标文档：增加 TS/JS 语言支持

> 状态：**执行完成（2026-08-25）**——单测 200/200、集成 29 过 1 跳过、typecheck 干净；部署仪式见 STATUS.md「四」第 1 条（docs/analysis-tsjs.md 为深度分析报告、docs/plan-tsjs.md 为实现计划）
> 本文件是本次需求的主文档：持续记录分析、调研、每轮问答决策，最后由它产出《深度分析报告 + 实现计划》。
> 建立于：2026-08-25 深夜（本地时区），基线测试 166/166 全绿。

## 〇、已确认目标（第 1 轮锁定）

**在 `@echocore/dsh-lsp-client` 内新增 TypeScript/JavaScript 语言支持，与现有 C# 支持并存（多语言化）**：
保留 C# 全部现有能力与 14 工具接口；新增 TS/JS（.ts/.tsx/.js/.jsx）走同一套 lsp_* 工具，按文件语言自动路由到对应服务器实例；架构上引入「语言服务器注册表」（LanguageServerRegistry）抽象。验收需保证契约 A/B/C/D 回归锁全绿。

## 〇a、第 2 轮锁定：覆盖范围 = **全量交付**

`.ts/.tsx/.js/.jsx` 四种扩展名 × 14 工具全量一次交付（typescript-language-server 支持全部 14 项能力，无需裁剪；含 callHierarchy、organizeImports 删未使用等强于 csharp-ls 的差异点）。

## 〇b、第 3 轮锁定：安装模型 = **插件内置服务器（bundled）**

- `typescript-language-server` + `typescript` 作为插件 `dependencies` 携带；DSH profile 走现有 git 依赖流程安装即用。
- 项目自身 node_modules 含 typescript 时，ts-ls 自动优先解析工作区版本（可另设 `tsserver.fallbackPath` 兜底）。
- 保留 `serverCommand` 配置覆盖能力（与 C# 先例共存）。
- 版本钉：`typescript-language-server@^5.1.3`（本机已随 typescript@5.9.3 实测可用的基线；6.0.0 于 2026-08-20 发布 5 天，作为集成测试通过后的升级候补记录于实现计划）。

## 〇c、第 4 轮锁定：判定与注入 = **项目标记 + 按语言分段注入**

- TS/JS 项目标记：从 cwd 向上探测 `package.json` / `tsconfig.json` / `jsconfig.json` 任一命中即 TS/JS 项目；无标记不注入（与 C# 先例一致，散装 .ts/.js 文件会话零注入）。
- 提示词段按语言拆分：`lsp:tools` 段按会话 cwd 探测到的语言注入对应文案；同会话多语言（monorepo）并列注入多段。
- 工具 descriptions 同步按语言诚实化（语言参数化或分语言版本）。

---

## 一、目标（推断，待用户确认）

用户原始表述：「全面深度检索所有代码、深度分析当前项目，**增加编程语言 TS/JS**；网络搜索最新技术、权威文档、权威论文和最佳工程实践。……直到你对我的目标有明确的认知后，出深度分析报告与完备的实现计划并保存文档。再开始执行。」

**推断**：在当前仓库 `@echocore/dsh-lsp-client`（DSH LSP 客户端插件，现绑定 C#/csharp-ls）中**新增 TypeScript/JavaScript 语言支持**，使其从「C# 专用」变成「多语言（先 C# + TS/JS）」的 LSP 客户端。STATUS.md「下次最该做的事」第 3 条（LanguageServerRegistry 抽象）与此方向吻合；本机已全局安装 `typescript-language-server@5.1.3 + typescript@5.9.3` 也是强信号。

**待确认点（见第五节队列）**：载体与范围、服务器选型与安装模型、工具集与协议差异处理、会话判定与提示词注入策略、验收方式。

---

## 二、现状深度分析（代码级）

### 2.1 架构（8 模块，单向依赖，无环）

| 模块 | 职责 | 与 C# 的耦合点 |
|---|---|---|
| `src/index.ts` | Cordis 插件入口：配置校验、建池、注册 14 工具、tools/result 编辑后诊断注入、agent/disposed 释放 | serverCommand 默认 `csharp-ls`；诊断注入正则 `/\.cs$/`；错误文案「无法确定 C# 项目根目录」 |
| `src/tools.ts` | 14 个 lsp_* 工具定义（defineTool 编译） | 所有 description 写死「C#」「.cs」「csharp-ls」；code_action 传参说明引用 CS0029 |
| `src/lsp-client.ts` | LSP 语义化封装：syncDocument(didOpen/didChange)、hover/definition/…/workspaceDiagnostics，URI 归一化，输出精简化 | `inferLanguageId` 已含 ts/tsx/js/jsx；`format()` 硬编码 tabSize:4/insertSpaces:false；诊断优先级 pull>push 假设以 csharp-ls 行为为准 |
| `src/server-manager.ts` | 子进程生命周期：spawn → initialize 握手 → 重启退避 → dispose；能力探测 supportsPull/supportsWorkspaceDiagnostic；push 诊断缓存 | env 注入 DOTNET_CLI_TELEMETRY_OPTOUT；initialize 声明能力集（csharp-ls 语义）；不处理 server→client 请求（workspace/configuration 无 handler） |
| `src/workspace-pool.ts` | session × projectRoot 实例池（懒启动、disposeSession） | 语言无关 ✅ |
| `src/workspace-resolver.ts` | 向上探测 `.slnx/.sln/.csproj` 定项目根 | 后缀表写死 C# 三件套；回退 session cwd |
| `src/prompt.ts` | systemPrompt.context 段「lsp:tools」（order 125）：仅项目内注入，双向决策边界式 | 文案「C# LSP 工具（14 个）」；探测复用 resolver |
| `src/types.ts` | 类型与常量 | 语言无关 ✅ |

### 2.2 铁律契约（2026-08-23 三次生产事故沉淀，contract.test.ts 锁定）

- **A**：注册必须是 defineTool 编译产物（object-root JSON Schema）。
- **B**：execute 自带入口校验，缺必填参数抛 ToolArgsError。
- **C**：output.schema 顶层形状与实返一致（可空用 oneOf）。
- **D**：懒启动——resolveClient 必须先 manager.start() 再放行。
- 另有：无损 JSON（toJson 剥 undefined）、fire-and-forget 通知必须 `.catch(()=>{})`、normalizeUri Windows 小写盘符、诊断统一缓存（pull 结果写入，workspaceDiagnostics 聚合）。

### 2.3 已知边界与风险（现状）

- `lsp_call_hierarchy`：csharp-ls 0.26.0 不声明该能力 → 返回服务器错误（已知，非缺陷）。
- `organize_imports`：csharp-ls 不删未使用 using（能力边界）。
- 测试语义绑定 Windows 单平台。
- tools/result 自动诊断注入：只认 `.cs`。
- 池键 = sessionId + 项目根；TS 项目与 C# 项目同根（如 monorepo 混合）时键相同 → 需在设计中处理「同根多语言」情况。

---

## 三、外部调研结论（2026-08 时点，来源均附）

### 3.1 服务器选型：typescript-language-server（tsserver 包装）

- **npm 最新 6.0.0**（2026-08-20 发布，周下载 138 万；https://registry.npmjs.org/typescript-language-server/latest），**本机已装 5.1.3 + typescript@5.9.3**（全局）。
- 定位：VS Code 官方 `typescript-language-features`（作用于 tsserver 私有协议）之上的 LSP 薄封装，官方 README 直接声明「TS7 原生将包含 LSP 实现并有望取代本项目」。
- 零运行时依赖（5.1.3 为单文件 CLI `lib/cli.mjs`）；`typescript` 从 workspace 解析或经 `initializationOptions.tsserver.path/fallbackPath` 指定。
- **引用**：[typescript-language-server GitHub](https://github.com/typescript-language-server/typescript-language-server)、[npm 6.0.0](https://registry.npmjs.org/typescript-language-server/latest)

### 3.2 为什么不选 tsgo（TypeScript 7 原生）做生产

- 2025-05-22 官方宣布 Native Preview（10x 提速），但编辑器侧 find-all-references/rename/signature help 当时**仍待实现**（[Announcing TypeScript Native Previews](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/)）。
- withastro/roadmap 追踪（2026-03）：CLI 类型检查近 TS5.8 平价，但**可编程 Language Service API 仍在进行中，TS7 不携带稳定 API**；嵌入式语言（Vue/Astro/…）依赖 TS6。Zed 等已能接 tsgo LSP，但能力不全（参照 [withastro discussion #1321](https://github.com/withastro/roadmap/discussions/1321)、[TS7 Dec 2025 进度报告](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)）。
- 结论：**tsgo 留作演进观察项（记录于实现计划的「后续演进」节），本次生产选型用 typescript-language-server**；其能力经能力探测动态适配（现有 supportsPull 机制已支持），未来换服务器不动客户端工具层。

### 3.3 能力矩阵对比：csharp-ls 0.26 vs typescript-language-server 5.x/6.x

| LSP 能力 | 我们 14 工具 | csharp-ls | ts-ls 5.1.3+ | 差异影响 |
|---|---|---|---|---|
| hover | lsp_hover | ✅ | ✅（5.9+ 支持 verbosity 扩展） | 无 |
| definition（LocationLink） | lsp_definition | ✅ | ✅（自 1.1.0） | 无 |
| references | lsp_references | ✅ | ✅ | 无 |
| implementation | lsp_implement | ✅ | ✅ | 无 |
| documentSymbol（层级） | lsp_document_symbols | ✅ | ✅（自 0.3.2） | 无 |
| callHierarchy | lsp_call_hierarchy | ❌ 未声明 | ✅（自 0.3.7，2018） | **C# 已知边界 → TS 可用，prompt 需提示语言差异** |
| codeAction quickfix | lsp_code_action | ✅ | ✅ | ts-ls 另有 `source.organizeImports.ts` 等 source 类 |
| completion | lsp_completion | ✅ | ✅ | 无 |
| signatureHelp | lsp_signature | ✅（构造器可能无返回） | ✅ | 无 |
| formatting/rangeFormatting | lsp_format | ✅ | ✅ | **ts-ls 会向客户端发 `workspace/configuration` 要格式化配置（formattingOptions），我们无 handler，必须补** |
| prepareRename+rename | lsp_rename | ✅ | ✅ | 无 |
| organizeImports | lsp_organize_imports | ⚠️ 不删未使用 | ✅ `source.organizeImports.ts` **可删未使用（mode: All）** | **TS 端能力更强，描述需按语言诚实化** |
| 诊断 pull（3.17） | lsp_diagnostics | ✅ 声明的 | ❌ 未声明（push-only） | **TS 走 push 缓存；didOpen 后诊断异步到达，当前实现立即读缓存会拿到空 → 需「等推送」机制（竞态修复点）** |
| workspace/diagnostic pull | lsp_workspace_diagnostics | ✅ | ❌ 未声明 | TS 回退「已探明文件缓存」聚合，语义=已打开文件（文档中说明） |

关键差异（实现计划必须处理）：
1. **server→client `workspace/configuration` 请求**（ts-ls 5.1.0+ 每文件请求 tabSize/insertSpaces）：vscode-jsonrpc 无 handler 会回 MethodNotFound；需注册 onRequest 返回默认值（与 format 参数一致）。
2. **诊断竞态**：push-only 服务器在 didOpen/didChange 后异步 publishDiagnostics；需在 diagnostics() 增加「等待首个匹配推送（可配置超时/轮询缓存）」逻辑（C# pull 路径不受影响）。
3. **`$/typescriptVersion`、`$/semanticTokens/…` 等自定义通知**：无 handler 即丢弃，安全；无需处理（可记录日志）。
4. **tsserver 进程数**：useSyntaxServer 'auto' 会起双进程（full+syntax），内存/进程管理需知晓。
5. **organizeImports 语义增强**：ts-ls 支持 `mode: 'All'|'SortAndCombine'|'RemoveUnused'`（4.4+），可借 workspace/executeCommand `_typescript.organizeImports`。
6. TS 项目无 .sln/.csproj：项目根探测须改用 `package.json`/`tsconfig.json`/`jsconfig.json`（判定「TS/JS 项目」）。
7. `format()` 硬编码 tabSize:4/insertSpaces:false 对 TS 语义偏（Prettier 惯例 2 空格）；需改为按语言配置（或经 workspace/configuration 下发）。
8. Windows `.cmd` spawn 问题对 ts-ls 不存在（node bin），但 shell:true 在 win32 保留无害；env 的 DOTNET_CLI_TELEMETRY_OPTOUT 对 ts-ls 无意义（可去语言化）。

### 3.4 论文与最佳实践引用（prompt/设计的依据）

- 本项目 prompt.ts 已引用：EMNLP 2025《Tool Preferences in Agentic LLMs are Unreliable》（纯描述性引导脆弱）→ 双向决策边界式提示词；Serena SKILL；Anthropic 工具工程指南。
- **Lanser-CLI（arXiv:2510.22907, 2025-10, Princeton）**：LSP 作为 agent 的「过程奖励」——确定性 Analysis Bundle、preview-first/workspace-jail 安全围栏、诊断增量作为信号。与本项目「rename/format/organize 只返回编辑计划不落盘」的 safety-first 设计一致，可作为后续「诊断增量引导」的演进方向（记录，不纳入本次范围）。[论文链接](https://ar5iv.labs.arxiv.org/html/2510.22907)
- LSP 3.17 官方规范（pull diagnostics / workspace diagnostic / codeAction 等）：[specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)。

---

## 四、Q&A 决策记录（每轮问答后更新）

| 轮次 | 问题 | 用户回答 | 决策落点 | 更新人/时间 |
|---|---|---|---|---|
| 1 | 目标载体：在插件内新增 TS/JS 与 C# 并存？ | **A：在 dsh-lsp-client 内新增 TS/JS 支持，与 C# 并存** | 多语言注册表架构；C# 14 工具全部保留；工具接口稳定，仅描述按语言诚实化 | main / 2026-08-25 |
| 2 | TS/JS 覆盖范围 | **A：全量 .ts/.tsx/.js/.jsx × 14 工具，一次交付** | 交付批次=单批全量；测试夹具矩阵含 4 扩展名；无需子集裁剪 | main / 2026-08-25 |
| 3 | 服务器安装模型 | **A：插件内置服务器（bundled）** | typescript-language-server+typescript 入 dependencies；serverCommand 覆盖保留；版本基线 5.1.3（6.0.0 候补） | main / 2026-08-25 |
| 4 | 会话判定与提示词注入 | **A：项目标记判定 + 按语言分段注入** | 标记=package.json/tsconfig.json/jsconfig.json 任一；无标记零注入；monorepo 多语言并列注入；描述按语言诚实化 | main / 2026-08-25 |
| 5 | 交付终点 | **B：完整交付含部署（重启 DSH）** | 代码+测试+文档全绿后执行部署仪式（commit/push/lockfile/allowBuilds/dsh plugin install/重启/冒烟）；部署置于最末并接受会话中断 | main / 2026-08-25 |

> 其余工程细节（诊断等待默认值、集成测试夹具、双形态 WorkspaceEdit 等）由实现计划按证据默认决策并在 plan-tsjs.md 登记，不再占用问答轮次。

---

## 五、待确认问题队列（按依赖顺序，一次只问一个）

全部 ✅ 已确认（第 5 轮完结）。剩余为工程默认决策，见 `docs/plan-tsjs.md` 与本文「六」。

---

## 六、执行前的硬约束（不可回退）

- 14 工具接口（name/schema/输出形状）保持稳定；仅 description 按语言诚实化。
- 契约 A/B/C/D 回归锁必须继续全绿。
- 每次问答后更新本文件「第四节」，避免上下文丢失。
- 目标确认前**不写任何实现代码**。