# STATUS — dsh-lsp

> 更新：2026-08-24（第四次：崩溃根因修复完成，源码+测试+lib 已重建，待 web profile 部署）· 部署构建仍 105714c · 162/162 本地全绿

## 一、架构健康度

- 模块总数：8（src/index、tools、lsp-client、server-manager、workspace-pool、workspace-resolver、prompt、types），依赖方向单向：index → tools/lsp-client/pool/resolver/prompt，无环。
- 已知能力边界：`lsp_call_hierarchy` 受 csharp-ls 0.26.0 限制（服务端不声明能力，容错返回错误提示），非缺陷。

## 二、本次变更影响范围

### 第一批（CI 修复链，生产代码零改动）

- `package.json`：新增 `packageManager: pnpm@11.21.0`（修复 pnpm/action-setup 缺版本号致 CI 秒挂）。
- `.github/workflows/ci.yml`：runner ubuntu-latest → windows-latest（对齐测试的 Windows 路径语义与实际部署目标）。
- `__tests__/contract.test.ts`：契约 D 回归锁夹具路径由拆分前 EchoCore 绝对路径改为相对本仓库 `import.meta.url` 定位——该测试在 f60c97f 拆分删除夹具后已是必败测试（本地复现确认），交接文档"157 全绿"为拆分前旧状态。

### 第二批（真实项目验证驱动，eec34aa + e15d617）

用户在真实 C# 项目（1810 个 .cs，只读）完成 14 工具全量验证：12 通过 / call_hierarchy 预期失败 / workspace_diagnostics 恒空。rename 双重交叉验证（123 处/56 文件与 references 精确一致；私有字段 9 处与 grep 一致）证明符号级操作可信。据此：

- **Bug G 根因修复（eec34aa）**：workspace_diagnostics 恒空的因果链 = 它只读 push 缓存 → 缓存仅被 publishDiagnostics 通知喂入 → csharp-ls 主用 pull 路径的结果从不落缓存。修复：`server-manager.updateDiagnosticsCache()` 新增写入口，pull 成功结果写入统一缓存（干净文件写空数组）；连带修复 `workspaceDiagnostics()` 中未绑定的 `map(this.formatDiagnostic)`（缓存非空时必炸的潜伏缺陷，被新回归测试首次暴露）。新增 Bug G 回归锁测试。
- **工具描述诚实化（e15d617）**：organize_imports 注明不删除未使用 using（csharp-ls 限制，清理走 CS8019+code_action）、signature 注明需括号内光标且构造函数可能无返回、workspace_diagnostics 语义改为"已探明文件的最近诊断"。
- 接口契约变化：无 schema 变更；工具 description 文本变化随下次 profile 更新生效。

### 第三批（崩溃根因修复，源码+测试+lib 已重建，待部署）

- **症状**：宿主 `fatal load failure: Error [ERR_STREAM_DESTROYED]: Cannot call write after a stream was destroyed`，栈在 vscode-jsonrpc `StreamMessageWriter.doWrite`，发生在 dsh-lsp-client 向 csharp-ls 子进程 stdin 写入时。先打印 `textDocument/diagnostic (pull model) 不支持` 说明崩溃前连接还活着（拿到了正常的 Method-not-found），随后 csharp-ls 死亡致下一次写入命中死流。
- **根因因果链**：csharp-ls 子进程死亡（崩溃/OOM）→ `child.stdin` 销毁；`LspServerManager` 在 `onClose`/`exit` 时**不废弃 `this.connection`**（`cleanupProcess` 未置空），且 `syncDocument` 的 didOpen/didChange、`initializeHandshake` 的 `initialized`、`dispose` 的 `exit` 等 `sendNotification` 均为 **fire-and-forget（不 await、无 `.catch`）**。写入死流触发 `doWrite` 拒绝该 Promise → **未处理 Promise 拒绝** → Node 终止宿主进程。
- **修复**（src/server-manager.ts、src/lsp-client.ts，均带中文根因注释）：
  1. `cleanupProcess()` 中 dispose 并置空 `this.connection` → 死亡后 `activeConnection` 返回 null，`LspClient.connection` getter 抛干净的"未就绪"，后续不再写入死流。
  2. 所有 fire-and-forget `sendNotification` 加 `.catch(() => {})`，瞬时/致命写入失败不会变成未处理拒绝使宿主崩溃。
  3. `dispose()` 的 `connection.dispose()` 包进 try/catch（原在 try 外，死流可抛）。
  4. `scheduleRestart()` 幂等（exit 与 onClose 双触发避免拉起多个 csharp-ls）。
- **回归测试**：`__tests__/server-manager.test.ts`（子进程退出后连接废弃、握手 initialized 通知失败不抛未处理拒绝、dispose 时连接已销毁不异常）、`__tests__/lsp-client.test.ts`（didOpen 通知失败不抛未处理拒绝）。162 测试全绿，`tsc --noEmit` 通过；`lib/` 已 `npm run build` 重建，**尚未部署到 web profile**。
- 接口契约变化：无。

## 三、已知风险点

- **部署滞后（本次崩溃修复未部署）**：lib/ 已重建但 web profile 仍跑旧构建（105714c）；修复经 `dsh plugin --profile web install` 对账回填 bundles 后方可生效。**禁止裸 `pnpm install`**（不触发 bundles 对账，会静默丢失插件）。
- ~~部署滞后~~ **已部署（2026-08-24 15:06）**：allowBuilds 键更新为 pnpm 实际解析形式（codeload tarball @105714c——git 依赖被锁文件钉在旧 hash 时需 `pnpm update <pkg>` 重解析，简单包名键对 git 依赖无效）；新实例 PID 18352 加载新构建，冒烟验证通过。后续 push 后 lockfile 仍钉 105714c，下次更新重复此流程。
- 测试套件语义绑定 Windows 单平台（file URI ↔ 盘符路径断言等）；若未来要支持 Linux 宿主需先做跨平台化改造。
- signature 对构造函数调用无返回、organize_imports 不删未使用：均为 csharp-ls 服务端能力边界，已写入描述与 README，无法客户端修复。

## 四、下次最该做的事

1. **部署本次崩溃修复**：经 `dsh plugin --profile web install` 重新构建并回填 bundles（禁用裸 `pnpm install`），重启 DSH 后复验——触发一次 lsp_* 调用使 csharp-ls 在其后崩溃（或手动 kill 子进程），确认宿主不再 `fatal load failure`，且 csharp-ls 自动重启恢复。
2. Bug G 生产配对复验（可选）：在 cwd 位于 C# 项目内的会话调 diagnostics → workspace_diagnostics，确认聚合非恒空（本会话 cwd 不在 C# 项目内，池键不匹配无法自验）。
3. （可选）多语言化设计文档：LanguageServerRegistry 抽象。

## 附：2026-08-24 部署记录

- allowBuilds 键三态迭代后锁定为 pnpm 打印的精确形式 `@echocore/dsh-lsp-client@https://codeload.github.com/.../tar.gz/105714c...`；`pnpm update` 重解析 + install 构建成功，symlink 由 `gi_67b4f...`（#3d51b5b）切至 `ht_84b5d1...`（105714c）。
- 重启经分离助手完成：杀旧实例 PID 42744 → 新实例 PID 18352（15:06:17 > 构建落盘 15:04:39）→ 健康检查 ok；日志 `%TEMP%\dsh-restart-result.txt`、`%TEMP%\dsh-web-stdout.log`。
- 冒烟（新进程内）：lsp_document_symbols(test-project/Program.cs) 符号树完整；lsp_diagnostics 干净零诊断（pull 路径正常）。

## 附：2026-08-24 行为面验收结论

原定 A/B ×3 取样协议被更有力的证据取代：用户主导的真实 C# 项目会话中，模型面对真实任务链主动、正确地选用了 references/definition/hover/implement/completion/signature/diagnostics/code_action/rename/format/document_symbols 等 12 个 lsp_* 工具并产出交叉验证级精度——注入提示词的生产行为面视为已验证。

## 附：2026-08-24 静态验收证据链（边界式条件注入 ec81bdc）

- 运行实例 PID 38184 启动 14:09:28 > profile 新构建落盘 14:04:32 → 生产已加载新代码。
- 反例实证：本会话 cwd=TS 仓库根，系统上下文无 `lsp:tools` 段（旧版无条件注入下必然出现，故为零注入直接证据）。
- 正例实证：以部署产物走完整生产路径（installLspPrompt → systemPrompt.context 回调 → detectProjectRootSync）：cwd=`test-project` 注入完整双向文本，cwd=仓库根返回空串；段名/排序 `lsp:tools`/125。
- 勘误：交接文档"新建 EchoCore 会话应有注入"预期有误——探测仅向上遍历且 EchoCore 全树无 C# 项目文件，EchoCore 会话零注入是正确行为；正例应为 cwd 位于 C# 项目目录内。
