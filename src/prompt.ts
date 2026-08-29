/**
 * LSP 工具提示词段注册（多语言化，2026-08-25）。
 *
 * 仅当会话 cwd 位于受支持项目内（向上探测到对应语言的项目标记）时注入：
 * - C#：.slnx/.sln/.csproj；TS/JS：package.json/tsconfig.json/jsconfig.json。
 * - 语言文案来自语言注册表（LANGUAGES[lang].promptSection），双向决策边界式。
 * - monorepo（cwd 同时命中多语言）按注册顺序并列注入各语言段。
 * - 非受支持项目会话零注入（与 C# 先例一致，避免无关工具目录污染上下文）。
 *
 * 注意：宿主 systemPrompt.context 的 text 回调同步执行（不 await），
 * 项目探测必须使用 detectProjectLanguagesSync。
 *
 * @module @echocore/dsh-lsp-client/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import { detectProjectLanguagesSync } from './workspace-resolver.js'
import { LANGUAGES, type LanguageId } from './languages.js'

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

/**
 * 安装 LSP 提示词段到 systemPrompt.context。
 *
 * text 回调按当前 agent 会话 cwd 探测受支持语言（向上找项目标记），
 * 命中语言的段落按注册顺序拼接注入；无命中返回空串（零 token 占用）。
 * 同步探测：宿主对 text 返回值不 await。
 */
export function installLspPrompt(ctx: DshContext): void {
  ctx.systemPrompt.context({
    name: LSP_PROMPT_CONTEXT_NAME,
    order: LSP_PROMPT_CONTEXT_ORDER,
    text: (assembly) => {
      const cwd = assembly.agent?.session?.header?.cwd;
      if (!cwd) return '';
      const detected = detectProjectLanguagesSync(cwd);
      const sections = (Object.keys(LANGUAGES) as LanguageId[])
        .filter((lang) => detected[lang] !== undefined)
        .map((lang) => LANGUAGES[lang].promptSection);
      return sections.join('\n\n');
    },
  });
}