# TestProject

此目录是 `csharp-ls` 集成测试的辅助 C# 项目。

## 用途

`__tests__/integration/csharp-ls.integration.test.ts` 启动真实 csharp-ls 进程，
将此目录作为工作区根目录，测试 LSP 客户端的各种操作（hover、definition、references 等）。

## 内容

- `TestProject.csproj` — .NET 8.0 控制台项目
- `Program.cs` — 包含接口（`IAnimal`）、类（`Dog`）、主入口（`Program.Main`）

## 注意

- 不要修改 `Program.cs` 中的符号结构，测试断言依赖其精确内容
- 此项目仅用于测试，不参与构建分发
