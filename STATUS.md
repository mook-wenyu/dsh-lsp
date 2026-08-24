# STATUS — dsh-lsp

> 更新：2026-08-24（会话收尾）· main @ 9fecec1 · CI 绿 · 157/157 本地与 CI 双绿

## 一、架构健康度

- 模块总数：8（src/index、tools、lsp-client、server-manager、workspace-pool、workspace-resolver、prompt、types），依赖方向单向：index → tools/lsp-client/pool/resolver/prompt，无环。
- 已知能力边界：`lsp_call_hierarchy` 受 csharp-ls 0.26.0 限制（服务端不声明能力，容错返回错误提示），非缺陷。

## 二、本次变更影响范围

- `package.json`：新增 `packageManager: pnpm@11.21.0`（修复 pnpm/action-setup 缺版本号致 CI 秒挂）。
- `.github/workflows/ci.yml`：runner ubuntu-latest → windows-latest（对齐测试的 Windows 路径语义与实际部署目标）。
- `__tests__/contract.test.ts`：契约 D 回归锁夹具路径由拆分前 EchoCore 绝对路径改为相对本仓库 `import.meta.url` 定位——该测试在 f60c97f 拆分删除夹具后已是必败测试（本地复现确认），交接文档"157 全绿"为拆分前旧状态。
- 接口契约变化：无（生产代码零改动，全部为 CI/测试层）。

## 三、已知风险点

- 测试套件语义绑定 Windows 单平台（file URI ↔ 盘符路径断言等）；若未来要支持 Linux 宿主需先做跨平台化改造。
- profile 的 `pnpm-workspace.yaml` allowBuilds 白名单键含精确 commit hash：下次 push 生产代码后更新 profile 依赖时必须同步换 hash 再 install。
- 提示词边界式条件注入的行为面（A/B 工具选中率 ×3 取样）尚未验收，静态面已闭环。

## 四、下次最该做的事

1. 行为 A/B 验收：在 C# 会话（cwd 位于含 .csproj 的目录，如本仓库 test-project 或真实 C# 项目）发「查 Dog 所有引用 + Speak 改名 MakeSound + 确认编译干净」×3 取样，统计 lsp_references/rename/diagnostics 主动选中次数。
2. 通过后将验收结论同步 EchoCore 侧 STATUS.md 与记忆。

## 附：2026-08-24 静态验收证据链（边界式条件注入 ec81bdc）

- 运行实例 PID 38184 启动 14:09:28 > profile 新构建落盘 14:04:32 → 生产已加载新代码。
- 反例实证：本会话 cwd=TS 仓库根，系统上下文无 `lsp:tools` 段（旧版无条件注入下必然出现，故为零注入直接证据）。
- 正例实证：以部署产物走完整生产路径（installLspPrompt → systemPrompt.context 回调 → detectProjectRootSync）：cwd=`test-project` 注入完整双向文本，cwd=仓库根返回空串；段名/排序 `lsp:tools`/125。
- 勘误：交接文档"新建 EchoCore 会话应有注入"预期有误——探测仅向上遍历且 EchoCore 全树无 C# 项目文件，EchoCore 会话零注入是正确行为；正例应为 cwd 位于 C# 项目目录内。
