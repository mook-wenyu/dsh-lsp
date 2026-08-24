/**
 * LspClient 单元测试。
 *
 * Mock 策略：
 * - node:fs → readFileSync 返回固定内容，避免读取真实文件
 * - LspServerManager → 通过 plain object 的 activeConnection getter 注入 mock connection
 * - MessageConnection → sendRequest/sendNotification 由 vi.fn() 控制返回值
 *
 * 测试覆盖：
 * - hover() found=true/false 两种路径
 * - definition() 处理 Location / Location[] / LocationLink[] 三种返回
 * - references() 返回 LspLocation[]
 * - diagnostics() pull model 成功 / 不支持两种路径
 * - documentSymbols() 递归格式化符号树
 * - callHierarchy() prepare 成功 / 失败两种路径
 * - toUri() / fromUri() Windows 路径互转
 * - inferLanguageId() 从扩展名推断语言
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock 外部依赖 ──────────────────────────────────────
// node:fs: 阻止读取真实文件，syncDocument 内部调用 readFileSync 时返回固定内容
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('// mock file content'),
}));

// 动态导入被测模块（确保 vi.mock 已生效）
const { LspClient } = await import('../src/lsp-client.js');
const { readFileSync } = await import('node:fs');

// ─── Mock 工厂 ──────────────────────────────────────────
/** 创建 mock MessageConnection，可按需配置 sendRequest 返回值。 */
function createMockConnection() {
  return {
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
  };
}

/** 创建 mock LspServerManager（暴露 activeConnection getter + getDiagnostics）。 */
function createMockManager(connection: ReturnType<typeof createMockConnection>) {
  const diagnosticsCache = new Map<string, any[]>();
  return {
    get activeConnection() {
      return connection;
    },
    getDiagnostics(_uri: string) {
      return diagnosticsCache.get(_uri) ?? [];
    },
    _diagnosticsCache: diagnosticsCache,
  };
}

// ─── 测试 ───────────────────────────────────────────────
describe('LspClient', () => {
  let mockConn: ReturnType<typeof createMockConnection>;
  let mockManager: ReturnType<typeof createMockManager>;
  let client: InstanceType<typeof LspClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConn = createMockConnection();
    mockManager = createMockManager(mockConn);
    client = new LspClient(mockManager as any);
  });

  // ─── hover() ──────────────────────────────────────────
  describe('hover()', () => {
    it('found=true: 返回 Markdown 类型信息，输出为无损 JSON 形状（Bug F 回归锁）', async () => {
      // 模拟 LSP server 返回 MarkupContent 类型的 hover 结果（含 range）
      mockConn.sendRequest.mockResolvedValueOnce({
        contents: { kind: 'markdown', value: '```csharp\nvoid Method()\n```' },
        range: {
          start: { line: 10, character: 5 },
          end: { line: 10, character: 11 },
        },
      });

      const result = await client.hover('D:\\test\\File.cs', 10, 5);

      // 精确匹配：多出任何键（如 range）都违反宿主无损 JSON/输出 schema 契约
      expect(result).toEqual({
        found: true,
        summary: '```csharp\nvoid Method()\n```',
      });
      // 验证 didOpen 通知已发送（文件同步）
      expect(mockConn.sendNotification).toHaveBeenCalledWith(
        'textDocument/didOpen',
        expect.objectContaining({
          textDocument: expect.objectContaining({
            uri: 'file:///D:/test/File.cs',
          }),
        }),
      );
      // 验证 hover 请求已发送
      expect(mockConn.sendRequest).toHaveBeenCalledWith(
        'textDocument/hover',
        expect.objectContaining({
          textDocument: { uri: 'file:///D:/test/File.cs' },
          position: { line: 10, character: 5 },
        }),
      );
    });

    it('found=true: 处理纯字符串 contents', async () => {
      mockConn.sendRequest.mockResolvedValueOnce({
        contents: 'string 类型',
        range: undefined,
      });

      const result = await client.hover('D:\\test\\File.cs', 0, 0);
      expect(result.found).toBe(true);
      expect(result.summary).toBe('string 类型');
    });

    it('found=true: 处理 MarkedString[] 数组 contents', async () => {
      mockConn.sendRequest.mockResolvedValueOnce({
        contents: [
          { kind: 'markdown', value: '**签名**' },
          '补充说明',
        ],
        range: undefined,
      });

      const result = await client.hover('D:\\test\\File.cs', 0, 0);
      expect(result.found).toBe(true);
      expect(result.summary).toBe('**签名**\n补充说明');
    });

    it('found=false: LSP server 返回 null 时返回未找到', async () => {
      mockConn.sendRequest.mockResolvedValueOnce(null);

      const result = await client.hover('D:\\test\\File.cs', 99, 0);
      expect(result).toEqual({ found: false, summary: '未找到类型信息' });
    });
  });

  // ─── definition() ─────────────────────────────────────
  describe('definition()', () => {
    const testFile = 'D:\\test\\File.cs';
    const testUri = 'file:///D:/test/File.cs';

    it('处理单个 Location 返回', async () => {
      mockConn.sendRequest.mockResolvedValueOnce({
        uri: 'file:///D:/src/Impl.cs',
        range: {
          start: { line: 20, character: 0 },
          end: { line: 25, character: 1 },
        },
      });

      const result = await client.definition(testFile, 10, 5);
      expect(result).toHaveLength(1);
      expect(result[0]!.filePath).toBe('D:\\src\\Impl.cs');
      expect(result[0]!.range.start).toEqual({ line: 20, character: 0 });
    });

    it('处理 Location[] 数组返回', async () => {
      mockConn.sendRequest.mockResolvedValueOnce([
        {
          uri: 'file:///D:/src/A.cs',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        },
        {
          uri: 'file:///D:/src/B.cs',
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
        },
      ]);

      const result = await client.definition(testFile, 10, 5);
      expect(result).toHaveLength(2);
      expect(result[0]!.filePath).toBe('D:\\src\\A.cs');
      expect(result[1]!.filePath).toBe('D:\\src\\B.cs');
    });

    it('处理 LocationLink[] 数组返回（使用 targetUri/targetRange）', async () => {
      mockConn.sendRequest.mockResolvedValueOnce([
        {
          targetUri: 'file:///D:/src/Target.cs',
          targetRange: {
            start: { line: 30, character: 0 },
            end: { line: 35, character: 1 },
          },
          targetSelectionRange: {
            start: { line: 30, character: 6 },
            end: { line: 30, character: 12 },
          },
          originSelectionRange: {
            start: { line: 10, character: 5 },
            end: { line: 10, character: 11 },
          },
        },
      ]);

      const result = await client.definition(testFile, 10, 5);
      expect(result).toHaveLength(1);
      // LocationLink 使用 targetUri 和 targetRange
      expect(result[0]!.filePath).toBe('D:\\src\\Target.cs');
      expect(result[0]!.range.start).toEqual({ line: 30, character: 0 });
    });

    it('返回 null 时返回空数组', async () => {
      mockConn.sendRequest.mockResolvedValueOnce(null);
      const result = await client.definition(testFile, 10, 5);
      expect(result).toEqual([]);
    });
  });

  // ─── references() ─────────────────────────────────────
  describe('references()', () => {
    it('返回 LspLocation[] 列表', async () => {
      mockConn.sendRequest.mockResolvedValueOnce([
        {
          uri: 'file:///D:/src/Caller1.cs',
          range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } },
        },
        {
          uri: 'file:///D:/src/Caller2.cs',
          range: { start: { line: 12, character: 3 }, end: { line: 12, character: 8 } },
        },
      ]);

      const result = await client.references('D:\\test\\File.cs', 10, 5);
      expect(result).toHaveLength(2);
      expect(result[0]!.filePath).toBe('D:\\src\\Caller1.cs');
      expect(result[1]!.filePath).toBe('D:\\src\\Caller2.cs');
      // 验证请求参数
      expect(mockConn.sendRequest).toHaveBeenCalledWith(
        'textDocument/references',
        expect.objectContaining({
          context: { includeDeclaration: true },
        }),
      );
    });

    it('返回 null 时返回空数组', async () => {
      mockConn.sendRequest.mockResolvedValueOnce(null);
      const result = await client.references('D:\\test\\File.cs', 0, 0);
      expect(result).toEqual([]);
    });

    it('includeDeclaration=false 时传递正确参数', async () => {
      mockConn.sendRequest.mockResolvedValueOnce([]);
      await client.references('D:\\test\\File.cs', 0, 0, false);
      expect(mockConn.sendRequest).toHaveBeenCalledWith(
        'textDocument/references',
        expect.objectContaining({
          context: { includeDeclaration: false },
        }),
      );
    });
  });

  // ─── diagnostics() ────────────────────────────────────
  describe('diagnostics()', () => {
    it('pull model 返回诊断列表', async () => {
      mockConn.sendRequest.mockResolvedValueOnce({
        kind: 'full',
        items: [
          {
            severity: 1, // Error
            message: '找不到类型或命名空间 "Foo"',
            range: {
              start: { line: 3, character: 10 },
              end: { line: 3, character: 13 },
            },
            source: 'csharp',
          },
          {
            severity: 2, // Warning
            message: '变量 "x" 已声明但从未使用',
            range: {
              start: { line: 7, character: 8 },
              end: { line: 7, character: 9 },
            },
            source: 'csharp',
          },
        ],
      });

      const result = await client.diagnostics('D:\\test\\File.cs');
      expect(result).toHaveLength(2);
      expect(result[0]!.severity).toBe('error');
      expect(result[0]!.message).toBe('找不到类型或命名空间 "Foo"');
      expect(result[0]!.source).toBe('csharp');
      expect(result[1]!.severity).toBe('warning');
    });

    it('pull model 不支持时返回空数组（不抛异常）', async () => {
      // 模拟 LSP server 不支持 textDocument/diagnostic（抛出 Method not found）
      mockConn.sendRequest.mockRejectedValueOnce(new Error('Method not found'));

      const result = await client.diagnostics('D:\\test\\File.cs');
      expect(result).toEqual([]);
      // didOpen 通知仍然发送了
      expect(mockConn.sendNotification).toHaveBeenCalled();
    });

    it('返回 null 结果时返回空数组', async () => {
      mockConn.sendRequest.mockResolvedValueOnce(null);
      const result = await client.diagnostics('D:\\test\\File.cs');
      expect(result).toEqual([]);
    });
  });

  // ─── documentSymbols() ────────────────────────────────
  describe('documentSymbols()', () => {
    it('递归格式化符号树，设置正确 depth 和 children', async () => {
      // 模拟包含嵌套子符号的 DocumentSymbol 数组
      mockConn.sendRequest.mockResolvedValueOnce([
        {
          name: 'MyClass',
          kind: 5, // Class
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
          children: [
            {
              name: 'DoWork',
              kind: 6, // Method
              range: { start: { line: 5, character: 2 }, end: { line: 10, character: 3 } },
              children: [],
            },
            {
              name: '_field',
              kind: 8, // Field
              range: { start: { line: 3, character: 2 }, end: { line: 3, character: 10 } },
              children: [],
            },
          ],
        },
      ]);

      const result = await client.documentSymbols('D:\\test\\File.cs');
      expect(result).toHaveLength(1);

      // 顶级符号 depth=0
      const cls = result[0]!;
      expect(cls.name).toBe('MyClass');
      expect(cls.kind).toBe('类');
      expect(cls.depth).toBe(0);
      expect(cls.children).toHaveLength(2);

      // 子符号 depth=1
      const method = cls.children[0]!;
      expect(method.name).toBe('DoWork');
      expect(method.kind).toBe('方法');
      expect(method.depth).toBe(1);
      expect(method.children).toHaveLength(0);

      const field = cls.children[1]!;
      expect(field.name).toBe('_field');
      expect(field.kind).toBe('字段');
      expect(field.depth).toBe(1);
    });

    it('返回 null 时返回空数组', async () => {
      mockConn.sendRequest.mockResolvedValueOnce(null);
      const result = await client.documentSymbols('D:\\test\\File.cs');
      expect(result).toEqual([]);
    });

    it('未知 SymbolKind 输出 kind_N 格式', async () => {
      // kind=99 不在 SYMBOL_KIND_MAP 中
      mockConn.sendRequest.mockResolvedValueOnce([
        {
          name: 'Unknown',
          kind: 99,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        },
      ]);

      const result = await client.documentSymbols('D:\\test\\File.cs');
      expect(result[0]!.kind).toBe('kind_99');
    });
  });

  // ─── callHierarchy() ──────────────────────────────────
  describe('callHierarchy()', () => {
    it('prepare 成功后返回 incoming + outgoing 调用层级', async () => {
      // 第一次 sendRequest: prepareCallHierarchy
      mockConn.sendRequest
        .mockResolvedValueOnce([
          {
            name: 'Calculate',
            kind: 6, // Method
            uri: 'file:///D:/test/File.cs',
            range: { start: { line: 10, character: 0 }, end: { line: 15, character: 1 } },
            selectionRange: { start: { line: 10, character: 4 }, end: { line: 10, character: 13 } },
          },
        ])
        // 第二次: incomingCalls
        .mockResolvedValueOnce([
          {
            from: {
              name: 'Main',
              kind: 6,
              uri: 'file:///D:/test/Program.cs',
              range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
              selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
            },
            fromRanges: [
              { start: { line: 5, character: 4 }, end: { line: 5, character: 13 } },
            ],
          },
        ])
        // 第三次: outgoingCalls
        .mockResolvedValueOnce([
          {
            to: {
              name: 'Helper',
              kind: 12, // Function
              uri: 'file:///D:/test/Helper.cs',
              range: { start: { line: 20, character: 0 }, end: { line: 25, character: 1 } },
              selectionRange: { start: { line: 20, character: 4 }, end: { line: 20, character: 10 } },
            },
            fromRanges: [
              { start: { line: 12, character: 4 }, end: { line: 12, character: 10 } },
            ],
          },
        ]);

      const result = await client.callHierarchy('D:\\test\\File.cs', 10, 5);

      expect(result.incoming).toHaveLength(1);
      expect(result.incoming[0]!.from.name).toBe('Main');
      expect(result.incoming[0]!.from.kind).toBe('方法');
      expect(result.incoming[0]!.from.filePath).toBe('D:\\test\\Program.cs');
      expect(result.incoming[0]!.ranges[0]!.start.line).toBe(5);

      expect(result.outgoing).toHaveLength(1);
      expect(result.outgoing[0]!.to.name).toBe('Helper');
      expect(result.outgoing[0]!.to.kind).toBe('函数');
      expect(result.outgoing[0]!.to.filePath).toBe('D:\\test\\Helper.cs');
    });

    it('prepare 返回 null 时返回空结果（不调用 incoming/outgoing）', async () => {
      mockConn.sendRequest.mockResolvedValueOnce(null);

      const result = await client.callHierarchy('D:\\test\\File.cs', 10, 5);
      expect(result).toEqual({ incoming: [], outgoing: [] });
      // 只调用了 prepare，没有调用 incoming/outgoing
      expect(mockConn.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('prepare 返回空数组时返回空结果', async () => {
      mockConn.sendRequest.mockResolvedValueOnce([]);

      const result = await client.callHierarchy('D:\\test\\File.cs', 10, 5);
      expect(result).toEqual({ incoming: [], outgoing: [] });
      expect(mockConn.sendRequest).toHaveBeenCalledTimes(1);
    });
  });

  // ─── toUri() / fromUri() 路径转换 ─────────────────────
  describe('toUri() / fromUri() Windows 路径转换', () => {
    it('toUri: Windows 反斜杠路径转 file:// URI', () => {
      const toUri = (client as any).toUri.bind(client) as (p: string) => string;
      expect(toUri('D:\\test\\File.cs')).toBe('file:///D:/test/File.cs');
      expect(toUri('C:\\Users\\dev\\proj\\src\\Main.ts')).toBe('file:///C:/Users/dev/proj/src/Main.ts');
    });

    it('fromUri: file:// URI 转 Windows 反斜杠路径', () => {
      const fromUri = (client as any).fromUri.bind(client) as (u: string) => string;
      expect(fromUri('file:///D:/test/File.cs')).toBe('D:\\test\\File.cs');
      expect(fromUri('file:///C:/Users/dev/proj/src/Main.ts')).toBe('C:\\Users\\dev\\proj\\src\\Main.ts');
    });

    it('toUri ↔ fromUri 双向转换一致性', () => {
      const toUri = (client as any).toUri.bind(client) as (p: string) => string;
      const fromUri = (client as any).fromUri.bind(client) as (u: string) => string;

      const windowsPath = 'D:\\Projects\\MyApp\\src\\Program.cs';
      expect(fromUri(toUri(windowsPath))).toBe(windowsPath);
    });
  });

  // ─── inferLanguageId() 间接测试（通过 syncDocument 的 sendNotification 参数验证） ──
  describe('inferLanguageId() 从扩展名推断语言（间接验证）', () => {
    /**
     * 辅助：调用 hover → syncDocument 发送 didOpen，
     * 从 sendNotification 的参数中提取 languageId。
     * 私有方法 inferLanguageId 无法直接访问，通过 side-effect 验证。
     */
    const getLanguageIdFor = async (filePath: string): Promise<string> => {
      mockConn.sendNotification.mockClear();
      await client.hover(filePath, 0, 0);
      // sendNotification 调用: (method, params) → 取最后一个 didOpen 调用
      const calls = mockConn.sendNotification.mock.calls.filter(
        (c: unknown[]) => c[0] === 'textDocument/didOpen',
      );
      return calls.at(-1)![1].textDocument.languageId;
    };

    it('C# → csharp', async () => {
      expect(await getLanguageIdFor('D:\\test\\Program.cs')).toBe('csharp');
    });

    it('TypeScript → typescript', async () => {
      expect(await getLanguageIdFor('/src/index.ts')).toBe('typescript');
    });

    it('Python → python', async () => {
      expect(await getLanguageIdFor('/app/main.py')).toBe('python');
    });

    it('Go → go', async () => {
      expect(await getLanguageIdFor('/cmd/main.go')).toBe('go');
    });

    it('Rust → rust', async () => {
      expect(await getLanguageIdFor('/src/lib.rs')).toBe('rust');
    });

    it('未知扩展名 → 扩展名本身', async () => {
      expect(await getLanguageIdFor('/data/file.xyz')).toBe('xyz');
    });
  });
});
