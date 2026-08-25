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
  const diagnostics = vi.fn().mockResolvedValue([]);
  const LspServerManager = vi.fn().mockImplementation(() => ({
    start,
    dispose,
    supportsPull: false,
    languageId: 'typescript',
    diagnosticWatchMs: 50,
  }));
  const LspClient = vi.fn().mockImplementation(() => ({ diagnostics }));
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
  return { start, dispose, diagnostics, LspServerManager, LspClient, createLspTools };
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
    on: vi.fn(),
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
    // mockReset 清除跨测试残留的 mockResolvedValueOnce/mockImplementationOnce 队列；
    // 再设置默认实现，避免后续 hook 测试受前序影响。
    mocks.diagnostics.mockReset();
    mocks.diagnostics.mockResolvedValue([]);
    mocks.start.mockReset();
    mocks.start.mockResolvedValue({});
    vi.clearAllMocks();
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

describe('tools/post-execute 编辑后诊断 hook（D1/D3/D4 回归锁）', () => {
  function getPostExecuteListener(ctx: ReturnType<typeof createMockCtx>) {
    const on = vi.mocked(ctx.on);
    const call = on.mock.calls.find(([event]) => event === 'tools/post-execute');
    expect(call).toBeDefined();
    return call![1] as (exec: any, result: any, next: any) => Promise<any>;
  }

  it('编辑 .ts 成功且有错误：返回 additionalContexts（不再用 steer）', async () => {
    const ctx = createMockCtx();
    apply(ctx as any, { enabled: true, workspaceRoot: 'D:\\repo' });
    const listener = getPostExecuteListener(ctx);
    const next = vi.fn().mockResolvedValue({ kind: 'accept' });
    const inject = vi.fn();
    mocks.diagnostics.mockResolvedValueOnce([
      { severity: 'error', message: 'TS2322 类型不匹配', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, code: 'TS2322' },
    ]);

    const decision = await listener(
      { name: 'write', arguments: { file_path: 'D:\\repo\\src\\app.ts' }, agent: { id: 's1', inject } },
      { isError: false, value: { path: 'D:\\repo\\src\\app.ts' } },
      next,
    );

    expect(decision).toEqual({
      kind: 'accept',
      additionalContexts: [expect.objectContaining({
        role: 'user',
        source: expect.objectContaining({ kind: 'plugin', plugin: 'lsp-client' }),
        content: [expect.objectContaining({ type: 'text', text: expect.stringContaining('[lsp] 编辑后发现 1 个编译错误') })],
      })],
    });
    expect(next).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });

  it('编辑 .ts 成功但内联无诊断：启动晚到补注，通过 agent.inject 注入（D1）', async () => {
    const ctx = createMockCtx();
    apply(ctx as any, { enabled: true, workspaceRoot: 'D:\\repo' });
    const listener = getPostExecuteListener(ctx);
    const next = vi.fn().mockResolvedValue({ kind: 'accept' });
    const inject = vi.fn();
    // 第一次内联短等待返回空；第二次后台完整等待由测试手动 resolve，避免跨测试泄漏
    let resolveLate!: (value: any) => void;
    const latePromise = new Promise<any>((resolve) => { resolveLate = resolve; });
    mocks.diagnostics
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => latePromise);

    const decision = await listener(
      { name: 'edit', arguments: { file_path: 'D:\\repo\\src\\app.ts' }, agent: { id: 's1', inject } },
      { isError: false, value: { path: 'D:\\repo\\src\\app.ts' } },
      next,
    );

    expect(decision).toEqual({ kind: 'accept' }); // 内联未附加
    expect(next).toHaveBeenCalledTimes(1);
    expect(inject).not.toHaveBeenCalled(); // 后台仍在等待

    resolveLate([
      { severity: 'error', message: 'TS2493 晚到', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, code: 'TS2493' },
    ]);
    await new Promise((r) => setTimeout(r, 10));
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: [expect.objectContaining({ text: expect.stringContaining('TS2493') })],
    }));
  });

  it('非编辑工具/失败结果/lsp_* 不触发诊断', async () => {
    const ctx = createMockCtx();
    apply(ctx as any, { enabled: true, workspaceRoot: 'D:\\repo' });
    const listener = getPostExecuteListener(ctx);
    const next = vi.fn().mockResolvedValue({ kind: 'accept' });

    // 显式清空并让事件循环排空前一测试可能残留的后台微任务，避免跨测试污染
    mocks.diagnostics.mockClear();
    await new Promise((r) => setTimeout(r, 20));
    mocks.diagnostics.mockClear();

    // lsp_* 工具
    await listener({ name: 'lsp_hover', arguments: { file_path: 'D:\\repo\\src\\app.ts' } }, { isError: false }, next);
    // 失败结果
    await listener({ name: 'write', arguments: { file_path: 'D:\\repo\\src\\app.ts' } }, { isError: true }, next);
    // 非代码文件
    await listener({ name: 'write', arguments: { file_path: 'D:\\repo\\README.txt' } }, { isError: false }, next);
    // 无文件参数
    await listener({ name: 'write', arguments: {} }, { isError: false }, next);

    expect(mocks.diagnostics).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(4);
  });
});
