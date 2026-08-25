# @echocore/dsh-lsp-client

DSH LSP 客户端插件：为 AI 代理提供语言服务器协议（LSP）能力——悬停、跳转定义、查找引用、编译诊断、文档符号、调用层级分析等 14 个工具，**按文件语言自动路由**（C# 与 TypeScript/JavaScript）。

## 特性

- **14 个 LSP 工具**：覆盖符号级理解、编辑辅助、重构与诊断全链路
- **多语言注册表（LanguageServerRegistry）**：`.cs` → csharp-ls；`.ts/.tsx/.js/.jsx` → typescript-language-server（tsserver）；同会话 monorepo 各语言独立实例互不干扰
- **TS/JS 零安装**：typescript-language-server + typescript 随插件分发（bundled），无需全局安装；项目自带 typescript 时自动优先使用工作区版本
- **提示词边界式条件注入**：仅当会话 cwd 向上探测到项目文件标记时注入对应语言的 LSP 使用指引（C#：`.slnx/.sln/.csproj`；TS/JS：`package.json/tsconfig.json/jsconfig.json`），非项目会话零 token 占用；monorepo 多语言并行注入
- **多会话工作区隔离**：LspWorkspacePool 按会话 × 语言 × 项目根维护独立语言服务器实例
- **懒启动**：服务器在首次工具调用时拉起，`start()` 幂等
- **编辑后自动诊断**：监听 tools/post-execute 事件，编辑 `.cs/.ts/.tsx/.js/.jsx` 文件后自动注入诊断摘要（内联附加 additionalContexts；TS/JS push-only 晚到补注 agent.inject）

## 前置条件

- **C#**：.NET SDK 10+ 与全局 csharp-ls（`dotnet tool install --global csharp-ls`）
- **TS/JS**：无外部前置——服务器内置；工作区含 `node_modules/typescript` 时自动使用该版本，否则回退内置版本
- **DSH web profile**：已配置 Cordis 插件加载环境

## 安装

DSH web profile 以 git 依赖方式引用本包（已实证的流程）：

1. 在 profile 的 `package.json` 中添加依赖：
   ```json
   "@echocore/dsh-lsp-client": "github:mook-wenyu/dsh-lsp"
   ```
2. 在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 中放行构建脚本
   （安装时经 `prepare` 执行 tsc；键为 pnpm 报错时打印的精确形式，
   **本仓库 commit 前进后必须同步更新 hash** 再 `pnpm install`）：
   ```yaml
   allowBuilds:
     "@echocore/dsh-lsp-client@git+ssh://git@github.com/mook-wenyu/dsh-lsp.git#<commit>": true
   ```
3. 安装并重启 DSH：
   ```bash
   pnpm install --dir ~/.dsh/profiles/web
   # 或使用 dsh plugin update 后重启 DSH web profile
   ```

## 配置

### 方式一：settings.yaml 的 lsp 段

在 `~/.dsh/profiles/web/settings.yaml` 中添加：

```yaml
lsp:
  enabled: true
  serverCommand: csharp-ls          # 可选覆盖：对所有语言的服务器命令生效
  serverArgs: []
  workspaceRoot: /path/to/your/project
  startupTimeoutMs: 30000
  autoStart: false
  logLevel: warn
  # diagnosticWaitMs: 5000          # 可选：push-only 服务器（TS/JS）诊断等待上限
```

### 方式二：cordis.yml

在 `~/.dsh/profiles/web/cordis.yml` 中添加插件配置：

```yaml
- id: lsp-client
  name: '@echocore/dsh-lsp-client'
  config:
    enabled: true
    serverCommand: csharp-ls
    workspaceRoot: /path/to/csharp/project
    startupTimeoutMs: 30000
    autoStart: false
    logLevel: warn
```

### 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 LSP 客户端 |
| `serverCommand` | string | 按语言 | 覆盖语言服务器命令（默认：csharp-ls / 内置 typescript-language-server） |
| `serverArgs` | string[] | `[]` | 传递给 LSP server 的额外参数（覆盖时生效） |
| `workspaceRoot` | string | - | 可选：固定 LSP 工作区根目录；**未配置时按 file_path/session cwd 向上探测项目文件动态发现**（推荐省略） |
| `startupTimeoutMs` | number | `30000` | initialize 握手超时（毫秒） |
| `autoStart` | boolean | `false` | 插件加载时自动启动服务器 |
| `logLevel` | string | `'warn'` | 日志级别：off/error/warn/info/debug |
| `diagnosticWaitMs` | number | `5000` | push-only 服务器（TS/JS）诊断等待上限（毫秒） |

## 工具说明

插件注册 14 个 LSP 工具，供 AI 代理使用。**所有工具按 `file_path` 扩展名自动路由语言服务器**（`.cs` → csharp-ls；`.ts/.tsx/.js/.jsx` → typescript-language-server）：

| 工具名 | LSP 方法 | 用途 | 参数 |
|--------|----------|------|------|
| `lsp_hover` | `textDocument/hover` | 获取类型签名和文档注释 | `file_path`, `line`, `column` |
| `lsp_definition` | `textDocument/definition` | 跳转到符号定义位置 | `file_path`, `line`, `column` |
| `lsp_references` | `textDocument/references` | 查找符号的所有引用位置（语义级全量，优于文本搜索） | `file_path`, `line`, `column`, `include_declaration?` |
| `lsp_implement` | `textDocument/implementation` | 查找接口/抽象成员的实现位置 | `file_path`, `line`, `column` |
| `lsp_diagnostics` | pull（C#）或 push 等待（TS/JS） | 获取文件的编译诊断信息 | `file_path` |
| `lsp_document_symbols` | `textDocument/documentSymbol` | 以层级树列出文件中的所有符号 | `file_path` |
| `lsp_call_hierarchy` | `callHierarchy/prepare + incoming/outgoingCalls` | 分析方法的调用层级 ⚠️ 两服务器均为能力边界：csharp-ls 0.26.0 不声明；ts-ls 5.x 声明但不注册处理器，当前返回服务器错误 | `file_path`, `line`, `column` |
| `lsp_code_action` | `textDocument/codeAction` | 获取诊断位置的快速修复建议 | `file_path`, `line`, `column`, `end_line?`, `end_column?`, `diagnostic_code?`, `diagnostic_message?` |
| `lsp_completion` | `textDocument/completion` | 光标处智能补全 | `file_path`, `line`, `column` |
| `lsp_signature` | `textDocument/signatureHelp` | 调用处的方法签名与活跃参数；需光标在参数括号内，构造函数调用可能无返回 | `file_path`, `line`, `column` |
| `lsp_format` | `textDocument/formatting` / `rangeFormatting` | 格式化全文或指定范围，返回待应用的编辑列表 | `file_path`, `start_line?`, `end_line?` |
| `lsp_rename` | `textDocument/prepareRename + rename` | 符号重命名，返回跨文件编辑计划（不落盘） | `file_path`, `line`, `column`, `new_name` |
| `lsp_organize_imports` | `textDocument/codeAction`（source） | 整理导入：**TS/JS 会删除未使用 import（mode All）**；C# 不删未使用 using（csharp-ls 限制）——C# 清理走 diagnostics(CS8019) + code_action | `file_path` |
| `lsp_workspace_diagnostics` | 诊断缓存聚合（TS/JS 无 workspace pull，仅覆盖已探明文件） | 按文件分组汇总已探明文件（调用过 diagnostics 或收到推送）的最近诊断 | 无 |

**注意**：
- 所有行列号参数从 **0** 开始（0-indexed），文件路径必须是 **绝对路径**
- `rename`/`organize_imports`/`format` 返回编辑计划而非直接写盘，由调用方决定是否应用
- 工作区根目录未配置时按 `file_path` → session cwd 向上探测项目文件自动发现（C#：`.slnx/.sln/.csproj`；TS/JS：`package.json/tsconfig.json/jsconfig.json`）
- TS/JS 诊断为推送式（push-only）：首次调用会自动等待服务器推送（默认 5s，`diagnosticWaitMs` 可调）

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH Web GUI (Cordis)                     │
├─────────────────────────────────────────────────────────────┤
│  dsh-lsp-client 插件                                        │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │   index.ts      │───▶│  LspWorkspacePool               │ │
│  │  (Cordis 入口)   │    │  会话 × 语言 × 项目根 实例池     │ │
│  └────────┬────────┘    └───────────┬─────────────────────┘ │
│           │                        │ 按文件语言路由          │
│           ▼                        ▼                        │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │  languages.ts   │───▶│  LspServerManager × N           │ │
│  │ (语言注册表)     │    │  - csharp-ls（外部）.cs          │ │
│  │  - 扩展名路由    │    │  - typescript-language-server   │ │
│  │  - 项目标记      │    │    （内置 node <cli> --stdio）    │ │
│  │  - 启动解析/env  │    │  - workspace/configuration 应答 │ │
│  │  - 提示词段      │    └──────────────┬──────────────────┘ │
│  └────────┬────────┘                   │                    │
│           ▼                            ▼                    │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │    tools.ts     │───▶│        LspClient                │ │
│  │ (14个工具定义)   │    │   - hover/definition/references  │ │
│  └─────────────────┘    │   - 诊断：pull 或 push 等待       │ │
│                         │   - WorkspaceEdit 双形态归一      │ │
│                         └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 开发指南

### 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 类型检查
pnpm typecheck

# 运行测试
pnpm test
```

### 测试

```bash
# 运行所有单元测试（含生产契约防回归锁）
pnpm test

# 监听模式
pnpm test:watch

# 集成测试：启动真实 csharp-ls 进程，以 test-project/ 为工作区
pnpm test:integration
```

### 代码结构

```
src/
├── index.ts              # Cordis 插件入口，配置验证 + 工具注册 + 语言路由 + 编辑后诊断注入
├── languages.ts          # 语言注册表：扩展名路由/项目标记/启动解析/格式化默认/push 等待/提示词段
├── tools.ts              # 14 个 LSP 工具定义（defineTool 统一包装）
├── lsp-client.ts         # LSP 协议方法封装（诊断 pull/push-等待、WorkspaceEdit 双形态归一）
├── server-manager.ts     # LSP 服务器子进程生命周期管理（env/initOptions 按语言）
├── workspace-pool.ts     # 会话 × 语言 × 项目根 的实例池（多会话隔离与复用）
├── workspace-resolver.ts # 项目根发现（多语言联合探测，向上找项目标记）
├── prompt.ts             # 提示词边界式条件注入（systemPrompt.context 段，按语言分段）
└── types.ts              # 类型定义
```

## 故障排除

### csharp-ls 未找到

**错误**：`无法启动 LSP 服务器 'csharp-ls'`

**解决**：
1. 确认 csharp-ls 已安装：`csharp-ls --version`
2. 确认 PATH 中可用：`which csharp-ls`（Linux/macOS）或 `where csharp-ls`（Windows）
3. 或指定完整路径：`serverCommand: /full/path/to/csharp-ls`

### 启动超时

**错误**：`initialize 握手超时 (30000ms)`

**解决**：
1. 增加 `startupTimeoutMs` 配置值（如 60000）
2. 检查 csharp-ls 启动是否正常：手动运行 `csharp-ls` 查看输出
3. 确认 `workspaceRoot` 包含有效的 .csproj 文件

### .csproj 缺失

**错误**：csharp-ls 启动失败或无法加载项目

**解决**：
1. 确保 `workspaceRoot` 指向包含 .csproj 文件的目录
2. 或在 `serverArgs` 中指定项目文件：`['--project', '/path/to/project.csproj']`
3. 确保项目可正常编译：`dotnet build`

### 连接中断

**错误**：JSON-RPC 连接关闭或服务器崩溃

**处理**：
- 插件自动尝试重启（指数退避，最多 5 次连续失败）
- 检查 csharp-ls 日志（设置 `logLevel: 'debug'`）
- 手动重启 DSH web profile

## License

MIT