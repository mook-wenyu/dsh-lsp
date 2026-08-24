# @echocore/dsh-lsp-client

DSH LSP 客户端插件：为 AI 代理提供语言服务器协议（LSP）能力——悬停、跳转定义、查找引用、编译诊断、文档符号、调用层级分析。

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

```bash
# 在 DSH web profile 中添加插件
dsh plugin --profile web add @echocore/dsh-lsp-client
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
| `workspaceRoot` | string | - | **必填**：LSP 工作区根目录（绝对路径） |
| `startupTimeoutMs` | number | `30000` | initialize 握手超时（毫秒） |
| `autoStart` | boolean | `false` | 插件加载时自动启动服务器 |
| `logLevel` | string | `'warn'` | 日志级别：off/error/warn/info/debug |

## 工具说明

插件注册 6 个 LSP 工具，供 AI 代理在 C# 项目中使用：

| 工具名 | LSP 方法 | 用途 | 参数 |
|--------|----------|------|------|
| `lsp_hover` | `textDocument/hover` | 获取类型签名和文档注释 | `file_path`, `line`, `column` |
| `lsp_definition` | `textDocument/definition` | 跳转到符号定义位置 | `file_path`, `line`, `column` |
| `lsp_references` | `textDocument/references` | 查找符号的所有引用位置 | `file_path`, `line`, `column`, `include_declaration?` |
| `lsp_diagnostics` | `textDocument/diagnostic` | 获取文件的编译诊断信息 | `file_path` |
| `lsp_document_symbols` | `textDocument/documentSymbol` | 列出文件中的所有符号（类、方法、属性等） | `file_path` |
| `lsp_call_hierarchy` | `callHierarchy/*` | 分析函数/方法的调用层级 | `file_path`, `line`, `column` |

**注意**：所有行列号参数从 **0** 开始（0-indexed），文件路径必须是 **绝对路径**。

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
│  │  (6个工具定义)   │───▶│   (语义化 LSP 方法封装)          │ │
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
# 运行所有测试
pnpm test

# 监听模式
pnpm test:watch
```

### 代码结构

```
src/
├── index.ts           # Cordis 插件入口，配置验证 + 工具注册
├── server-manager.ts  # LSP 服务器子进程生命周期管理
├── lsp-client.ts      # LSP 协议方法封装
├── tools.ts           # 6 个 LSP 工具定义
└── types.ts           # 类型定义
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