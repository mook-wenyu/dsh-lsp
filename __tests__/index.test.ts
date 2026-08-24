/**
 * 插件入口 apply() 单元测试。
 *
 * Mock Cordis Context + ToolRuntime，
 * 验证配置守卫、工具注册、autoStart 行为。
 *
 * Mock 策略：
 * - server-manager.js → LspServerManager 构造函数返回 mock 实例
 * - lsp-client.js → LspClient 构造函数返回 mock 实例
 * - tools.js → createLspTools 返回 6 个 mock 工具定义
 *
 * 注意：vi.hoisted() 必须在 vi.mock() 外部声明，
 * 因为两者都会被提升到文件顶部，不能嵌套调用。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve as resolvePath } from 'node:path'


// ─── 所有 mock 变量统一用 vi.hoisted() 声明 ─────────────
// vi.mock 工厂可以引用这些变量，因为两者都被提升到文件顶部。
const mocks = vi.hoisted(() => {
  const start = vi.fn().mockResolvedValue({});
  const dispose = vi.fn().mockResolvedValue(undefined);
  const LspServerManager = vi.fn().mockImplementation(() => ({
    start,
    dispose,
  }));
  const LspClient = vi.fn().mockImplementation(() => ({}));
  const createLspTools = vi.fn().mockReturnValue(
    Array.from({ length: 6 }, (_, i) => ({
      name: `lsp_tool_${i}`,
      description: `Tool ${i}`,
      // defineTool 编译产物形状：apply() 必须原样注册、不得二次处理
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径' },
        },
        required: ['file_path'],
      },
      output: { schema: { type: 'json' }, render: vi.fn() },
      execute: vi.fn(),
    })),
  );
  return { start, dispose, LspServerManager, LspClient, createLspTools };
});

// ─── vi.mock 工厂引用 hoisted 变量 ──────────────────────
vi.mock('../src/server-manager.js', () => ({
  LspServerManager: mocks.LspServerManager,
}));

vi.mock('../src/lsp-client.js', () => ({
  LspClient: mocks.LspClient,
}));

vi.mock('../src/tools.js', () => ({
  createLspTools: mocks.createLspTools,
}));

// prompt.js: installLspPrompt 会被 apply() 内部调用，mock 为空操作
vi.mock('../src/prompt.js', () => ({
  installLspPrompt: vi.fn(),
}));

// 动态导入被测模块（确保 mock 已生效）
const { apply } = await import('../src/index.js');

// ─── Mock Context 工厂 ──────────────────────────────────
/** 创建 mock ExtendedContext（模拟 Cordis 注入的 ctx）。 */
function createMockCtx() {
  return {
    tools: { register: vi.fn(() => vi.fn()) }, // register 返回 disposer 函数
    systemPrompt: {
      context: vi.fn(),
    },
    effect: vi.fn(),

    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

// ─── 测试 ───────────────────────────────────────────────
describe('apply() 插件入口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue({});
  });

  // ─── 配置守卫 ────────────────────────────────────────
  describe('配置守卫', () => {
    it('enabled=false 时不注册任何工具', () => {
      const ctx = createMockCtx();
      apply(ctx as any, { enabled: false, workspaceRoot: '/test/project' });

      expect(ctx.tools.register).not.toHaveBeenCalled();
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('已禁用'),
      );
    });

    it('未提供 workspaceRoot 时仍注册动态工作区工具', () => {
      const ctx = createMockCtx();
      apply(ctx as any, { enabled: true });

      expect(ctx.tools.register).toHaveBeenCalledTimes(6);
      expect(ctx.logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('未配置 workspaceRoot'),
      );
    })
  });

  // ─── 正常配置 ────────────────────────────────────────
  describe('正常配置', () => {
    it('注册 6 个工具到 ctx.tools', () => {
      const ctx = createMockCtx();
      apply(ctx as any, { enabled: true, workspaceRoot: '/test/project' });

      expect(ctx.tools.register).toHaveBeenCalledTimes(6);
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('已注册 6 个 LSP 工具'),
      );
    });

    it('创建 LspServerManager 时传递正确的配置参数', async () => {
      const ctx = createMockCtx();
      apply(ctx as any, {
        enabled: true,
        workspaceRoot: '/test/project',
        serverCommand: 'custom-ls',
        serverArgs: ['--stdio'],
        startupTimeoutMs: 15000,
        logLevel: 'debug',
        autoStart: true,
      });

      await vi.waitFor(() => {
        expect(mocks.LspServerManager).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'custom-ls',
            args: ['--stdio'],
            workspaceRoot: resolvePath('/test/project'),
            startupTimeoutMs: 15000,
            logLevel: 'debug',
          }),
        );
      });
    });

    it('使用默认配置值（未指定时）', async () => {
      const ctx = createMockCtx();
      apply(ctx as any, { enabled: true, workspaceRoot: '/test', autoStart: true });

      await vi.waitFor(() => {
        expect(mocks.LspServerManager).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'csharp-ls',   // 默认值
            args: [],                // 默认值
            startupTimeoutMs: 30000, // 默认值
            logLevel: 'warn',        // 默认值
          }),
        );
      });
    });

    it('createLspTools 被调用且每个工具注册到 ctx.tools', () => {
      const ctx = createMockCtx();
      apply(ctx as any, { enabled: true, workspaceRoot: '/test' });

      // createLspTools 被调用一次
      expect(mocks.createLspTools).toHaveBeenCalledTimes(1);
      // 每个工具通过 ctx.tools.register 注册
      expect(ctx.tools.register).toHaveBeenCalledTimes(6);
      // 每个 register 调用传入工具定义对象
      for (const call of vi.mocked(ctx.tools.register).mock.calls) {
        expect(call[0]).toHaveProperty('name');
        expect(call[0]).toHaveProperty('execute');
      }
    });

    it('注册时将参数声明编译为 object-root JSON Schema', () => {
      const ctx = createMockCtx();
      apply(ctx as any, { enabled: true, workspaceRoot: '/test' });

      for (const call of vi.mocked(ctx.tools.register).mock.calls) {
        const definition = call[0] as { parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] } };
        expect(definition.parameters.type).toBe('object');
        expect(definition.parameters.properties).toHaveProperty('file_path');
        expect(definition.parameters.required).toContain('file_path');
      }
    });

  });

  // ─── autoStart 行为 ──────────────────────────────────
  describe('autoStart', () => {
    it('autoStart=true 时调用 serverManager.start()', async () => {
      const ctx = createMockCtx();
      apply(ctx as any, {
        enabled: true,
        workspaceRoot: '/test/project',
        autoStart: true,
      });

      // 等待微任务队列（start 返回 Promise）
      await vi.waitFor(() => {
        expect(mocks.start).toHaveBeenCalled();
      });
    });

    it('autoStart=false（默认）时不调用 serverManager.start()', () => {
      const ctx = createMockCtx();
      apply(ctx as any, {
        enabled: true,
        workspaceRoot: '/test/project',
        autoStart: false,
      });

      expect(mocks.start).not.toHaveBeenCalled();
    });

    it('autoStart=true 但 start() 失败时记录错误日志，不抛异常', async () => {
      const startError = new Error('启动失败');
      mocks.start.mockRejectedValueOnce(startError);

      const ctx = createMockCtx();
      apply(ctx as any, {
        enabled: true,
        workspaceRoot: '/test/project',
        autoStart: true,
      });

      // 等待 microtask + rejection handler 执行
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('自动启动失败'),
      );
    });
  });
});
