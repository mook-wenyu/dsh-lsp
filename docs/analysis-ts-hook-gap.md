# dsh-lsp TS/JS 与 C# 的「系统提示词导入 / 会话可编辑 / 诊断 hook」差距分析与消除

> 状态：**分析完成、D1-D4 已消除（2026-08-26）**——单测 206/206、集成 29 过 1 跳过
> 关联：`docs/analysis-tsjs.md`、`docs/goal-tsjs.md`、`docs/plan-tsjs.md`、`docs/plan-ts-hook-gap.md`、`STATUS.md`
> 本文件按用户要求每轮问答后更新，避免上下文丢失。

## 1. 用户原始描述

> ts 好像没有系统提示词导入会话可编辑后诊断hook啊；分析与C#的差距；全面深度检索所有代码、深度分析；网络搜索最新技术、权威文档、权威论文和最佳工程实践。深度思考、反思，梳理分析需求。不懂就必须问我，一问一答；同时说清楚你为什么要问该问题；每轮问答后更新项目文档，避免上下文丢失。直到我对你的目标有明确的认知后，出深度分析报告与完备的实现计划。再开始执行。

用户随后补充了一条实际 hook 输出：

```
[lsp] 编辑后发现 4 个编译错误：\n  行182: [2493] ... 行183: [2493] ... 行192: [2352] ... 行192: [2493] ...\n使用 lsp_diagnostics + lsp_code_action 验证和修复。
```

该输出证明 **TS 的编辑后诊断 hook 在当前代码中已实际触发**（格式与 `src/index.ts` 的 tools/result hook 完全一致，诊断码 2493/2352 为 TypeScript）。

## 2. 本地代码事实（已核实）

### 2.1 系统提示词导入（prompt.ts + languages.ts）

- `src/prompt.ts` 注册 `systemPrompt.context` 段 `lsp:tools`（order 125；2026-08-29 曾短暂改为 section 验证自定义 Agent，实测无效后已回退 context）。
- text 回调使用 `assembly.agent?.session?.header?.cwd` 同步探测 `detectProjectLanguagesSync(cwd)`。
- `src/languages.ts` 的 `typescript` 描述符含 `promptSection`（`## TS/JS LSP 工具（14 个）...`）。
- 实测：`detectProjectLanguagesSync('D:\\TSProjects\\dsh-lsp')` 返回 `{"typescript":"D:\\TSProjects\\dsh-lsp"}`，即当前 TS 工程会被识别并应注入 TS 段。

### 2.2 会话可编辑 / 编辑工具路径提取

- 当前 hook 从 `exec.arguments.file_path ?? exec.arguments.path` 提取被编辑文件。
- DSH 官方内置工具：
  - `write` / `edit`（`@deepseek-ai/dsh-tool-fs`）：参数为 `file_path`。
  - `str_replace_editor`（`@deepseek-ai/dsh-tool-str-replace-editor`）：参数为 `path`。
  - 因此当前提取逻辑覆盖 DSH 两套编辑工具。
- `ToolExecution` 类型（`@deepseek-ai/dsh-tools`）确认真实字段为 `arguments` 与 `agent`，与代码假设一致。

### 2.3 编辑后诊断 hook（index.ts）

- hook 监听 `tools/result`（实时只读事件），跳过 `lsp_*` 工具，正则 `/\.(cs|ts|tsx|js|jsx)$/i`。
- 处理流程：cooldown 30s → `resolveWorkspace(filePath)` → `manager.start()` → `client.diagnostics(filePath)` → 有 error 且 fingerprint 变化 → `agent.steer()` 注入文本。
- 对 C# 与 TS 代码路径完全相同，仅 `client.diagnostics()` 内部行为不同：
  - C#：pull 同步返回。
  - TS：push-only，`waitForPushDiagnostics` 轮询缓存，最多等 `diagnosticWatchMs`（默认 5000ms），稳定窗口 300ms。
- **测试缺口**：`__tests__/index.test.ts` 未覆盖 tools/result hook；也没有 TS 编辑后 hook 的单元/集成测试。

## 3. 已发现的可疑差距（假设，待用户确认）

1. **诊断 hook 的 TS 异步丢结果风险**
   - TS 编辑后诊断是异步 push。当前 hook 只调用一次 `diagnostics()`，若首次等待超时/未命中（冷启动、大项目），返回空数组，hook 直接 return。
   - 随后 `diagnosticCooldown` 已写入，30 秒内再次编辑不会重试；即使诊断晚到也不补注。
   - C# 是 pull 同步，无此问题。
2. **陈旧诊断风险**
   - typescript-language-server 5.3.0 是否支持 `diagnostics.eagerClear` 未在本地包确认（在线资料显示该选项于 2026-05 加入，版本待查）；当前也未初始化该选项。
   - 若无 eagerClear，编辑后到新诊断到达之间，`diagnostics()` 可能读到旧诊断，agent 会被误导。
3. **注入通道差异**
   - 当前 hook 用 `agent.steer()` 在 `tools/result` 中注入。
   - DSH 官方更推荐 `tools/post-execute` 通过 `additionalContexts` 附加模型可见上下文，或 `agent.inject()` 排队 durable context；`tools/result` 是 observe-only，`steer()` 会强制再跑一轮，可能打断正常流程。
   - 该问题对 C# 同样存在，但 TS 慢诊断使风险更明显。
4. **系统提示词“导入会话”是否真的缺失**
   - 代码层面 TS 与 C# 共用 prompt 注入；但用户观察到的“没有”可能是 `assembly.agent.session.header.cwd` 为空、DSH 组装时机、profile 未加载新构建等环境因素，而非代码缺失。
   - 需要用户提供“没有系统提示词导入”的具体证据（例如系统提示词内容、会话 cwd、注入日志）。

## 4. 外部调研摘要

- **DSH/Cordis 官方机制**（extension-cookbook 等）：
  - `tools/result` = 只读观测不可变最终结果；`tools/post-execute` = 可替换结果/附加上下文；`agent.inject()` = 排队 durable context；`agent.steer()` = 强制继续/插入下一轮。
  - hook 系统监听点：`agent/session-start`、`agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`。
  - 会话事件：`tool/result` 是持久事件，`tools/result` 是实时事件。
- **TS push 诊断最佳实践**：
  - Microsoft TypeScript PR #63921：客户端未声明 pull 时，服务器 per-file push；didChange 后 debounced 更新。
  - typescript-language-server #1064 `diagnostics.eagerClear`：在 didChange 后立即清诊断，防止 agentic/headless 客户端读到陈旧诊断（默认 false）。
  - opencode / oh-my-pi 等实现 `waitForFreshPush`：按 push 版本/时间戳等待“新鲜”诊断，而非简单等“有缓存”。
- **post-edit 诊断 hook 工程模式**（DeepSeek-TUI、archcode、superqode、oh-my-openagent）：编辑工具完成后提取文件路径 → 请求 LSP 诊断 → 把结果作为附加上下文注入模型；失败静默。

## 5. 待澄清问题（当前队列）

1. 用户所说的“TS 好像没有系统提示词导入会话可编辑后诊断hook”，具体缺哪个环节？
   - A. 系统提示词里没有出现 `## TS/JS LSP 工具` 段（提示词导入缺失）
   - B. 编辑 .ts 后没有自动收到 `[lsp] 编辑后发现...`（诊断 hook 缺失）
   - C. 编辑 .ts 后诊断虽然收到，但延迟/陈旧/丢结果，体验与 C# 有差距
   - D. 其他：期望的“会话可编辑后诊断 hook”是另一种 DSH 机制（tools/post-execute additionalContexts / agent.inject 等）

## 6. 下一步

- ✅ 已按用户“消除 D1-D4”完成实现（见第 9 节与 `docs/plan-ts-hook-gap.md`）。
- 待部署：按项目部署仪式推进（commit/push → profile lockfile → allowBuilds → install → 重启 → 冒烟）。

## 7. Q&A 决策记录（2026-08-26 第 1 轮）

| 轮次 | 问题 | 用户回答 | 主代理判断 | 落点 |
|---|---|---|---|---|
| 1 | 具体缺哪个环节（提示词导入 / 收不到诊断 / 延迟陈旧 / 更规范 hook 通道） | 未选项，回复“你觉得没问题那就算了吧” | **核心功能无缺失**：TS 与 C# 共用 prompt 注入与 tools/result hook，用户贴出的 hook 输出证明 TS 编辑后诊断已触发；当前 cwd 检测命中 typescript。已认知的差异属“增强项/风险”，不是“没有”。 | 本轮不做实现；保留差距清单供后续自愿优化 |

## 8. 最终结论（本轮）

1. **TS 并没有“没有系统提示词导入 / 会话可编辑 / 诊断 hook”**：
   - 系统提示词导入：`prompt.ts` 按语言注册表注入 TS 段，当前 TS 工程检测命中。
   - 会话可编辑：DSH `write/edit` 的 `file_path` 与 `str_replace_editor` 的 `path` 均被 hook 覆盖。
   - 诊断 hook：`tools/result` hook 正则已含 `.ts/.tsx/.js/.jsx`，用户贴出的 `[lsp] 编辑后发现 4 个编译错误` 为直接证据。
2. **与 C# 的真实差距（非缺失，按优先级排序）**：
   - D1 异步诊断丢失风险：TS push-only，hook 单次等 5s；超时/冷启动返回空后 30s 冷却吞掉晚到诊断。
   - D2 陈旧诊断风险：未启用 `diagnostics.eagerClear`（若服务器版本支持），编辑后可能短暂读到旧诊断。
   - D3 规范通道：现用 `tools/result + steer()`；DSH 更推荐 `tools/post-execute + additionalContexts` 或 `agent.inject()`。
   - D4 测试缺口：`index.test.ts` 未覆盖 tools/result hook，也无 TS 编辑后 hook 回归测试。
3. **本轮不做实现**，风险项保留在本文档，供用户后续决定是否优化。

## 9. 消除 D1-D4 实施记录（2026-08-26）

用户在上一轮回复“消除 D1-D4”，按 `docs/plan-ts-hook-gap.md` 完成：

| 项 | 实现 |
|---|---|
| D1 异步诊断丢失 | `tools/post-execute` 内联短等待 1000ms + push-only 晚到后台补注 `agent.inject()`；同一编辑去重（fingerprint），不再被 30s 冷却吞掉 |
| D2 陈旧诊断 | `LspServerManager.clearDiagnostics()` + `LspClient.syncDocument()` didChange 后清除旧缓存（客户端 eager-clear，不依赖服务器版本） |
| D3 规范通道 | 旧 `tools/result + steer()` 移除；改为 `tools/post-execute` 返回 `additionalContexts`（内联命中）或 `agent.inject()`（晚到补注）；新增 `@deepseek-ai/dsh-llm` peer/dev 依赖以使用 `createUserMessage` |
| D4 测试缺口 | 新增 index.test.ts 3 个 hook 测试、server-manager.test.ts clearDiagnostics、lsp-client.test.ts didChange 清缓存 + waitMs 覆盖；单测 206/206 |

验证：`pnpm typecheck` 零错误；`pnpm test` 206/206；`pnpm test:integration` 29 过 1 跳过；`pnpm build` 成功。

## 10. Q&A：UI 未显示系统提示词注入是否正常（2026-08-26）

用户反馈“C# 和 TS LSP 都没有注入系统提示词”，进一步澄清为“只是 DSH UI 没看到”。

结论：
- C# 未注入在当前 cwd（`D:\TSProjects\dsh-lsp`）下**正常**：无 `.csproj/.sln/.slnx`，设计为零注入。
- TS 未注入在 UI 层面**不能判定异常**：安装产物已确认含 `installLspPrompt`/`lsp:tools`/TS 段，且当前 cwd 探测命中 TS；`systemPrompt.context` 是动态 runtime-context，进入模型历史但不一定显示在 UI 系统提示词区。
- hook 正常：`tools/post-execute` 已部署，单测/集成覆盖，用户此前贴出的 `[lsp] 编辑后发现...` 是实际触发证据。
- 确证方法：查看 DSH Trajectory/会话日志中的 `TS/JS LSP 工具` / `lsp:tools`。

## 11. section 方案尝试与回退（2026-08-29）

用户确认自定义 Agent cwd 为 `D:\TSProjects\dsh-lsp` 但仍无注入 → 初步判断是 `lsp:tools` 走 `systemPrompt.context`（动态 runtime-context）被自定义 Agent 的 runtime-context 抑制。

尝试：`src/prompt.ts` 改用 `systemPrompt.section`（静态系统提示词段，不受 runtime-context 抑制影响），部署 `ad8793c` 并重启（PID 19028）。

结果：**自定义 Agent Trajectory 仍无 `TS/JS LSP 工具`** → section 方案无效，证明屏蔽不是 runtime-context 抑制；更可能是自定义 Agent 设置了 `complete` 完整系统提示词（会覆盖所有 section），或作用域未合并全局上下文。

处置：按用户要求**回退为 `systemPrompt.context`**（预设 Agent 恢复原行为）。后续若需解决自定义 Agent 注入，应从自定义 Agent 的 `complete` 段/作用域配置入手，而非插件通道。