# dsh-lsp 增加 TS/JS 语言支持 —— 实现计划

> 配套：`docs/goal-tsjs.md`（Q&A 决策）、`docs/analysis-tsjs.md`（深度分析报告）
> 执行原则：每阶段可独立验证；先测试后代码（缺陷修复回归锁优先）；不触碰契约 A/B/C/D；变更小而准、逐条可追溯。

## 阶段总览

| # | 阶段 | 关键产出 | 验证方式 |
|---|---|---|---|
| 0 | 依赖与基线 | package.json 加 typescript-language-server@^5.1.3 + typescript@^5.9.3 | `pnpm install` 成功；`pnpm test` 166 全绿 |
| 1 | 语言注册表 | `src/languages.ts`（LanguageId/描述符/内置 bin 解析/探测辅助） | 单测：扩展名→语言、标记→语言、bin 解析路径存在 |
| 2 | 多语言项目探测 | `workspace-resolver.ts` 联合探测（C# 语义不变） | 单测：TS 标记命中/未命中回退 cwd/C# 回归 |
| 3 | server-manager 语言化 | 每语言 env/initialize 选项；`workspace/configuration` handler；格式默认值暴露 | 单测：handler 返回 tabSize/insertSpaces；初始化参数形状 |
| 4 | lsp-client 差异适配 | push 诊断等待、format 选项、documentChanges 兼容 | 单测：等待命中/超时；格式选项；documentChanges→changes 归一 |
| 5 | 池与路由 | pool 键加语言维；index 按文件语言路由；hook 扩展 `.ts/.tsx/.js/.jsx`；错误文案语言化 | 单测 + 契约 D 回归；index 测试 |
| 6 | 工具描述诚实化 | tools.ts 描述中性化+语言差异标注 | 契约 A/B/C 全绿 |
| 7 | 提示词分段注入 | prompt.ts 按语言注入 | 单测：C# 段/TS 段/monorepo 并列/零注入 |
| 8 | 集成测试 | `test-project-ts/` + `test-project-js/` 夹具 + ts-ls 集成测试 | `pnpm test:integration` 全绿（C# + TS 两组） |
| 9 | 文档与收尾 | README/STATUS/docs 更新；`pnpm typecheck` + `pnpm test` 全绿 | 全量复跑 |
| 10 | 部署仪式 | commit/push → profile lockfile → allowBuilds 对账 → `dsh plugin install` → 重启 DSH → 真实会话冒烟 | 冒烟证据（日志/文件） |

## 阶段 0：依赖与基线

1. `pnpm add typescript-language-server@^5.1.3 typescript@^5.9.3`（运行时 dependencies；ts-ls 零运行时依赖，typescript 为 tsserver 后备版本）。
   - 注：`typescript` 作为 dependency 仅为「无工作区 typescript」时的后备；工作区自带版本优先（ts-ls 行为）。
2. 验证：install 成功；`pnpm test` 仍 166 全绿；`pnpm typecheck` 通过。

## 阶段 1：语言注册表 `src/languages.ts`（新模块）

```ts
export type LanguageId = 'csharp' | 'typescript';
export interface LanguageServerDescriptor {
  id: LanguageId;
  filePattern: RegExp;              // /\.cs$/i | /\.(ts|tsx|js|jsx)$/i
  projectMarkers: // 见阶段 2 共用类型
  languageIdFor(ext): string;       // csharp / typescript|typescriptreact|javascript|javascriptreact
  defaultServerCommand: string;     // 'csharp-ls' | 内置解析结果
  extraEnv?: Record<string,string>; // csharp: DOTNET_CLI_TELEMETRY_OPTOUT
  initializationOptions?: unknown;  // typescript: { hostInfo, tsserver: { fallbackPath }, preferences }
  formatDefaults: { tabSize: number; insertSpaces: boolean }; // csharp 4/false, typescript 2/true
  diagnosticWatchMs: number;        // default 5000（push 等待；csharp 无意义仍给值）
  promptSection: string;            // 每语言提示词段（中文，双向边界式）
}
export const LANGUAGES: Record<LanguageId, LanguageServerDescriptor>;
export function languageOfFile(filePath: string): LanguageId | undefined; // 扩展名路由
export function ensureBundledServerCommand(command: string, lang): string; // node <cli> 解析 + 失败回退
```

内置 bin 解析实现：以 `import.meta.url` 所在包为锚，向上 `createRequire(import.meta.url).resolve('typescript-language-server/package.json')` → 读 `bin` 首个值（`lib/cli.mjs`）→ 返回 `node <abs>`（win32 同样安全，绕过 .cmd/shell）。解析失败回退原 command 字符串并 warn。

验证：单测（languages.test.ts）——扩展名→语言（4 类 + 大小写）、bin 解析产物对应真实文件存在、语言→提示词段非空。

## 阶段 2：多语言项目探测 `workspace-resolver.ts`

- 标记类型化：`type ProjectMarker = { kind: 'suffix'; value: string } | { kind: 'filename'; value: string }`。
  - csharp: suffix 型 `.slnx/.sln/.csproj`；typescript: filename 型 `package.json/tsconfig.json/jsconfig.json`。
- 新增 `detectProjectLanguages(dir): Promise<Partial<Record<LanguageId,string>>>`（同步版 `detectProjectLanguagesSync`）：单次向上遍历，按层判定两组标记，记录**每语言最近命中目录**；语言齐了即停。
- 保留 `detectProjectRoot/detectProjectRootSync/resolveProjectRoot` 签名与语义（C# 回归锁不动），内部委托新函数取 `csharp` 字段。
- 新增 `resolveProjectRootFor(filePath, sessionCwd, lang)`：文件优先 → 该语言最近标记根 → 回退 session cwd（与 C# 现语义一致）。

验证：workspace-resolver.test.ts 增补 TS 用例（tsconfig 命中、package.json 命中、jsconfig 命中、纯散装 .ts 不命中、monorepo 双根、回退 cwd）；原 C# 用例不删不改。

## 阶段 3：server-manager 语言化

- `ServerManagerOptions` 增 `languageId`；构造时由注册表取 `extraEnv`（替换硬编码 DOTNET）、`initializationOptions`（csharp 保持 `{}`）、`formatDefaults` 暴露只读 getter、`diagnosticWatchMs`。
- initialize capabilities 维持现有客户端能力集（已覆盖 ts-ls 所需：hover/definition/references/documentSymbol/codeAction/completion/signatureHelp/formatting/rangeFormatting/rename/implementation；LSP 3.17 diagnostic 声明对 ts-ls 无害——其不实现 pull 即不会声明，探测自然回落）。
- **新增 server→client 请求 handler**（spawnProcess 内、listen() 前后皆可）：
  - `workspace/configuration`：遍历 `items`，`section === 'formattingOptions'` → `{ tabSize, insertSpaces }`（取该语言 formatDefaults）；其余返回 null；单值数组返回。
  - 同时兜底 `onRequest('window/workDoneProgress/create')` 回 `null`（若 ts-ls 发起，当前不请求 progress，仅防意外）。
- capability 探测（supportsPull/supportsWorkspaceDiagnostic）逻辑不动（ts-ls 两 false → 自动走 push 路径）。

验证：server-manager.test.ts 增补——workspace/configuration handler 返回形状；初始化选项含语言初始化参数；格式默认值 getter。

## 阶段 4：lsp-client 差异适配

1. **诊断等待（push-only）**：`diagnostics()` 的 push 分支改为：先 syncDocument → 若 `!manager.supportsPull`，轮询 `manager.getDiagnostics(uri)` 直至「该 uri 缓存已存在」或 `diagnosticWatchMs` 超时（interval 100ms；用 manager 新增 `hasDiagnostics(uri)` 判定「已推送过」，避免与「空诊断=[]」混淆）；超时返回当前缓存并 warn 一次（可配 logLevel 抑制）。pull 分支不动。
2. **format 选项**：`format()` 的 options 改由 `this.manager.formatDefaults` 提供（替代硬编码）。
3. **WorkspaceEdit 双形态归一**：新增私有 `collectFileEdits(edit)`：`changes`（uri→TextEdit[]）与 `documentChanges`（TextDocumentEdit[] / CreateFile/RenameFile/DeleteFile 跳过）统一为 `{filePath, edits}`；`codeAction()`、`organizeImports()`、`rename()` 改用它。
4. hover verbosity：不启用（保持最小面；ts 5.9 扩展留待未来）。

验证：lsp-client.test.ts 增补——push 等待命中缓存、超时返回、hasDiagnostics 语义、formatDefaults 生效、documentChanges 归一（含 TextDocumentEdit）。

## 阶段 5：池与路由

- `workspace-pool.ts`：键改为 `sessionId\0languageId\0resolve(root)`；`get(sessionId, languageId, root)`；`disposeSession` 前缀匹配不变。
- `index.ts`：
  - `resolveWorkspace`：`languageOfFile(filePath)`；无文件（workspace_diagnostics）时 `detectProjectLanguages(cwd)`——单语言取之，双语言按配置顺序取 csharp 优先（文档说明）；根解析用 `resolveProjectRootFor`；错误文案改为「无法确定项目根目录（C# 或 TS/JS）……」。
  - 工厂：按语言取描述符构造 ServerManager（command 经 `ensureBundledServerCommand`，仅 languages 内置语言生效；用户 `serverCommand` 覆盖则原样使用）。
  - tools/result hook 正则 `/\.(cs|ts|tsx|js|jsx)$/i`；诊断注入文案保留格式。
- 契约 D 测试夹具路径是 .cs——仍走 csharp 分支，无需改；补一条 TS 路由契约（可选，用 mock manager）。

验证：workspace-pool.test.ts 键含语言维；index.test.ts/contract.test.ts 全绿。

## 阶段 6：工具描述诚实化（tools.ts）

- 全部 14 个 description 中性化：语言示例双写（如 `CS0029`/`TS2322`）、`.cs` → `.cs/.ts/.tsx/.js/.jsx`（按工具语义）、注明「自动按文件语言路由」。
- 差异显式化：
  - `lsp_call_hierarchy`：注明「TS/JS 可用；C# 受 csharp-ls 0.26.0 限制返回服务器错误」。
  - `lsp_organize_imports`：注明「TS/JS 会删除未使用 import；C# 不删（csharp-ls 限制，清理走 diagnostics+code_action）」。
  - `lsp_workspace_diagnostics`：注明「仅覆盖已探明文件（TS/JS 无 workspace/diagnostic pull，语义同 C# push 聚合）」。
  - `lsp_diagnostics`：补「TS/JS 为推送式诊断，等待服务器返回」。
- 不改变任何 parameters/schema/输出形状（契约 A/B/C 约束）。

验证：contract.test.ts 全绿；手工 grep 确认无残留「未知语言」硬编码描述。

## 阶段 7：提示词分段注入（prompt.ts）

- `LSP_TOOLS_PROMPT` 按语言拆为 `csharp`/`typescript` 两段（结构同构、边界双向、中文）：
  - TS 段要点：符号级问题走 lsp_*；编辑 `.ts/.tsx/.js/.jsx` 后 diagnostics 零错误判据；callHierarchy 可用；organize_imports 会删未使用；文本搜索仍用 grep/read。
- text 回调改 `detectProjectLanguagesSync(cwd)`：命中语言集合 → 对应段按序拼接（csharp 在前，保持既有 order 125 不动），无一命中返回空串。

验证：prompt 相关单测（index.test.ts/prompt 用例）——C# 目录注入 C# 段、TS 目录注入 TS 段、monorepo 双段、非项目空串。

## 阶段 8：集成测试（真实进程）

夹具：
- `test-project-ts/`：`tsconfig.json`（strict）+ `src/math.ts`（导出函数）+ `src/app.ts`（引用 math + 一个故意错误：`const x: number = 's'` TS2322）+ 一处未使用 import + 可重命名符号。
- `test-project-js/`：`jsconfig.json`（checkJs:true）+ `a.js`（JSDoc 类型 + 一个 checkJs 错误）。

集成测试 `__tests__/integration/typescript-ls.integration.test.ts`（复用现有 csharp 集成测试骨架：懒启动 → 14 工具逐项；重点：hover/definition/references（跨文件）/documentSymbols/callHierarchy（真实现）/completion/signature/format/rename（编辑计划）/organizeImports（删未使用）/codeAction（TS2322 有 quickfix）/diagnostics（推送到位）/workspaceDiagnostics（探明文件聚合）；jsconfig 工程验证 JS+checkJs 诊断）。
- 考虑 ts-ls 首次项目加载时长：testTimeout 沿用 60s。

验证：`pnpm test:integration` 两组全绿。

## 阶段 9：文档与收尾

- README：前置条件改「C# 需 .NET SDK/csharp-ls；TS/JS 内置无需安装」；特性/工具表/架构图补多语言与路由说明；配置表补 `diagnosticWatchMs`。
- STATUS.md：按约定更新（部署前状态）。
- docs/goal-tsjs.md：五轮决策封档；analysis/plan 交叉引用。
- 全量验证：`pnpm typecheck` + `pnpm test` + `pnpm test:integration`。

## 阶段 10：部署仪式（用户已确认，最后执行）

1. `git add` 具体路径 → 单逻辑提交（简体中文 conventional message，如 `feat(lsp): 新增 TypeScript/JavaScript 语言支持（14 工具全量路由 + 注册表架构）`）→ push origin main。
2. web profile（`~/.dsh/profiles/web`）：`package.json` 依赖已引用 git 仓库（commit 前进为默认）→ `pnpm update @echocore/dsh-lsp-client` 重解析 → lockfile 前进至新 commit。
3. `pnpm-workspace.yaml` allowBuilds 键更新为**新 codeload hash**（以 pnpm 报错打印的精确形式为准）→ `pnpm install --dir ~/.dsh/profiles/web`。
4. `dsh plugin --profile web install` 对账 bundles；核验 symlink 指向新构建 + `lib/` 含语言注册表产物。
5. 重启 DSH（后台分离方式 + 日志落盘 `%TEMP%`），等待健康检查 ok。
6. 冒烟（重启后的新会话/进程）：TS 项目目录内验证 `lsp:tools` 注入 TS 段；调用 hover/diagnostics/document_symbols/rename 等；记录证据。**注意：重启会中断当前会话**，部署队在完成 1-5 后由独立进程执行，结果落日志文件。
7. 若冒烟失败：回滚 = 保留旧 lockfile 形式重新 install + 重启（DEPLOY rollback 记录）；报告失败原因与工作区状态，不 push 修复式提交。

## 验收标准（实现完成判定）

- [ ] 单测全量绿（166 + 新增 ≥ 若干，以实际为准），契约 A/B/C/D 未放宽
- [ ] `pnpm typecheck` 零错误
- [ ] 集成测试 C# + TS（tsconfig/jsconfig）全绿
- [ ] 14 工具 description 无「仅 C#」歧义；prompt 按语言注入单测覆盖
- [ ] 真实会话冒烟证据落盘（注入 + ≥6 个工具的返回）
- [ ] STATUS.md/README/docs 已更新且一致
- [ ] 部署后 allowBuilds/lockfile 与实际安装产物对账一致

## 风险登记（执行中动态更新）

- R1 workspace/configuration 形状与 ts-ls 实测不符 → 集成测试首轮暴露，回看协议日志修正。
- R2 诊断等待超时设置过短（大项目首次加载）→ diagnosticWatchMs 可配置；集成测试用 60s 链路观察。
- R3 typescript 内置版本与工作区版本差异 → 工作区优先为默认；内置仅兜底。
- R4 部署仪式破坏运行中 DSH → 部署独立进程 + 日志落盘 + 回滚方案（阶段 10-7）。