import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // 排除集成测试（需要真实 csharp-ls，通过 test:integration 单独运行）
    exclude: ['__tests__/integration/**'],
  },
});
