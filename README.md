# @echocore/dsh-lsp-client

DSH LSP 客户端插件：为 AI 代理提供语言服务器协议（LSP）能力——悬停、跳转定义、查找引用、编译诊断、文档符号、调用层级分析等 14 个工具。

## 特性

- **14 个 LSP 工具**：覆盖符号级理解、编辑辅助、重构与诊断全链路
- **提示词边界式条件注入**：仅当会话 cwd 向上探测到 `.slnx/.sln/.csproj` 时注入 C# LSP 使用指引（双向决策边界），非 C# 会话零 token 占用
- **多会话工作区隔离**：LspWorkspacePool 按会话 × 项目根维护独立 csharp-ls 实例
- **懒启动**：服务器在首次工具调用时拉起，`start()` 幂等
- **编辑后自动诊断**：监听 tools/result 事件，编辑 `.cs` 文件后自动注入诊断摘要

## 前置条件

- **.NET SDK 10+**：csharp-ls 依赖 .NET 运行时
- **csharp-ls**：安装并确保在 PATH 中可用
  ```bash
  # 全局安装
  dotnet tool install --global csharp-ls
  # 或验证安装
  csharp-ls --version
  ```
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
  serverCommand: csharp-ls
  serverArgs: []
  workspaceRoot: /path/to/your/csharp/project
  startupTimeoutMs: 30000
  autoStart: false
  logLevel: warn
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
| `serverCommand` | string | `'csharp-ls'` | LSP 服务器命令 |
| `serverArgs` | string[] | `[]` | 传递给 LSP 服务器的额外参数 |
| `workspaceRoot` | string | - | 可选：固定 LSP 工作区根目录；**未配置时按 file_path/session cwd 向上探测项目文件动态发现**（推荐省略） |
| `startupTimeoutMs` | number | `30000` | initialize 握手超时（毫秒） |
| `autoStart` | boolean | `false` | 插件加载时自动启动服务器 |
| `logLevel` | string | `'warn'` | 日志级别：off/error/warn/info/debug |

## 工具说明

插件注册 14 个 LSP 工具，供 AI 代理在 C# 项目中使用：

| 工具名 | LSP 方法 | 用途 | 参数 |
|--------|----------|------|------|
| `lsp_hover` | `textDocument/hover` | 获取类型签名和文档注释 | `file_path`, `line`, `column` |
| `lsp_definition` | `textDocument/definition` | 跳转到符号定义位置 | `file_path`, `line`, `column` |
| `lsp_references` | `textDocument/references` | 查找符号的所有引用位置（语义级全量，优于文本搜索） | `file_path`, `line`, `column`, `include_declaration?` |
| `lsp_implement` | `textDocument/implementation` | 查找接口/抽象成员的实现位置 | `file_path`, `line`, `column` |
| `lsp_diagnostics` | `textDocument/diagnostic`（pull），不支持时回退 push 缓存 | 获取文件的编译诊断信息 | `file_path` |
| `lsp_document_symbols` | `textDocument/documentSymbol` | 以层级树列出文件中的所有符号 | `file_path` |
| `lsp_call_hierarchy` | `callHierarchy/prepare + incoming/outgoingCalls` | 分析方法的调用层级 ⚠️ csharp-ls 0.26.0 未声明该能力，当前返回服务器错误 | `file_path`, `line`, `column` |
| `lsp_code_action` | `textDocument/codeAction` | 获取诊断位置的快速修复建议 | `file_path`, `line`, `column`, `end_line?`, `end_column?`, `diagnostic_code?`, `diagnostic_message?` |
| `lsp_completion` | `textDocument/completion` | 光标处智能补全 | `file_path`, `line`, `column` |
| `lsp_signature` | `textDocument/signatureHelp` | 调用处的方法签名与活跃参数；需光标在参数括号内，构造函数调用可能无返回 | `file_path`, `line`, `column` |
| `lsp_format` | `textDocument/formatting` / `rangeFormatting` | 格式化全文或指定范围，返回待应用的编辑列表 | `file_path`, `start_line?`, `end_line?` |
| `lsp_rename` | `textDocument/prepareRename + rename` | 符号重命名，返回跨文件编辑计划（不落盘） | `file_path`, `line`, `column`, `new_name` |
| `lsp_organize_imports` | `textDocument/codeAction`（source） | 整理 using：补缺失、按字母排序；**不删除未使用 using**（csharp-ls 限制）——清理走 diagnostics(CS8019) + code_action | `file_path` |
| `lsp_workspace_diagnostics` | 诊断缓存聚合 | 按文件分组汇总已探明文件（调用过 diagnostics 或收到推送）的最近诊断 | 无 |

**注意**：
- 所有行列号参数从 **0** 开始（0-indexed），文件路径必须是 **绝对路径**
- `rename`/`organize_imports`/`format` 返回编辑计划而非直接写盘，由调用方决定是否应用
- 工作区根目录未配置时按 `file_path` → session cwd 向上探测 `.slnx/.sln/.csproj` 自动发现

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH Web GUI (Cordis)                     │
├─────────────────────────────────────────────────────────────┤
│  dsh-lsp-client 插件                                        │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │   index.ts      │───▶│     LspServerManager            │ │
│  │  (Cordis 入口)   │    │  (子进程生命周期管理)            │ │
│  └────────┬────────┘    │  - 启动/重启 csharp-ls          │ │
│           │             │  - JSON-RPC 2.0 连接管理         │ │
│           │             │  - initialize/initialized 握手   │ │
│           │             └──────────────┬──────────────────┘ │
│           │                            │                    │
│           ▼                            ▼                    │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │    tools.ts     │    │        LspClient                │ │
│  │  (14个工具定义)  │───▶│   (语义化 LSP 方法封装)          │ │
│  └─────────────────┘    │  - hover/definition/references  │ │
│                         │  - diagnostics/documentSymbols  │ │
│                         │  - callHierarchy                │ │
│                         └──────────────┬──────────────────┘ │
│                                        │                    │
└────────────────────────────────────────┼────────────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────────┐
                          │        csharp-ls 进程            │
                          │   (LSP Server, stdio 通信)       │
                          │   - C# 语言智能                   │
                          │   - 编译诊断                      │
                          │   - 符号分析                      │
                          └─────────────────────────────────┘
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
├── index.ts              # Cordis 插件入口，配置验证 + 工具注册 + 编辑后诊断注入
├── tools.ts              # 14 个 LSP 工具定义（defineTool 统一包装）
├── lsp-client.ts         # LSP 协议方法封装
├── server-manager.ts     # LSP 服务器子进程生命周期管理
├── workspace-pool.ts     # 会话 × 项目根 的实例池（多会话隔离与复用）
├── workspace-resolver.ts # 项目根发现（向上探测 .slnx/.sln/.csproj，含同步版）
├── prompt.ts             # 提示词边界式条件注入（systemPrompt.context 段）
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