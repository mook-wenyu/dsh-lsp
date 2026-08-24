/**
 * 14 个 LSP 工具定义：经 defineTool 编译后注册到 DSH ToolRuntime。
 *
 * 关键契约（2026-08-23 真实宿主回归后确立，勿回退）：
 * - 必须用 @deepseek-ai/dsh-tools 的 defineTool 包装后再交 ctx.tools.register。
 *   直接注册裸定义时 parameters 仍是作者格式而非编译后的 JSON Schema，
 *   模型看到的工具签名非法 → 不生成任何参数（生产事故根因之一）。
 * - output.schema 必须与 execute 实际返回形状一致（顶层形状精确、元素宽松），
 *   宿主会对返回值做校验，声明与实返不符直接报 invalid output。
 * - 可空返回（signature/rename）用 oneOf [object, null]；type 数组不被支持。
 * - object 节点必须显式 additionalProperties（编译器强制）。
 *
 * 每个工具的 execute 调用 LspClient 对应方法，
 * output.render 将结构化结果转为紧凑的 ContentBlock[]。
 *
 * @module @echocore/dsh-lsp-client/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { LspClient, HoverResult, DiagnosticResult, DocumentSymbolResult, CallHierarchyResult, CodeActionResult, CompletionResult, SignatureResult, FormatEditResult, RenameResult, WorkspaceDiagnosticResult } from './lsp-client.js';

export interface LspExecutionContext {
  readonly agent?: {
    readonly id?: string
    readonly session?: { readonly header?: { readonly cwd?: string } }
    /** 宿主真实签名为 (message: UserMessage) => void；any 保证与宿主类型双向结构兼容 */
    readonly steer?: (message: any) => void
  }
}

export type LspClientResolver = (
  filePath: string | undefined,
  exec?: LspExecutionContext,
) => Promise<LspClient>

/** 宽松元素形状：数组项只约束「是对象」，不深入字段（LSP 返回嵌套深，收紧易再次失配）。 */
const LOOSE_OBJECT = { type: 'object' as const, additionalProperties: true as const };
/** 数组根输出 schema：适用于 client 返回数组的全部工具。 */
const ARRAY_OF_OBJECTS = { type: 'array' as const, items: LOOSE_OBJECT };

/**
 * 创建全部 14 个 LSP 工具定义。
 *
 * 接收 LspClientResolver（或单实例闭包），每个工具的 execute 经
 * resolveClient 定位会话/项目隔离的 LSP 实例后调用对应方法。
 */
export function createLspTools(clientOrResolver: LspClient | LspClientResolver) {
  const resolveClient: LspClientResolver = typeof clientOrResolver === 'function'
    ? clientOrResolver
    : async () => clientOrResolver
  return [
    // ─── 1. hover: 悬停信息（类型签名 + 文档） ────────────
    defineTool({
      name: 'lsp_hover',
      description:
        '查看 C# 标识符的类型签名与文档注释时必用，优于读源码。' +
        '返回 Markdown 格式类型信息；位置不精确时会尝试最近的符号。',
      parameters: {
        file_path: {
          type: 'string' as const,
          description: '文件绝对路径',
          required: true,
        },
        line: {
          type: 'integer' as const,
          description: '行号（0-indexed）',
          required: true,
        },
        column: {
          type: 'integer' as const,
          description: '列号（0-indexed）',
          required: true,
        },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: {
          type: 'object' as const,
          properties: {
            found: { type: 'boolean' as const, required: true },
            summary: { type: 'string' as const, required: true },
          },
          additionalProperties: false as const,
        },
        render(_args: unknown, value: unknown) {
          const r = value as HoverResult;
          if (!r.found) {
            return [{ type: 'text' as const, text: '未找到类型信息' }];
          }
          return [{ type: 'text' as const, text: r.summary }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column } = args as { file_path: string; line: number; column: number };
        const client = await resolveClient(file_path, exec);
        return await client.hover(file_path, line, column);
      },
    }),

    // ─── 2. definition: 跳转定义 ──────────────────────────
    defineTool({
      name: 'lsp_definition',
      description:
        '定位 C# 符号定义时必用，优于 grep 文本匹配（语义精确、无同名歧义）。' +
        '返回定义位置的文件路径与行列范围。',
      parameters: {
        file_path: {
          type: 'string' as const,
          description: '文件绝对路径',
          required: true,
        },
        line: {
          type: 'integer' as const,
          description: '行号（0-indexed）',
          required: true,
        },
        column: {
          type: 'integer' as const,
          description: '列号（0-indexed）',
          required: true,
        },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const locs = value as { filePath: string; range: { start: { line: number; character: number } } }[];
          if (locs.length === 0) {
            return [{ type: 'text' as const, text: '未找到定义' }];
          }
          const lines = locs.map(
            (l) => `→ ${l.filePath}:${l.range.start.line + 1}:${l.range.start.character + 1}`,
          );
          return [{ type: 'text' as const, text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column } = args as { file_path: string; line: number; column: number };
        const client = await resolveClient(file_path, exec);
        return await client.definition(file_path, line, column);
      },
    }),

    // ─── 3. references: 查找引用 ──────────────────────────
    defineTool({
      name: 'lsp_references',
      description:
        '重构影响分析必用：语义级全量引用，跨文件且无漏报，优于 grep 文本匹配。' +
        '返回引用文件与行列位置列表。',
      parameters: {
        file_path: {
          type: 'string' as const,
          description: '文件绝对路径',
          required: true,
        },
        line: {
          type: 'integer' as const,
          description: '行号（0-indexed）',
          required: true,
        },
        column: {
          type: 'integer' as const,
          description: '列号（0-indexed）',
          required: true,
        },
        include_declaration: {
          type: 'boolean' as const,
          description: '是否包含声明位置本身（默认 true）',
        },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const locs = value as { filePath: string; range: { start: { line: number; character: number } } }[];
          if (locs.length === 0) {
            return [{ type: 'text' as const, text: '未找到引用' }];
          }
          // 按文件分组统计
          const byFile = new Map<string, number>();
          for (const loc of locs) {
            byFile.set(loc.filePath, (byFile.get(loc.filePath) ?? 0) + 1);
          }
          const summary = [...byFile.entries()]
            .map(([f, c]) => `  ${f} (${c} 处)`)
            .join('\n');
          return [{ type: 'text' as const, text: `共 ${locs.length} 处引用，分布在 ${byFile.size} 个文件中：\n${summary}` }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column, include_declaration } = args as {
          file_path: string; line: number; column: number; include_declaration?: boolean;
        };
        const client = await resolveClient(file_path, exec);
        return await client.references(file_path, line, column, include_declaration ?? true);
      },
    }),

    // ─── 4. diagnostics: 编译诊断 ────────────────────────
    defineTool({
      name: 'lsp_diagnostics',
      description:
        '编辑 .cs 文件后必须调用：零错误才算编辑完成；发现错误后配对 lsp_code_action。' +
        '返回该文件的编译错误/警告/提示。',
      parameters: {
        file_path: {
          type: 'string' as const,
          description: '文件绝对路径',
          required: true,
        },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const items = value as DiagnosticResult[];
          const errors = items.filter((d) => d.severity === 'error');
          const warnings = items.filter((d) => d.severity === 'warning');
          if (items.length === 0) {
            return [{ type: 'text' as const, text: '✅ 无编译错误或警告' }];
          }
          const lines = [
            `${errors.length} 个错误，${warnings.length} 个警告：`,
            '',
            ...items.map(
              (d) => {
                // 展示完整位置信息（行:列）和诊断代码
                const pos = `行${d.range.start.line + 1}:列${d.range.start.character + 1}`;
                const code = d.code ? ` [${d.code}]` : '';
                const icon = d.severity === 'error' ? '❌' : d.severity === 'warning' ? '⚠️' : 'ℹ️';
                return `${icon} ${pos}${code}: ${d.message}`;
              },
            ),
          ];
          return [{ type: 'text' as const, text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const { file_path } = args as { file_path: string };
        const client = await resolveClient(file_path, exec);
        return await client.diagnostics(file_path);
      },
    }),

    // ─── 5. documentSymbols: 文件符号 ─────────────────────
    defineTool({
      name: 'lsp_document_symbols',
      description:
        '了解 C# 文件结构时必用，优于读取整个文件。' +
        '以层级树返回全部符号（类/方法/属性/字段）及行号。',
      parameters: {
        file_path: {
          type: 'string' as const,
          description: '文件绝对路径',
          required: true,
        },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const syms = value as DocumentSymbolResult[];
          if (syms.length === 0) {
            return [{ type: 'text' as const, text: '未找到符号' }];
          }
          const lines = formatSymbolTree(syms);
          return [{ type: 'text' as const, text: `${syms.length} 个顶级符号：\n${lines}` }];
        },
      },
      async execute(args, exec) {
        const { file_path } = args as { file_path: string };
        const client = await resolveClient(file_path, exec);
        return await client.documentSymbols(file_path);
      },
    }),

    // ─── 6. callHierarchy: 调用层级 ──────────────────────
    defineTool({
      name: 'lsp_call_hierarchy',
      description:
        '分析 C# 方法调用层级（谁调用了它/它调用了谁），用于调用链路与重构影响分析。' +
        '注意：csharp-ls 0.26.0 未声明该能力，当前会返回服务器错误。',
      parameters: {
        file_path: {
          type: 'string' as const,
          description: '文件绝对路径',
          required: true,
        },
        line: {
          type: 'integer' as const,
          description: '行号（0-indexed）',
          required: true,
        },
        column: {
          type: 'integer' as const,
          description: '列号（0-indexed）',
          required: true,
        },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: {
          type: 'object' as const,
          properties: {
            incoming: { type: 'array' as const, required: true, items: LOOSE_OBJECT },
            outgoing: { type: 'array' as const, required: true, items: LOOSE_OBJECT },
          },
          additionalProperties: false as const,
        },
        render(_args: unknown, value: unknown) {
          const r = value as CallHierarchyResult;
          const parts: string[] = [];
          if (r.incoming.length > 0) {
            parts.push(
              `📥 被 ${r.incoming.length} 处调用：`,
              ...r.incoming.map(
                (c) => `  ← ${c.from.name} (${c.from.kind}) @ ${c.from.filePath}:${c.ranges[0] ? c.ranges[0].start.line + 1 : '?'}`,
              ),
            );
          }
          if (r.outgoing.length > 0) {
            parts.push(
              `📤 调用了 ${r.outgoing.length} 处：`,
              ...r.outgoing.map(
                (c) => `  → ${c.to.name} (${c.to.kind}) @ ${c.to.filePath}:${c.ranges[0] ? c.ranges[0].start.line + 1 : '?'}`,
              ),
            );
          }
          if (parts.length === 0) {
            parts.push('未找到调用层级信息');
          }
          return [{ type: 'text' as const, text: parts.join('\n') }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column } = args as { file_path: string; line: number; column: number };
        const client = await resolveClient(file_path, exec);
        return await client.callHierarchy(file_path, line, column);
      },
    }),

    // ─── 7. codeAction: 代码修复建议 ──────────────────────
    defineTool({
      name: 'lsp_code_action',
      description:
        'lsp_diagnostics 报错后的配对操作：传入诊断位置获取 quickfix 修复建议' +
        '（如添加缺失 using、修复类型错误），编辑动作需用编辑工具应用。',
      parameters: {
        file_path: {
          type: 'string' as const,
          description: '文件绝对路径',
          required: true,
        },
        line: {
          type: 'integer' as const,
          description: '诊断起始行号（0-indexed，从 lsp_diagnostics 获取）',
          required: true,
        },
        column: {
          type: 'integer' as const,
          description: '诊断起始列号（0-indexed，从 lsp_diagnostics 获取）',
          required: true,
        },
        end_line: {
          type: 'integer' as const,
          description: '诊断结束行号（0-indexed，默认等于 line）',
        },
        end_column: {
          type: 'integer' as const,
          description: '诊断结束列号（0-indexed，默认等于 column + 1）',
        },
        diagnostic_code: {
          type: 'string' as const,
          description: '诊断代码（如 CS0029，从 lsp_diagnostics 获取）。可选，提供后缩小修复范围。',
        },
        diagnostic_message: {
          type: 'string' as const,
          description: '诊断消息文本（从 lsp_diagnostics 获取）。用于匹配特定诊断。',
        },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const actions = value as CodeActionResult[];
          if (actions.length === 0) {
            return [{ type: 'text' as const, text: '未找到可用的修复建议' }];
          }
          const lines = [`找到 ${actions.length} 个修复建议：`, ''];
          for (const action of actions) {
            const preferred = action.isPreferred ? ' ⭐推荐' : '';
            lines.push(`📌 ${action.title}${preferred}`);
            // 展示编辑摘要：修改了哪些文件
            if (action.edits.length > 0) {
              const byFile = new Map<string, number>();
              for (const edit of action.edits) {
                byFile.set(edit.filePath, (byFile.get(edit.filePath) ?? 0) + 1);
              }
              for (const [f, c] of byFile) {
                lines.push(`   📝 ${f} (${c} 处编辑)`);
              }
              // 展示第一个编辑的替换预览（如果有）
              const first = action.edits[0]!;
              if (first.newText.length <= 200) {
                lines.push(`   预览: "${first.newText.trim()}"`);
              }
            }
          }
          return [{ type: 'text' as const, text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column, end_line, end_column, diagnostic_code, diagnostic_message } = args as {
          file_path: string; line: number; column: number;
          end_line?: number; end_column?: number;
          diagnostic_code?: string; diagnostic_message?: string;
        };
        const range = {
          start: { line, character: column },
          end: { line: end_line ?? line, character: end_column ?? column + 1 },
        };
        const diagnostics: DiagnosticResult[] = diagnostic_message
          ? [{ severity: 'error', message: diagnostic_message, range, code: diagnostic_code }]
          : [];
        const client = await resolveClient(file_path, exec);
        return await client.codeAction(file_path, range, diagnostics, ['quickfix']);
      },
    }),

    // ─── 8. completion: 智能补全 ──────────────────────────
    defineTool({
      name: 'lsp_completion',
      description:
        '编写 C# 代码时获取光标处智能补全，优于凭记忆猜测 API 名称。' +
        '返回可用类/方法/属性/关键字及文档。',
      parameters: {
        file_path: { type: 'string' as const, description: '文件绝对路径', required: true },
        line: { type: 'integer' as const, description: '行号（0-indexed）', required: true },
        column: { type: 'integer' as const, description: '列号（0-indexed，光标位置）', required: true },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const items = value as CompletionResult[];
          if (items.length === 0) return [{ type: 'text' as const, text: '无可用补全建议' }];
          const lines = [`共 ${items.length} 个补全项：`, ''];
          for (const item of items.slice(0, 15)) {
            const doc = item.documentation ? ` — ${item.documentation.slice(0, 60)}` : '';
            lines.push(`  ${item.kind} ${item.label}${doc}`);
          }
          return [{ type: 'text' as const, text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column } = args as { file_path: string; line: number; column: number };
        const client = await resolveClient(file_path, exec);
        return await client.completion(file_path, line, column);
      },
    }),

    // ─── 9. signature: 方法签名提示 ──────────────────────────
    defineTool({
      name: 'lsp_signature',
      description:
        '调用 C# 方法前确认参数列表，优于读定义。' +
        '返回调用处的方法签名、参数说明与当前活跃参数。' +
        '需光标位于参数括号内；构造函数调用可能无返回（csharp-ls 限制）。',
      parameters: {
        file_path: { type: 'string' as const, description: '文件绝对路径', required: true },
        line: { type: 'integer' as const, description: '行号（0-indexed）', required: true },
        column: { type: 'integer' as const, description: '列号（0-indexed，括号内光标位置）', required: true },
      },
      isConcurrencySafe() { return true; },
      output: {
        // signatureHelp 返回 SignatureResult | null —— 可空契约用 oneOf 表达
        schema: {
          oneOf: [LOOSE_OBJECT, { type: 'null' as const }],
        },
        render(_args: unknown, value: unknown) {
          const r = value as SignatureResult | null;
          if (!r) return [{ type: 'text' as const, text: '未找到签名信息' }];
          const lines = [`📌 ${r.label}`];
          if (r.documentation) lines.push(r.documentation);
          if (r.parameters.length > 0) {
            lines.push('', '参数：');
            for (let i = 0; i < r.parameters.length; i++) {
              const p = r.parameters[i]!;
              const active = i === r.activeParameter ? ' 👈' : '';
              const doc = p.documentation ? ` — ${p.documentation.slice(0, 50)}` : '';
              lines.push(`  ${i + 1}. ${p.label}${active}${doc}`);
            }
          }
          return [{ type: 'text' as const, text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column } = args as { file_path: string; line: number; column: number };
        const client = await resolveClient(file_path, exec);
        return await client.signatureHelp(file_path, line, column);
      },
    }),

    // ─── 10. format: 文档格式化 ──────────────────────────
    defineTool({
      name: 'lsp_format',
      description:
        '格式化 C# 文件（全文或指定范围），返回需用编辑工具应用的编辑列表。' +
        '自动调整缩进、空格、换行等风格。',
      parameters: {
        file_path: { type: 'string' as const, description: '文件绝对路径', required: true },
        start_line: { type: 'integer' as const, description: '格式化起始行（0-indexed，省略则格式化全文）' },
        end_line: { type: 'integer' as const, description: '格式化结束行（0-indexed，配合 start_line 使用）' },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const edits = value as FormatEditResult[];
          if (edits.length === 0) return [{ type: 'text' as const, text: '✅ 代码已符合格式规范，无需修改' }];
          return [{ type: 'text' as const, text: `返回 ${edits.length} 处格式化编辑，请应用到文件` }];
        },
      },
      async execute(args, exec) {
        const { file_path, start_line, end_line } = args as { file_path: string; start_line?: number; end_line?: number };
        const range = start_line != null
          ? { start: { line: start_line, character: 0 }, end: { line: end_line ?? start_line, character: 0 } }
          : undefined;
        const client = await resolveClient(file_path, exec);
        return await client.format(file_path, range);
      },
    }),

    // ─── 11. rename: 跨文件重命名 ──────────────────────────
    defineTool({
      name: 'lsp_rename',
      description:
        'C# 符号重命名必用，优于手动 grep+逐处替换（语义精确、自动覆盖全部引用）。' +
        '返回影响的文件数与编辑计划，需用编辑工具应用。',
      parameters: {
        file_path: { type: 'string' as const, description: '文件绝对路径', required: true },
        line: { type: 'integer' as const, description: '符号所在行号（0-indexed）', required: true },
        column: { type: 'integer' as const, description: '符号所在列号（0-indexed）', required: true },
        new_name: { type: 'string' as const, description: '新名称', required: true },
      },
      isConcurrencySafe() { return true; },
      output: {
        // rename 返回 RenameResult | null —— 可空契约用 oneOf 表达
        schema: {
          oneOf: [LOOSE_OBJECT, { type: 'null' as const }],
        },
        render(_args: unknown, value: unknown) {
          const r = value as RenameResult | null;
          if (!r) return [{ type: 'text' as const, text: '❌ 无法重命名（该位置不是可重命名的符号）' }];
          return [{ type: 'text' as const, text: `✅ 重命名 "${r.newName}" → 影响 ${r.affectedFiles} 个文件，${r.totalEdits} 处编辑` }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column, new_name } = args as { file_path: string; line: number; column: number; new_name: string };
        const client = await resolveClient(file_path, exec);
        return await client.rename(file_path, line, column, new_name);
      },
    }),

    // ─── 12. implement: 跳转到实现 ──────────────────────────
    defineTool({
      name: 'lsp_implement',
      description:
        '查找 C# 接口/抽象成员的实现位置，优于 grep 猜测实现。' +
        '用于查看接口被哪些类实现、抽象方法被哪些子类重写。',
      parameters: {
        file_path: { type: 'string' as const, description: '文件绝对路径', required: true },
        line: { type: 'integer' as const, description: '行号（0-indexed）', required: true },
        column: { type: 'integer' as const, description: '列号（0-indexed）', required: true },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const locs = value as { filePath: string; range: { start: { line: number } } }[];
          if (locs.length === 0) return [{ type: 'text' as const, text: '未找到实现' }];
          const lines = locs.map((l) => `→ ${l.filePath}:${l.range.start.line + 1}`);
          return [{ type: 'text' as const, text: `${locs.length} 个实现：\n${lines.join('\n')}` }];
        },
      },
      async execute(args, exec) {
        const { file_path, line, column } = args as { file_path: string; line: number; column: number };
        const client = await resolveClient(file_path, exec);
        return await client.implementation(file_path, line, column);
      },
    }),

    // ─── 13. organizeImports: 自动整理 using ─────────────────
    defineTool({
      name: 'lsp_organize_imports',
      description:
        '整理 C# 文件的 using 语句（补缺失、按字母排序），返回需用编辑工具应用的编辑列表。' +
        '注意：csharp-ls 不删除未使用 using——清理用 lsp_diagnostics 查 CS8019 后配 lsp_code_action。',
      parameters: {
        file_path: { type: 'string' as const, description: '文件绝对路径', required: true },
      },
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const edits = value as FormatEditResult[];
          if (edits.length === 0) return [{ type: 'text' as const, text: '✅ using 语句已规范，无需修改' }];
          return [{ type: 'text' as const, text: `返回 ${edits.length} 处 using 编辑，请应用到文件` }];
        },
      },
      async execute(args, exec) {
        const { file_path } = args as { file_path: string };
        const client = await resolveClient(file_path, exec);
        return await client.organizeImports(file_path);
      },
    }),

    // ─── 14. workspaceDiagnostics: 全局诊断 ──────────────────
    defineTool({
      name: 'lsp_workspace_diagnostics',
      description:
        '提交/收尾前的 C# 全局健康检查：按文件分组汇总已探明文件的最近诊断' +
        '（调用过 lsp_diagnostics 的文件 + 收到服务器推送的文件）。',
      parameters: {},
      isConcurrencySafe() { return true; },
      output: {
        schema: ARRAY_OF_OBJECTS,
        render(_args: unknown, value: unknown) {
          const files = value as WorkspaceDiagnosticResult[];
          if (files.length === 0) return [{ type: 'text' as const, text: '暂无工作区诊断数据' }];
          let totalErrors = 0, totalWarnings = 0;
          const lines: string[] = [];
          for (const f of files) {
            const errs = f.diagnostics.filter((d) => d.severity === 'error');
            const warns = f.diagnostics.filter((d) => d.severity === 'warning');
            totalErrors += errs.length;
            totalWarnings += warns.length;
            if (errs.length > 0 || warns.length > 0) {
              lines.push(`📄 ${f.filePath.split(/[/\\]/).pop()}: ${errs.length} 错误, ${warns.length} 警告`);
            }
          }
          if (lines.length === 0) return [{ type: 'text' as const, text: `✅ ${files.length} 个文件均无错误` }];
          return [{ type: 'text' as const, text: `${files.length} 个文件，${totalErrors} 错误，${totalWarnings} 警告：\n${lines.join('\n')}` }];
        },
      },
      async execute(args, exec) {
        return await resolveClient(undefined, exec).then((client) => client.workspaceDiagnostics());
      },
    }),
  ];
}

/** 递归格式化符号树为缩进文本。 */
function formatSymbolTree(syms: DocumentSymbolResult[], indent = ''): string {
  return syms
    .map((s) => {
      const pos = `(${s.range.start.line + 1})`;
      const line = `${indent}${s.kind} ${s.name} ${pos}`;
      if (s.children.length > 0) {
        return line + '\n' + formatSymbolTree(s.children, indent + '  ');
      }
      return line;
    })
    .join('\n');
}
