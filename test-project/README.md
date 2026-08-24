# TestProject

此目录是测试用的辅助 C# 项目。

## 用途

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
- 此项目仅用于测试，不参与构建分发
