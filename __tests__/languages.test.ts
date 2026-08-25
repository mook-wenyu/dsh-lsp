/**
 * 语言注册表（src/languages.ts）单元测试：路由、启动解析、描述符形状。
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  LANGUAGES,
  languageOfFile,
  lspLanguageIdOf,
  resolveServerLaunch,
  DEFAULT_LANGUAGE,
} from '../src/languages.js';

describe('languageOfFile（扩展名路由）', () => {
  it('.cs → csharp（含大写扩展名）', () => {
    expect(languageOfFile('d:\\src\\Program.cs')).toBe('csharp');
    expect(languageOfFile('/x/Y.CS')).toBe('csharp');
  });

  it('.ts/.tsx/.js/.jsx → typescript', () => {
    expect(languageOfFile('/src/index.ts')).toBe('typescript');
    expect(languageOfFile('/src/App.tsx')).toBe('typescript');
    expect(languageOfFile('/src/main.js')).toBe('typescript');
    expect(languageOfFile('/src/App.jsx')).toBe('typescript');
  });

  it('未支持扩展名（.py/.vue/无扩展）→ undefined', () => {
    expect(languageOfFile('/x/main.py')).toBeUndefined();
    expect(languageOfFile('/x/comp.vue')).toBeUndefined();
    expect(languageOfFile('/x/noext')).toBeUndefined();
  });
});

describe('lspLanguageIdOf（LSP languageId 映射）', () => {
  it('typescript 管理器：ts/tsx/js/jsx 各自映射', () => {
    expect(lspLanguageIdOf('/a.ts', 'typescript')).toBe('typescript');
    expect(lspLanguageIdOf('/a.tsx', 'typescript')).toBe('typescriptreact');
    expect(lspLanguageIdOf('/a.js', 'typescript')).toBe('javascript');
    expect(lspLanguageIdOf('/a.jsx', 'typescript')).toBe('javascriptreact');
  });

  it('csharp 管理器：cs → csharp；其他扩展名保留兜底（旧语义）', () => {
    expect(lspLanguageIdOf('/a.cs', 'csharp')).toBe('csharp');
    expect(lspLanguageIdOf('/a.ts', 'csharp')).toBe('typescript');
    expect(lspLanguageIdOf('/a.xyz', 'csharp')).toBe('xyz');
  });
});

describe('resolveServerLaunch（启动方式解析）', () => {
  it('csharp 默认 → 外部命令 csharp-ls，args 直传', () => {
    expect(resolveServerLaunch('csharp')).toEqual({ command: 'csharp-ls', args: [] });
    expect(resolveServerLaunch('csharp', undefined, ['--project', 'x'])).toEqual({
      command: 'csharp-ls',
      args: ['--project', 'x'],
    });
  });

  it('typescript 默认 → node 启动插件内置 CLI（路径存在）+ 固定 --stdio 参数', () => {
    const launch = resolveServerLaunch('typescript');
    expect(launch.command).toBe(process.execPath);
    expect(launch.args.length).toBe(2);
    // 内置 CLI 文件必须存在（dependencies 缺失会在此暴露）
    expect(existsSync(launch.args[0] as string)).toBe(true);
    expect(launch.args[0]).toContain('typescript-language-server');
    expect(launch.args[1]).toBe('--stdio');
  });

  it('用户覆盖 serverCommand 时原样使用（兼容 C# 先例，对全部语言生效）', () => {
    expect(resolveServerLaunch('typescript', 'my-ts-ls', ['--stdio'])).toEqual({
      command: 'my-ts-ls',
      args: ['--stdio'],
    });
    expect(resolveServerLaunch('csharp', 'my-ls')).toEqual({ command: 'my-ls', args: [] });
  });
});

describe('描述符形状（注册表完整性）', () => {
  it('csharp 与 typescript 均注册且标记齐全', () => {
    const cs = LANGUAGES.csharp;
    expect(cs.projectMarkers.map((m) => m.value)).toEqual(['.slnx', '.sln', '.csproj']);
    expect(cs.bundled).toBe(false);
    expect(cs.formatDefaults).toEqual({ tabSize: 4, insertSpaces: false });
    expect(cs.diagnosticWatchMs).toBe(0);
    expect(cs.promptSection).toContain('C#');

    const ts = LANGUAGES.typescript;
    expect(ts.projectMarkers.map((m) => m.value)).toEqual([
      'package.json',
      'tsconfig.json',
      'jsconfig.json',
    ]);
    expect(ts.bundled).toBe(true);
    expect(ts.formatDefaults).toEqual({ tabSize: 2, insertSpaces: true });
    expect(ts.diagnosticWatchMs).toBeGreaterThan(0);
    expect(ts.promptSection).toContain('TS/JS');
    expect(ts.initializationOptions).toHaveProperty('hostInfo');
    expect(ts.initializationOptions).toHaveProperty('tsserver');
  });

  it('DEFAULT_LANGUAGE 为 csharp（注册顺序首项）', () => {
    expect(DEFAULT_LANGUAGE).toBe('csharp');
  });
});