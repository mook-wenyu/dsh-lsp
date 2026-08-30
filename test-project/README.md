# TestProject

仓库根下有三个测试夹具目录，供单元/集成测试使用：

| 目录 | 用途 |
|---|---|
| `test-project/` | C# 夹具（`.NET 8.0`）：契约 D 懒启动回归锁 + csharp-ls 集成测试工作区 |
| `test-project-ts/` | TypeScript 夹具（`tsconfig.json` strict）：typescript-language-server 集成测试工作区 |
| `test-project-js/` | JavaScript 夹具（`jsconfig.json` + checkJs）：TS/JS checkJs 诊断集成测试工作区 |

## C# 夹具说明

- **单元测试**：`__tests__/contract.test.ts` 的契约 D（懒启动接线回归锁）以本目录为夹具，
  验证工具 execute 经 resolver 命中 `TestProject.csproj` 并前置 `manager.start()`
- **集成测试**：`__tests__/integration/csharp-ls.integration.test.ts` 启动真实 csharp-ls 进程，
  将此目录作为工作区根目录，测试 LSP 客户端的各种操作（hover、definition、references 等）

> 路径引用须相对仓库定位（如 `import.meta.url`），禁止机器特定绝对路径——
> 拆分前指向 EchoCore 内的绝对路径曾致契约 D 必败（2026-08-24 修复）。

## 内容

- `TestProject.csproj` — .NET 8.0 控制台项目
- `Program.cs` — 包含接口（`IAnimal`）、类（`Dog`）、主入口（`Program.Main`）

## 注意

- 不要修改 `Program.cs` 中的符号结构，测试断言依赖其精确内容
- 三个夹具目录仅用于测试，不参与构建分发
