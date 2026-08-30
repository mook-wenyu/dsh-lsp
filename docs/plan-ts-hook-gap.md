# 消除 D1-D4：TS/JS 编辑后诊断 hook 可靠性改造实现计划

> 状态：**执行完成（2026-08-26）**——单测 206/206、集成 29 过 1 跳过、typecheck/build 通过
> 关联：`docs/analysis-ts-hook-gap.md`（差距分析）、`docs/analysis-tsjs.md`、`docs/plan-tsjs.md`
> 目标：消除已识别的 4 项差距
> - D1 异步诊断丢失：TS push-only 首次等待空后冷却吞掉晚到诊断
> - D2 陈旧诊断：编辑后可能读到旧缓存诊断
> - D3 规范通道：`tools/result + steer()` → `tools/post-execute + additionalContexts` / `agent.inject()`
> - D4 测试缺口：无 tools/result/post-execute hook 与 TS 编辑后诊断回归测试

## 方案

1. **D2（客户端 eager-clear）**
   - `LspServerManager` 新增 `clearDiagnostics(uri)`。
   - `LspClient.syncDocument()` 发送 `didChange` 后调用 `manager.clearDiagnostics(uri)`，使后续 `waitForPushDiagnostics` 不会读到编辑前旧缓存。
   - 不依赖 typescript-language-server 是否支持 `diagnostics.eagerClear`（5.3.0 本地未见该选项，客户端清除已达同等效果）。

2. **D1 + D3（hook 通道改造）**
   - `src/index.ts` 移除 `tools/result + agent.steer()` 旧 hook。
   - 注册 `tools/post-execute` waterfall：
     - 只处理非 `lsp_*` 工具、成功结果、参数含 `file_path`/`path` 且匹配代码文件扩展名。
     - 内联短等待诊断（默认 1000ms，C# pull 立即返回）：
       - 有错误且 fingerprint 新 → 返回 `{ kind: 'accept', additionalContexts: [createUserMessage(...)] }`，诊断随工具结果进入模型上下文。
       - 无错误/超时 → 返回 `next()`（保持原结果）。
     - 对 push-only（TS/JS）且内联未拿到新诊断时，启动**晚到补注**后台任务：
       - 继续用完整 `diagnosticWatchMs` 等待；一旦出现新错误 fingerprint，调用 `agent.inject(createUserMessage(...))` 补注。
       - 去重：沿用 `lastDiagnosticFingerprints`；晚到补注不受 30s cooldown 限制（同一编辑只补一次）。
       - 失败静默，不阻塞工具主流程。
   - 依赖 `createUserMessage`：新增 `@deepseek-ai/dsh-llm` peerDependency + devDependency（宿主 DSH 必含，版本 ^0.1.0-rc.8）。

3. **D4（测试）**
   - `__tests__/index.test.ts`：mock `ctx.on` 捕获 `tools/post-execute` listener；验证编辑工具触发诊断附加 `additionalContexts`、非编辑/失败/`lsp_*` 不触发、TS 晚到补注调用 `agent.inject`。
   - `__tests__/server-manager.test.ts`：`clearDiagnostics` 行为。
   - `__tests__/lsp-client.test.ts`：didChange 后旧缓存被清除；`diagnostics()` 支持调用方等待超时参数（供内联短等待使用）。

## 验证结果（2026-08-26 实测）

1. `pnpm typecheck` ✅ 零错误。
2. `pnpm test` ✅ **206/206**（新增：post-execute 内联附加/晚到补注/非编辑不触发；clearDiagnostics；didChange 清缓存；waitMs 覆盖）。
3. `pnpm test:integration` ✅ **29 过 1 跳过**（TS 16/16 + C# 13 过 1 跳过，与基线一致）。
4. `pnpm build` ✅ 构建成功。
5. `git diff --stat` 已审查：10 个文件 + 2 个新文档，改动均对应 D1-D4。

## 风险

- `tools/post-execute` 内联等待会延迟编辑工具结果最多 1000ms（仅 TS/JS；C# pull 立即返回）。若不可接受，可调小/改为纯后台注入。
- 新增 peer dependency 需要宿主已有 dsh-llm（DSH 必有）；测试环境需 `pnpm install` 解析。
- `createUserMessage` 生成的 id 是唯一身份，晚到补注与内联上下文不会与已有消息冲突。

## 后续记录（2026-08-29~30）

- 针对自定义 Agent 未注入 `lsp:tools`，曾尝试把注入通道改为 `systemPrompt.section`（部署 `ad8793c`），实测仍无效后按用户要求回退为 `systemPrompt.context`（部署 `6974f85`）。
- 完整结论见 `docs/analysis-ts-hook-gap.md` §11：自定义 Agent 的屏蔽更可能是 complete 完整提示词/作用域问题，非插件通道问题。