/**
 * 6 个 LSP 工具定义单元测试。
 *
 * 验证每个工具：
 * 1. name 符合 DSH 命名规范（lsp_*）
 * 2. description 是非空字符串
 * 3. parameters 包含所有必需参数
 * 4. output.schema 是合法 JSON Schema（含 type 字段）
 * 5. execute 方法调用 LspClient 对应方法
 * 6. render 方法返回正确的 ContentBlock[]
 *
 * Mock 策略：不 mock 模块，直接传入 mock LspClient 对象。
 * createLspTools 仅有 type-only 外部依赖，无运行时模块导入。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLspTools } from '../src/tools.js';
import type {
  LspClient,
  HoverResult,
  DiagnosticResult,
  DocumentSymbolResult,
  CallHierarchyResult,
} from '../src/lsp-client.js';
import type { LspLocation } from '../src/types.js';

// ─── Mock LspClient 工厂 ────────────────────────────────
/** 创建完整的 mock LspClient，所有方法为 vi.fn()。 */
function createMockClient(): LspClient {
  return {
    hover: vi.fn(),
    definition: vi.fn(),
    references: vi.fn(),
    diagnostics: vi.fn(),
    documentSymbols: vi.fn(),
    callHierarchy: vi.fn(),
    codeAction: vi.fn(),
    completion: vi.fn(),
    signatureHelp: vi.fn(),
    format: vi.fn(),
    rename: vi.fn(),
    implementation: vi.fn(),
    organizeImports: vi.fn(),
    workspaceDiagnostics: vi.fn(),
  } as unknown as LspClient;
}

// ─── 公共结构验证 ────────────────────────────────────────
/**
 * 验证工具定义的结构性约束（所有 6 个工具共用）。
 * @param tool - 工具定义对象
 * @param expectedName - 期望的工具名
 * @param requiredParamKeys - 期望的参数键名列表
 */
function assertToolStructure(
  tool: Record<string, unknown>,
  expectedName: string,
  requiredParamKeys: string[],
) {
  // 1. name 符合 lsp_* 命名规范
  expect(tool.name).toBe(expectedName);
  expect(tool.name).toMatch(/^lsp_/);

  // 2. description 是非空字符串
  expect(typeof tool.description).toBe('string');
  expect((tool.description as string).length).toBeGreaterThan(0);

  // 3. parameters 已由 defineTool 编译为 object-root JSON Schema（生产契约：
  //    模型看到的必须是合法 JSON Schema，否则不生成任何调用参数）
  const params = tool.parameters as {
    type: string;
    properties: Record<string, { type: string }>;
    required?: string[];
  };
  expect(params).toBeDefined();
  expect(params.type).toBe('object');
  expect(params.properties).toBeDefined();
  for (const key of requiredParamKeys) {
    expect(params.properties).toHaveProperty(key);
    expect(params.properties[key].type).toBeDefined();
    expect(params.required).toContain(key);
  }

  // 4. output.schema 是合法 JSON Schema（顶层有 type，可空契约用 oneOf）
  const output = tool.output as { schema: Record<string, unknown>; render: Function };
  expect(output).toBeDefined();
  expect(output.schema).toBeDefined();
  const hasTypeOrOneOf = typeof output.schema.type === 'string' || Array.isArray(output.schema.oneOf);
  expect(hasTypeOrOneOf).toBe(true);

  // 5. execute 和 render 是函数
  expect(typeof tool.execute).toBe('function');
  expect(typeof output.render).toBe('function');
}

// ─── 测试 ───────────────────────────────────────────────
describe('createLspTools()', () => {
  let mockClient: LspClient;
  let tools: ReturnType<typeof createLspTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    tools = createLspTools(mockClient);
  });

  it('返回 14 个工具定义', () => {
    expect(tools).toHaveLength(14);
  });

  it('所有工具名不重复', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(14);
  });

  // ─── 1. lsp_hover ────────────────────────────────────
  describe('lsp_hover', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_hover')!;

    it('结构验证：name/description/parameters/schema', () => {
      assertToolStructure(getTool(), 'lsp_hover', ['file_path', 'line', 'column']);
    });

    it('execute 调用 client.hover() 并传递正确参数', async () => {
      const hoverResult: HoverResult = { found: true, summary: 'void Method()' };
      vi.mocked(mockClient.hover).mockResolvedValue(hoverResult);

      const result = await getTool().execute({
        file_path: 'D:\\test\\File.cs',
        line: 10,
        column: 5,
      });

      expect(result).toEqual(hoverResult);
      expect(mockClient.hover).toHaveBeenCalledWith('D:\\test\\File.cs', 10, 5);
    });

    it('render: found=true 返回 markdown 文本', () => {
      const rendered = getTool().output.render(
        {},
        { found: true, summary: '```csharp\nvoid Method()\n```' } as HoverResult,
      );
      expect(rendered).toEqual([
        { type: 'text', text: '```csharp\nvoid Method()\n```' },
      ]);
    });

    it('render: found=false 返回「未找到类型信息」', () => {
      const rendered = getTool().output.render(
        {},
        { found: false, summary: '未找到类型信息' } as HoverResult,
      );
      expect(rendered).toEqual([{ type: 'text', text: '未找到类型信息' }]);
    });
  });

  // ─── 2. lsp_definition ───────────────────────────────
  describe('lsp_definition', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_definition')!;

    it('结构验证：name/description/parameters/schema', () => {
      assertToolStructure(getTool(), 'lsp_definition', ['file_path', 'line', 'column']);
    });

    it('execute 调用 client.definition()', async () => {
      const defResult: LspLocation[] = [
        {
          filePath: 'D:\\src\\Impl.cs',
          range: { start: { line: 20, character: 0 }, end: { line: 25, character: 1 } },
        },
      ];
      vi.mocked(mockClient.definition).mockResolvedValue(defResult);

      const result = await getTool().execute({
        file_path: 'D:\\test\\File.cs',
        line: 10,
        column: 5,
      });

      expect(result).toEqual(defResult);
      expect(mockClient.definition).toHaveBeenCalledWith('D:\\test\\File.cs', 10, 5);
    });

    it('render: 空数组返回「未找到定义」', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered).toEqual([{ type: 'text', text: '未找到定义' }]);
    });

    it('render: 非空返回「→ file:line:col」格式（行列 1-indexed）', () => {
      const locs: LspLocation[] = [
        {
          filePath: 'D:\\src\\Impl.cs',
          range: { start: { line: 20, character: 0 }, end: { line: 25, character: 1 } },
        },
        {
          filePath: 'D:\\src\\Other.cs',
          range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } },
        },
      ];
      const rendered = getTool().output.render({}, locs);
      expect(rendered).toEqual([
        {
          type: 'text',
          text: '→ D:\\src\\Impl.cs:21:1\n→ D:\\src\\Other.cs:6:11',
        },
      ]);
    });
  });

  // ─── 3. lsp_references ───────────────────────────────
  describe('lsp_references', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_references')!;

    it('结构验证：含可选参数 include_declaration', () => {
      assertToolStructure(getTool(), 'lsp_references', ['file_path', 'line', 'column']);
      const params = getTool().parameters as { properties: Record<string, unknown> };
      expect(params.properties).toHaveProperty('include_declaration');
    });

    it('execute 调用 client.references() 并传递 include_declaration', async () => {
      const refResult: LspLocation[] = [
        {
          filePath: 'D:\\src\\Caller.cs',
          range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } },
        },
      ];
      vi.mocked(mockClient.references).mockResolvedValue(refResult);

      const result = await getTool().execute({
        file_path: 'D:\\test\\File.cs',
        line: 10,
        column: 5,
        include_declaration: false,
      });

      expect(result).toEqual(refResult);
      expect(mockClient.references).toHaveBeenCalledWith('D:\\test\\File.cs', 10, 5, false);
    });

    it('render: 空数组返回「未找到引用」', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered).toEqual([{ type: 'text', text: '未找到引用' }]);
    });

    it('render: 非空返回按文件分组的统计摘要', () => {
      const locs: LspLocation[] = [
        {
          filePath: 'D:\\src\\A.cs',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        },
        {
          filePath: 'D:\\src\\A.cs',
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
        },
        {
          filePath: 'D:\\src\\B.cs',
          range: { start: { line: 7, character: 0 }, end: { line: 7, character: 5 } },
        },
      ];
      const rendered = getTool().output.render({}, locs);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]!.type).toBe('text');
      expect(rendered[0]!.text).toContain('共 3 处引用');
      expect(rendered[0]!.text).toContain('2 个文件');
      expect(rendered[0]!.text).toContain('A.cs (2 处)');
      expect(rendered[0]!.text).toContain('B.cs (1 处)');
    });
  });

  // ─── 4. lsp_diagnostics ──────────────────────────────
  describe('lsp_diagnostics', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_diagnostics')!;

    it('结构验证：name/description/parameters/schema', () => {
      assertToolStructure(getTool(), 'lsp_diagnostics', ['file_path']);
    });

    it('execute 调用 client.diagnostics()', async () => {
      const diagResult: DiagnosticResult[] = [
        {
          severity: 'error',
          message: '找不到类型 "Foo"',
          range: { start: { line: 3, character: 10 }, end: { line: 3, character: 13 } },
          source: 'csharp',
        },
      ];
      vi.mocked(mockClient.diagnostics).mockResolvedValue(diagResult);

      const result = await getTool().execute({ file_path: 'D:\\test\\File.cs' });
      expect(result).toEqual(diagResult);
      expect(mockClient.diagnostics).toHaveBeenCalledWith('D:\\test\\File.cs');
    });

    it('render: 空数组返回 ✅ 无编译错误或警告', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered).toEqual([{ type: 'text', text: '✅ 无编译错误或警告' }]);
    });

    it('render: 非空返回错误/警告列表（含行号 1-indexed）', () => {
      const items: DiagnosticResult[] = [
        {
          severity: 'error',
          message: '找不到类型 "Foo"',
          range: { start: { line: 3, character: 10 }, end: { line: 3, character: 13 } },
        },
        {
          severity: 'warning',
          message: '变量未使用',
          range: { start: { line: 7, character: 4 }, end: { line: 7, character: 5 } },
        },
      ];
      const rendered = getTool().output.render({}, items);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]!.text).toContain('1 个错误');
      expect(rendered[0]!.text).toContain('1 个警告');
      expect(rendered[0]!.text).toContain('❌ 行4:');
      expect(rendered[0]!.text).toContain('⚠️ 行8:');
    });

    it('render: 大量诊断全部展示（不截断）', () => {
      const items: DiagnosticResult[] = Array.from({ length: 25 }, (_, i) => ({
        severity: 'error' as const,
        message: `错误 ${i}`,
        range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
      }));
      const rendered = getTool().output.render({}, items);
      expect(rendered[0]!.text).toContain('25 个错误');
      // 不截断：所有 25 条都应展示
      expect(rendered[0]!.text).toContain('错误 24');
    });
  });

  // ─── 5. lsp_document_symbols ─────────────────────────
  describe('lsp_document_symbols', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_document_symbols')!;

    it('结构验证：name/description/parameters/schema', () => {
      assertToolStructure(getTool(), 'lsp_document_symbols', ['file_path']);
    });

    it('输出 schema 声明为符号数组', () => {
      expect((getTool().output.schema as { type: string }).type).toBe('array');
    });


    it('execute 调用 client.documentSymbols()', async () => {
      const symResult: DocumentSymbolResult[] = [
        {
          name: 'MyClass',
          kind: '类',
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
          depth: 0,
          children: [],
        },
      ];
      vi.mocked(mockClient.documentSymbols).mockResolvedValue(symResult);

      const result = await getTool().execute({ file_path: 'D:\\test\\File.cs' });
      expect(result).toEqual(symResult);
      expect(mockClient.documentSymbols).toHaveBeenCalledWith('D:\\test\\File.cs');
    });


    it('render: 空数组返回「未找到符号」', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered).toEqual([{ type: 'text', text: '未找到符号' }]);
    });

    it('render: 非空返回树形列表（含缩进子符号）', () => {
      const syms: DocumentSymbolResult[] = [
        {
          name: 'MyClass',
          kind: '类',
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
          depth: 0,
          children: [
            {
              name: 'DoWork',
              kind: '方法',
              range: { start: { line: 5, character: 2 }, end: { line: 10, character: 3 } },
              depth: 1,
              children: [],
            },
          ],
        },
      ];
      const rendered = getTool().output.render({}, syms);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]!.text).toContain('1 个顶级符号');
      expect(rendered[0]!.text).toContain('类 MyClass (1)');
      expect(rendered[0]!.text).toContain('方法 DoWork (6)');
    });
  });

  // ─── 6. lsp_call_hierarchy ───────────────────────────
  describe('lsp_call_hierarchy', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_call_hierarchy')!;

    it('结构验证：name/description/parameters/schema', () => {
      assertToolStructure(getTool(), 'lsp_call_hierarchy', ['file_path', 'line', 'column']);
    });

    it('execute 调用 client.callHierarchy()', async () => {
      const chResult: CallHierarchyResult = {
        incoming: [
          {
            from: {
              name: 'Main',
              kind: '方法',
              filePath: 'D:\\test\\Program.cs',
              range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
            },
            ranges: [{ start: { line: 5, character: 4 }, end: { line: 5, character: 13 } }],
          },
        ],
        outgoing: [],
      };
      vi.mocked(mockClient.callHierarchy).mockResolvedValue(chResult);

      const result = await getTool().execute({
        file_path: 'D:\\test\\File.cs',
        line: 10,
        column: 5,
      });
      expect(result).toEqual(chResult);
      expect(mockClient.callHierarchy).toHaveBeenCalledWith('D:\\test\\File.cs', 10, 5);
    });

    it('render: 空结果返回「未找到调用层级信息」', () => {
      const emptyResult: CallHierarchyResult = { incoming: [], outgoing: [] };
      const rendered = getTool().output.render({}, emptyResult);
      expect(rendered).toEqual([{ type: 'text', text: '未找到调用层级信息' }]);
    });

    it('render: 非空返回 incoming + outgoing 列表', () => {
      const result: CallHierarchyResult = {
        incoming: [
          {
            from: {
              name: 'Main',
              kind: '方法',
              filePath: 'D:\\test\\Program.cs',
              range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
            },
            ranges: [{ start: { line: 5, character: 4 }, end: { line: 5, character: 13 } }],
          },
        ],
        outgoing: [
          {
            to: {
              name: 'Helper',
              kind: '函数',
              filePath: 'D:\\test\\Helper.cs',
              range: { start: { line: 20, character: 0 }, end: { line: 25, character: 1 } },
            },
            ranges: [{ start: { line: 12, character: 4 }, end: { line: 12, character: 10 } }],
          },
        ],
      };
      const rendered = getTool().output.render({}, result);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]!.text).toContain('📥 被 1 处调用');
      expect(rendered[0]!.text).toContain('← Main (方法)');
      expect(rendered[0]!.text).toContain('📤 调用了 1 处');
      expect(rendered[0]!.text).toContain('→ Helper (函数)');
    });

    it('render: 仅有 incoming 时不显示 outgoing 部分', () => {
      const result: CallHierarchyResult = {
        incoming: [
          {
            from: {
              name: 'Caller',
              kind: '方法',
              filePath: 'D:\\test\\A.cs',
              range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
            },
            ranges: [{ start: { line: 3, character: 0 }, end: { line: 3, character: 5 } }],
          },
        ],
        outgoing: [],
      };
      const rendered = getTool().output.render({}, result);
      expect(rendered[0]!.text).toContain('📥');
      expect(rendered[0]!.text).not.toContain('📤');
    });
  });

  // ─── 7. lsp_code_action ─────────────────────────
  describe('lsp_code_action', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_code_action')!;

    it('结构验证：name/description/parameters/schema', () => {
      assertToolStructure(getTool(), 'lsp_code_action', ['file_path', 'line', 'column']);
    });

    it('execute 调用 client.codeAction() 并传递正确参数', async () => {
      const mockEdits = [
        {
          filePath: 'D:\\test\\Program.cs',
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } },
          newText: 'using System;',
        },
      ];
      mockClient.codeAction.mockResolvedValue([
        { title: '添加 using System;', kind: 'quickfix', isPreferred: true, edits: mockEdits },
      ]);

      const result = await getTool().execute({
        file_path: 'D:\\test\\Program.cs',
        line: 3,
        column: 0,
        diagnostic_code: 'CS0246',
        diagnostic_message: 'The type or namespace name could not be found',
      });

      expect(mockClient.codeAction).toHaveBeenCalledOnce();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('添加 using System;');
      expect(result[0].isPreferred).toBe(true);
      expect(result[0].edits).toHaveLength(1);
    });

    it('render: 有修复建议时展示标题和编辑摘要', () => {
      const items = [
        {
          title: '添加 using System;',
          kind: 'quickfix',
          isPreferred: true,
          edits: [
            {
              filePath: 'D:\\test\\Program.cs',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: 'using System;\n',
            },
          ],
        },
      ];
      const rendered = getTool().output.render({}, items);
      expect(rendered[0]!.text).toContain('1 个修复建议');
      expect(rendered[0]!.text).toContain('添加 using System;');
      expect(rendered[0]!.text).toContain('⭐推荐');
    });

    it('render: 无修复建议时提示未找到', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered[0]!.text).toBe('未找到可用的修复建议');
    });
  });

  // ─── 8. lsp_completion ─────────────────────────
  describe('lsp_completion', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_completion')!;
    it('结构验证', () => {
      assertToolStructure(getTool(), 'lsp_completion', ['file_path', 'line', 'column']);
    });
    it('execute 调用 client.completion()', async () => {
      mockClient.completion.mockResolvedValue([{ label: 'Console', kind: '类', detail: 'System' }]);
      const result = await getTool().execute({ file_path: 'D:\\test\\Program.cs', line: 5, column: 10 });
      expect(mockClient.completion).toHaveBeenCalledWith('D:\\test\\Program.cs', 5, 10);
      expect(result).toHaveLength(1);
    });
    it('render: 有补全项时展示列表', () => {
      const rendered = getTool().output.render({}, [{ label: 'Console', kind: '类', detail: 'System' }]);
      expect(rendered[0]!.text).toContain('1 个补全项');
      expect(rendered[0]!.text).toContain('Console');
    });
    it('render: 无补全项时提示', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered[0]!.text).toBe('无可用补全建议');
    });
  });

  // ─── 9. lsp_signature ─────────────────────────
  describe('lsp_signature', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_signature')!;
    it('结构验证', () => {
      assertToolStructure(getTool(), 'lsp_signature', ['file_path', 'line', 'column']);
    });
    it('execute 调用 client.signatureHelp()', async () => {
      mockClient.signatureHelp.mockResolvedValue({ label: 'void Console.WriteLine(string)', documentation: '写入', parameters: [{ label: 'value', documentation: '要写入的值' }], activeParameter: 0 });
      const result = await getTool().execute({ file_path: 'D:\\test\\Program.cs', line: 5, column: 25 });
      expect(mockClient.signatureHelp).toHaveBeenCalledOnce();
      expect(result).toBeTruthy();
    });
    it('render: 有签名时展示参数', () => {
      const rendered = getTool().output.render({}, { label: 'void WriteLine(string value)', documentation: '写入一行', parameters: [{ label: 'value', documentation: '值' }], activeParameter: 0 });
      expect(rendered[0]!.text).toContain('WriteLine');
      expect(rendered[0]!.text).toContain('value');
    });
    it('render: 无签名时提示', () => {
      const rendered = getTool().output.render({}, null);
      expect(rendered[0]!.text).toBe('未找到签名信息');
    });
  });

  // ─── 10. lsp_format ─────────────────────────
  describe('lsp_format', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_format')!;
    it('结构验证', () => {
      assertToolStructure(getTool(), 'lsp_format', ['file_path']);
    });
    it('execute 调用 client.format()', async () => {
      mockClient.format.mockResolvedValue([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '  ' }]);
      const result = await getTool().execute({ file_path: 'D:\\test\\Program.cs' });
      expect(mockClient.format).toHaveBeenCalledOnce();
      expect(result).toHaveLength(1);
    });
    it('render: 无需修改时提示', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered[0]!.text).toContain('已符合格式规范');
    });
  });

  // ─── 11. lsp_rename ─────────────────────────
  describe('lsp_rename', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_rename')!;
    it('结构验证', () => {
      assertToolStructure(getTool(), 'lsp_rename', ['file_path', 'line', 'column', 'new_name']);
    });
    it('execute 调用 client.rename()', async () => {
      mockClient.rename.mockResolvedValue({ newName: 'NewName', affectedFiles: 3, totalEdits: 5, fileEdits: [] });
      const result = await getTool().execute({ file_path: 'D:\\test\\Program.cs', line: 5, column: 10, new_name: 'NewName' });
      expect(mockClient.rename).toHaveBeenCalledOnce();
      expect(result.affectedFiles).toBe(3);
    });
    it('render: 成功重命名时展示影响', () => {
      const rendered = getTool().output.render({}, { newName: 'Foo', affectedFiles: 2, totalEdits: 4, fileEdits: [] });
      expect(rendered[0]!.text).toContain('Foo');
      expect(rendered[0]!.text).toContain('2 个文件');
    });
    it('render: 无法重命名时提示', () => {
      const rendered = getTool().output.render({}, null);
      expect(rendered[0]!.text).toContain('无法重命名');
    });
  });

  // ─── 12. lsp_implement ─────────────────────────
  describe('lsp_implement', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_implement')!;
    it('结构验证', () => {
      assertToolStructure(getTool(), 'lsp_implement', ['file_path', 'line', 'column']);
    });
    it('execute 调用 client.implementation()', async () => {
      mockClient.implementation.mockResolvedValue([{ filePath: 'D:\\test\\Dog.cs', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } }]);
      const result = await getTool().execute({ file_path: 'D:\\test\\IAnimal.cs', line: 0, column: 10 });
      expect(mockClient.implementation).toHaveBeenCalledOnce();
      expect(result).toHaveLength(1);
    });
    it('render: 有实现时展示列表', () => {
      const rendered = getTool().output.render({}, [{ filePath: 'D:\\test\\Dog.cs', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } }]);
      expect(rendered[0]!.text).toContain('1 个实现');
    });
  });

  // ─── 13. lsp_organize_imports ─────────────────────────
  describe('lsp_organize_imports', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_organize_imports')!;
    it('结构验证', () => {
      assertToolStructure(getTool(), 'lsp_organize_imports', ['file_path']);
    });
    it('execute 调用 client.organizeImports()', async () => {
      mockClient.organizeImports.mockResolvedValue([]);
      const result = await getTool().execute({ file_path: 'D:\\test\\Program.cs' });
      expect(mockClient.organizeImports).toHaveBeenCalledOnce();
      expect(result).toHaveLength(0);
    });
    it('render: 无需修改时提示', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered[0]!.text).toContain('using 语句已规范');
    });
  });

  // ─── 14. lsp_workspace_diagnostics ─────────────────────────
  describe('lsp_workspace_diagnostics', () => {
    const getTool = () => tools.find((t) => t.name === 'lsp_workspace_diagnostics')!;
    it('结构验证：无必需参数', () => {
      assertToolStructure(getTool(), 'lsp_workspace_diagnostics', []);
    });
    it('execute 调用 client.workspaceDiagnostics()', async () => {
      mockClient.workspaceDiagnostics.mockResolvedValue([]);
      const result = await getTool().execute({});
      expect(mockClient.workspaceDiagnostics).toHaveBeenCalledOnce();
      expect(result).toHaveLength(0);
    });
    it('render: 有诊断时按文件分组展示', () => {
      const rendered = getTool().output.render({}, [
        { filePath: 'D:\\test\\Program.cs', diagnostics: [{ severity: 'error', message: '错', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } }] },
      ]);
      expect(rendered[0]!.text).toContain('1 错误');
      expect(rendered[0]!.text).toContain('Program.cs');
    });
    it('render: 无数据时提示', () => {
      const rendered = getTool().output.render({}, []);
      expect(rendered[0]!.text).toBe('暂无工作区诊断数据');
    });
  });
});
