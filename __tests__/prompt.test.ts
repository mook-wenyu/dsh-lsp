/**
 * prompt.ts 单元测试：按会话 cwd 探测语言并按注册顺序分段注入。
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLspPrompt } from '../src/prompt.js';

/** 创建 mock systemPrompt.section，返回注册的 text 回调。 */
function installAndGetText(): (context: any) => string {
  let text: ((context: any) => string) | null = null;
  const ctx = {
    systemPrompt: {
      section: (entry: { name: string; order: number; text: (c: any) => string }) => {
        text = entry.text;
      },
    },
  };
  installLspPrompt(ctx as never);
  expect(text).toBeTruthy();
  return text!;
}

describe('installLspPrompt（按语言分段注入）', () => {
  it('注册段名 lsp:tools、order 125', async () => {
    const entry: { name?: string; order?: number; text?: any } = {};
    const ctx = {
      systemPrompt: {
        section: (e: { name: string; order: number; text: any }) => {
          entry.name = e.name;
          entry.order = e.order;
          entry.text = e.text;
        },
      },
    };
    installLspPrompt(ctx as never);
    expect(entry.name).toBe('lsp:tools');
    expect(entry.order).toBe(125);
  });

  it('C# 项目会话 → 仅注入 C# 段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-prompt-cs-'))
    await writeFile(join(root, 'App.csproj'), '')
    const text = installAndGetText()

    const out = text({ agent: { session: { header: { cwd: root } } } })
    expect(out).toContain('## C# LSP 工具')
    expect(out).not.toContain('TS/JS LSP 工具')
  })

  it('TS/JS 项目会话 → 仅注入 TS/JS 段；无 cwd 或非项目 → 空串', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-prompt-ts-'))
    await writeFile(join(root, 'tsconfig.json'), '')
    const text = installAndGetText()

    const out = text({ agent: { session: { header: { cwd: root } } } })
    expect(out).toContain('## TS/JS LSP 工具')
    expect(out).not.toContain('## C# LSP 工具')

    expect(text({ agent: {} })).toBe('')
    const empty = await mkdtemp(join(tmpdir(), 'dsh-lsp-prompt-empty-'))
    expect(text({ agent: { session: { header: { cwd: empty } } } })).toBe('')
  })

  it('monorepo 双语言会话 → 两段并列注入（C# 在前）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-prompt-mono-'))
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'App.slnx'), '')
    const text = installAndGetText()

    const out = text({ agent: { session: { header: { cwd: root } } } })
    expect(out.indexOf('## C# LSP 工具')).toBeLessThan(out.indexOf('## TS/JS LSP 工具'))
    expect(out).toContain('## TS/JS LSP 工具')
  })

  it('TS 段包含差异说明（callHierarchy 可用 / organizeImports 删除未使用）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-prompt-shape-'))
    await writeFile(join(root, 'jsconfig.json'), '{}')
    const text = installAndGetText()

    const out = text({ agent: { session: { header: { cwd: root } } } })
    expect(out).toContain('lsp_call_hierarchy')
    expect(out).toContain('会删除未使用 import')
  })
})