import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/integration/**/*.test.ts'],
    // 集成测试需要更长超时：csharp-ls 启动 + NuGet 还原 + 项目加载
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
