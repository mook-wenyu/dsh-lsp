/**
 * LSP 工具提示词段注册。
 *
 * 仅当会话 cwd 位于 C# 项目内（向上探测到 .slnx/.sln/.csproj）时注入，
 * 避免 Unity/Rust/TS 等非 C# 会话被无关工具目录污染上下文。
 *
 * 提示词为「双向决策边界」式（依据：EMNLP 2025《Tool Preferences in
 * Agentic LLMs are Unreliable》——纯描述性引导脆弱；Serena SKILL 的
 * when-to-use/when-not 双向边界；Anthropic 工具工程指南）：
 * - 符号级语义问题 → 必走 lsp_*（优于 read/grep）
 * - 文本模式搜索 → 仍用 grep/read（grep 是检索基线，LSP 不替代）
 * - 编辑 .cs 后以 lsp_diagnostics 零错误为完成判据
 *
 * 注意：宿主 systemPrompt.context 的 text 回调同步执行（不 await），
 * 项目探测必须使用 detectProjectRootSync。
 *
 * @module @echocore/dsh-lsp-client/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import { detectProjectRootSync } from './workspace-resolver.js'

/** 最小 systemPrompt 服务接口（与 DSH 宿主注入的形状对齐）。 */
interface SystemPromptService {
  context(entry: { name: string; order: number; text: (assembly: any) => string }): void;
}

/** 扩展 Context，声明 systemPrompt 服务（DSH 宿主提供）。 */
type DshContext = Omit<Context, 'tools' | 'systemPrompt'> & {
  systemPrompt: SystemPromptService;
};

/** systemPrompt.context 段名。 */
export const LSP_PROMPT_CONTEXT_NAME = 'lsp:tools';

/** 段排序：置于策略段之后，记忆快照之前（120-130 区间）。 */
export const LSP_PROMPT_CONTEXT_ORDER = 125;

/** 段文本内容（中文，双向决策边界式）。 */
const LSP_TOOLS_PROMPT = `## C# LSP 工具（14 个）

### 符号级问题必须用 lsp（优于 read/grep：语义精确、跨文件、零整文件加载）
- 查定义/跳转 → \`lsp_definition\`；查类型签名/文档 → \`lsp_hover\`
- 改名或重构前的影响面 → \`lsp_references\` 全量引用 + \`lsp_implement\` 实现
- 编辑 .cs 后 → \`lsp_diagnostics\` 确认零错误才算完成；有错配 \`lsp_code_action\`

### 文本搜索仍用 grep/read（不要绕道 lsp）
- 搜注释/字符串/TODO 等文本模式
- 不知道符号名的广度探索

### 其余
- 编写辅助：\`lsp_completion\`/\`lsp_signature\`；结构速览：\`lsp_document_symbols\`
- 清理：\`lsp_organize_imports\`+\`lsp_format\`；全局：\`lsp_workspace_diagnostics\`
- 行列 0-indexed；\`file_path\` 绝对路径`;

/**
 * 安装 LSP 提示词段到 systemPrompt.context。
 *
 * text 回调按当前 agent 会话 cwd 探测 C# 项目（向上找项目文件），
 * 命中才注入提示词；非 C# 会话返回空串（不贡献文本、零 token 占用）。
 * 同步探测：宿主对 text 返回值不 await。
 */
export function installLspPrompt(ctx: DshContext): void {
  ctx.systemPrompt.context({
    name: LSP_PROMPT_CONTEXT_NAME,
    order: LSP_PROMPT_CONTEXT_ORDER,
    text: (assembly) => {
      const cwd = assembly.agent?.session?.header?.cwd;
      if (!cwd) return '';
      return detectProjectRootSync(cwd) === undefined ? '' : LSP_TOOLS_PROMPT;
    },
  });
}
