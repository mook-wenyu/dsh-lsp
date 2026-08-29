/**
 * 生产契约防回归测试（2026-08-23 真实宿主事故后建立）。
 *
 * 三条铁律（对应三次生产故障）：
 * A. 注册到 ctx.tools 的定义必须是 defineTool 编译产物——parameters 为
 *    object-root JSON Schema。裸作者格式会让模型看到非法签名而不生成任何参数。
 * B. execute 经 defineTool 包装后自带入口校验：缺必填参数必须抛 ToolArgsError，
 *    而不是让 undefined 一路穿透到深处炸出难定位的 TypeError。
 * C. output.schema 声明的顶层形状必须与 execute 实际返回一致——宿主会对
 *    返回值做校验，声明 object 实返数组会直接报 invalid output。
 *
 * 另锁 D：resolveClient 必须先 manager.start() 再放行调用（懒启动接线）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createLspTools } from '../src/tools.js';
import type { LspClient } from '../src/lsp-client.js';

// ─── 契约 D 所需模块级 mock（仅影响动态导入的 index.js）───
const dMocks = vi.hoisted(() => {
  const start = vi.fn().mockResolvedValue({});
  const dispose = vi.fn().mockResolvedValue(undefined);
  return {
    start,
    LspServerManager: vi.fn().mockImplementation(() => ({ start, dispose })),
    LspClient: vi.fn().mockImplementation((manager: unknown) => ({
      __manager: manager,
      documentSymbols: vi.fn().mockResolvedValue([]),
    })),
    installLspPrompt: vi.fn(),
  };
});
vi.mock('../src/server-manager.js', () => ({ LspServerManager: dMocks.LspServerManager }));
vi.mock('../src/lsp-client.js', () => ({ LspClient: dMocks.LspClient }));
vi.mock('../src/prompt.js', () => ({ installLspPrompt: dMocks.installLspPrompt }));

// ─── Mock LspClient：每个方法返回该工具的代表性真实形状 ──
function createShapeClient(): LspClient {
  return {
    hover: vi.fn().mockResolvedValue({ found: true, summary: 'string' }),
    definition: vi.fn().mockResolvedValue([]),
    references: vi.fn().mockResolvedValue([]),
    diagnostics: vi.fn().mockResolvedValue([]),
    documentSymbols: vi.fn().mockResolvedValue([]),
    callHierarchy: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
    codeAction: vi.fn().mockResolvedValue([]),
    completion: vi.fn().mockResolvedValue([]),
    signatureHelp: vi.fn().mockResolvedValue(null),
    format: vi.fn().mockResolvedValue([]),
    rename: vi.fn().mockResolvedValue(null),
    implementation: vi.fn().mockResolvedValue([]),
    organizeImports: vi.fn().mockResolvedValue([]),
    workspaceDiagnostics: vi.fn().mockResolvedValue([]),
  } as unknown as LspClient;
}

/** 各工具调用所需的最小合法参数（与 src/tools.ts 声明同步）。 */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  lsp_hover: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_definition: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_references: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_diagnostics: { file_path: 'D:\\x.cs' },
  lsp_document_symbols: { file_path: 'D:\\x.cs' },
  lsp_call_hierarchy: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_code_action: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_completion: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_signature: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_format: { file_path: 'D:\\x.cs' },
  lsp_rename: { file_path: 'D:\\x.cs', line: 0, column: 0, new_name: 'X' },
  lsp_implement: { file_path: 'D:\\x.cs', line: 0, column: 0 },
  lsp_organize_imports: { file_path: 'D:\\x.cs' },
  lsp_workspace_diagnostics: {},
};

describe('生产契约：defineTool 编译产物', () => {
  const tools = createLspTools(createShapeClient()) as unknown as Record<string, unknown>[];

  it('共 14 个工具', () => {
    expect(tools).toHaveLength(14);
  });

  it.each(tools.map((t) => [t.name as string, t]))('%s：parameters 是编译后 object-root JSON Schema（契约 A）', (_name, tool) => {
    const params = tool.parameters as { type?: string; oneOf?: unknown };
    // 编译产物必须是标准 JSON Schema；作者格式属性映射没有顶层 type
    expect(params.type).toBe('object');
  });

  it.each(tools.map((t) => [t.name as string, t]))('%s：output.schema 顶层形状有 type 或 oneOf', (_name, tool) => {
    const schema = (tool.output as { schema: { type?: string; oneOf?: unknown } }).schema;
    expect(typeof schema.type === 'string' || Array.isArray(schema.oneOf)).toBe(true);
  });
});

describe('生产契约：execute 入口校验（契约 B）', () => {
  const tools = createLspTools(createShapeClient()) as unknown as Record<string, unknown>[];
  const byName = Object.fromEntries(tools.map((t) => [t.name as string, t]));

  it('lsp_hover 缺必填参数抛 ToolArgsError（而非深处 TypeError）', async () => {
    let caught: Error | undefined;
    try {
      await (byName.lsp_hover as { execute(a: unknown): Promise<unknown> }).execute({});
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.name).toBe('ToolArgsError');
    expect(caught!.message).toContain('file_path');
  });

  it('参数齐全时正常穿透到 client（不再误伤）', async () => {
    const result = await (byName.lsp_hover as { execute(a: unknown): Promise<{ found: boolean }> })
      .execute(MINIMAL_ARGS.lsp_hover!);
    expect(result.found).toBe(true);
  });
});

describe('生产契约：输出形状与 schema 一致（契约 C）', () => {
  // 单实例注入：resolveClient 不走路由，直接命中 shape client
  const client = createShapeClient();
  const tools = createLspTools(client) as unknown as Record<string, unknown>[];

  it.each(tools.map((t) => [t.name as string, t]))(
    '%s：execute 实返形状匹配 output.schema 顶层声明',
    async (name, tool) => {
      const schema = (tool.output as { schema: { type?: string; oneOf?: unknown[] } }).schema;
      const result = await (tool as { execute(a: unknown): Promise<unknown> }).execute(MINIMAL_ARGS[name] ?? {});
      if (schema.type === 'array') {
        expect(Array.isArray(result)).toBe(true);
      } else if (schema.type === 'object') {
        expect(result).not.toBeNull();
        expect(typeof result).toBe('object');
        expect(Array.isArray(result)).toBe(false);
      } else if (Array.isArray(schema.oneOf)) {
        // 可空契约：object 或 null 均合法
        expect(result === null || (typeof result === 'object' && !Array.isArray(result))).toBe(true);
      }
      void name;
    },
  );
});

describe('生产契约：懒启动接线（契约 D）', () => {
  beforeEach(() => {
    dMocks.start.mockClear();
    dMocks.LspServerManager.mockClear();
  });

  it('工具 execute 经 resolveClient 前置 manager.start()（Bug B 回归锁）', async () => {
    const { apply } = await import('../src/index.js');
    const registered: Record<string, { execute(a: unknown, e?: unknown): Promise<unknown> }> = {};
    const ctx = {
      tools: {
        register: (d: { name: string }) => {
          registered[d.name] = d as never;
          return () => {};
        },
      },
      systemPrompt: { context: vi.fn() },
      effect: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
    apply(ctx as never, { enabled: true });

    // 真实 resolver + 真实文件系统：夹具相对本仓库定位（f60c97f 拆分后
    // 旧 EchoCore 绝对路径已删除，机器特定路径曾致本回归锁必败），
    // Program.cs 所在目录即含 TestProject.csproj
    await registered['lsp_document_symbols']!.execute(
      { file_path: fileURLToPath(new URL('../test-project/Program.cs', import.meta.url)) },
      { agent: { id: 't1', session: { header: { cwd: fileURLToPath(new URL('../test-project', import.meta.url)) } } } },
    );
    expect(dMocks.start).toHaveBeenCalled();
    expect(dMocks.LspServerManager).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: expect.stringContaining('test-project') }),
    );
  });
});
