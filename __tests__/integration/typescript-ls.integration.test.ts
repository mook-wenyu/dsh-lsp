/**
 * typescript-language-server 真实集成测试（多语言化，2026-08-25）。
 *
 * 走生产装配路径（与 src/index.ts 同构）：
 * - resolveServerLaunch('typescript') 解析内置 CLI → LspServerManager 子进程拉起
 * - 真实 initialize 握手（含 tsserver initOptions + workspace/configuration handler）
 * - LspClient 全部 14 个语义化工具逐一验证（含 push 诊断等待、documentChanges 归一）
 *
 * 前提：插件 dependencies 已安装（typescript-language-server + typescript），
 * 无需全局安装——这正是 bundled 模型的价值（区别于 csharp-ls 集成测试）。
 *
 * 已知差异（与 csharp-ls 对照）：
 * - TS/JS 走 push 诊断（LspClient 内等待推送，非 pull）
 * - callHierarchy 真实可用（csharp-ls 不支持）
 * - organizeImports 会删除未使用 import（csharp-ls 不删）
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LspServerManager } from '../../src/server-manager.js';
import { LspClient } from '../../src/lsp-client.js';
import { resolveServerLaunch } from '../../src/languages.js';

const TS_PROJECT_DIR = resolve(__dirname, '../../test-project-ts');
const APP_TS = join(TS_PROJECT_DIR, 'src', 'app.ts');
const MATH_TS = join(TS_PROJECT_DIR, 'src', 'math.ts');
const JS_PROJECT_DIR = resolve(__dirname, '../../test-project-js');
const A_JS = join(JS_PROJECT_DIR, 'a.js');

const bundledAvailable = existsSync(resolveServerLaunch('typescript').args[0] as string) &&
  existsSync(resolve(__dirname, '../../node_modules/typescript/package.json'));

describe.skipIf(!bundledAvailable)('typescript-language-server 真实集成测试', () => {
  let manager: LspServerManager;
  let client: LspClient;

  beforeAll(async () => {
    manager = new LspServerManager({
      languageId: 'typescript',
      command: resolveServerLaunch('typescript').command,
      args: resolveServerLaunch('typescript').args,
      workspaceRoot: TS_PROJECT_DIR,
      startupTimeoutMs: 30_000,
      logLevel: 'warn',
      onLog: (level, message) => console.log(`[ts-ls ${level}] ${message}`),
    });
    client = new LspClient(manager);
    await manager.start();
    console.log(`[integration] ts server ready: ${manager.serverInfo?.name} v${manager.serverInfo?.version}`);

    // 暖机：项目加载完成的确定性信号 = 完整诊断推送（含语义错误 TS2322 与 TS2339）
    // tsserver 分波推送（suggestion 6133 先到，语义错误后到）；等全量到达再跑测试
    const uri = 'file:///' + APP_TS.replace(/\\/g, '/');
    const deadline = Date.now() + 15_000;
    await client.hover(APP_TS, 3, 10); // 触发 didOpen
    const codes = () => manager.getDiagnostics(uri)?.map((d) => String(d.code)) ?? [];
    while (!(codes().includes('2322') && codes().includes('2339')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`[integration] 暖机完成，诊断 codes: ${codes().join(',')}`);
  }, 60_000);

  afterAll(async () => {
    await manager.dispose();
  }, 10_000);

  // ─── 生命周期与能力 ──────────────────────────────
  it('initialize 握手成功；push-only 服务器（无 pull 诊断声明）', () => {
    expect(manager.serverCapabilities).not.toBeNull();
    expect(manager.supportsPull).toBe(false);
    expect(manager.supportsWorkspaceDiagnostic).toBe(false);
  });

  // ─── 符号级工具 ──────────────────────────────────
  it('hover — add 函数签名', async () => {
    // app.ts line 3: "const n = add(1, 2);" — 'add' 从 char 10 开始
    const result = await client.hover(APP_TS, 3, 10);
    expect(result.found).toBe(true);
    expect(result.summary).toContain('add');
  });

  it('definition — 跳转到 add 定义（跨文件 math.ts）', async () => {
    const locs = await client.definition(APP_TS, 3, 10);
    expect(locs.length).toBeGreaterThan(0);
    expect(locs[0]!.filePath).toContain('math.ts');
  });

  it('references — add 的语义级全量引用（跨文件、含声明）', async () => {
    // math.ts line 4: "export function add(a: number, b: number): number {" — 'add' char 16
    const locs = await client.references(MATH_TS, 4, 16, true);
    expect(locs.length).toBeGreaterThanOrEqual(2);
    const files = new Set(locs.map((l) => l.filePath));
    expect(files.size).toBeGreaterThanOrEqual(2); // math.ts + app.ts
  });

  it('implementation — Shape 接口的实现是 Circle', async () => {
    // math.ts line 0: "export interface Shape { area(): number }" — 'Shape' char 17
    const locs = await client.implementation(MATH_TS, 0, 17);
    expect(locs.length).toBeGreaterThan(0);
    // Circle 类声明在第 6 行
    expect(locs.some((l) => l.range.start.line >= 6)).toBe(true);
  });

  it('documentSymbols — 层级符号树含 add/Circle/Shape', async () => {
    const syms = await client.documentSymbols(MATH_TS);
    const names = syms.map((s) => s.name);
    expect(names).toContain('add');
    expect(names).toContain('Circle');
    expect(names).toContain('Shape');
    const circle = syms.find((s) => s.name === 'Circle');
    expect(circle!.children.length).toBeGreaterThan(0); // constructor/area
  });

  it('callHierarchy — ts-ls 声明能力但请求处理器未注册，返回服务器错误（能力边界）', async () => {
    // app.ts line 7: "export function main(): void {" — 'main' char 16
    // typescript-language-server 5.3.0：声明 callHierarchyProvider（客户端声明
    // textDocument.callHierarchy 后），但 prepareCallHierarchy 请求处理器未注册，
    // 实测返回 Method not found（Unhandled method）——与 csharp-ls 同为能力边界。
    await expect(client.callHierarchy(APP_TS, 7, 16)).rejects.toThrow();
  });

  // ─── 编写辅助 ────────────────────────────────────
  it('completion — Math. 后补全成员（成员补全，非标识符补全）', async () => {
    // app.ts line 8: "  console.log(Math.);" — '.' 后 char 19
    // 断言取字母序首位的成员 abs（PI 会被客户端的 30 项截断裁掉，不可作断言）
    const items = await client.completion(APP_TS, 8, 19);
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.label)).toContain('abs');
  });

  it('signatureHelp — add( 括号内签名', async () => {
    // app.ts line 3: "const n = add(1, 2);" — 括号内 char 14
    const result = await client.signatureHelp(APP_TS, 3, 14);
    expect(result).not.toBeNull();
    expect(result!.label).toContain('add');
  });

  // ─── 诊断链路（push 等待：核心新能力） ──────────────────
  it('diagnostics — 等待推送后返回 TS2322 错误（push-only；code 为纯数字）', async () => {
    const diags = await client.diagnostics(APP_TS);
    expect(diags.map((d) => String(d.code))).toContain('2322');
  });

  it('lsp_workspace_diagnostics 语义 — 已探明文件的聚合含 app.ts 错误', async () => {
    const files = await client.workspaceDiagnostics();
    const app = files.find((f) => f.filePath.includes('app.ts'));
    expect(app).toBeDefined();
    expect(app!.diagnostics.map((d) => String(d.code))).toContain('2322');
  });

  // ─── 编辑计划（不落盘） ──────────────────────────
  it('format — 全文格式化返回编辑列表', async () => {
    const edits = await client.format(APP_TS);
    expect(Array.isArray(edits)).toBe(true);
  });

  it('rename — add 跨文件重命名编辑计划（含 documentChanges 归一）', async () => {
    // math.ts line 4 char 16：add 定义处
    const result = await client.rename(MATH_TS, 4, 16, 'sum');
    expect(result).not.toBeNull();
    expect(result!.affectedFiles).toBeGreaterThanOrEqual(2); // math.ts + app.ts
    expect(result!.totalEdits).toBeGreaterThanOrEqual(2);
  });

  it('organizeImports — 删除未使用 import（TS/JS 强于 C#；无错误文件走破坏性模式）', async () => {
    // 干净夹具文件（无错误）：ts-ls 在此模式用 All（含删除），行为确定
    const clean = join(TS_PROJECT_DIR, 'src', 'clean-imports.ts');
    const edits = await client.organizeImports(clean);
    expect(edits.length).toBeGreaterThan(0);
    // 删掉了未使用的 unusedThing import（编辑文本不再包含该名字）
    expect(edits.some((e) => e.newText.includes('unusedThing'))).toBe(false);
  });

  it('codeAction — 未使用 import 的确定性 quickfix（Remove import）', async () => {
    // TS6133（未使用 import，确定性存在，且有固定 quickfix "Remove import from './math'"）
    const diags = await client.diagnostics(APP_TS);
    const unused = diags.find((d) => String(d.code) === '6133' && d.range.start.line === 1);
    expect(unused, `诊断 codes: ${diags.map((d) => d.code).join(',')}`).toBeDefined();

    const actions = await client.codeAction(APP_TS, unused!.range, [{
      severity: 'warning',
      message: unused!.message,
      range: unused!.range,
      code: '6133',
    }], ['quickfix']);
    console.log('[integration] codeAction titles:', actions.map((a) => a.title));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.title.includes('Remove import'))).toBe(true);
  });

  // ─── JS（checkJs / jsconfig） ─────────────────────
  it('jsconfig 工程：checkJs 诊断 double("nope") 类型错误', async () => {
    const jsManager = new LspServerManager({
      languageId: 'typescript',
      command: resolveServerLaunch('typescript').command,
      args: resolveServerLaunch('typescript').args,
      workspaceRoot: JS_PROJECT_DIR,
      startupTimeoutMs: 30_000,
      logLevel: 'error',
    });
    const jsClient = new LspClient(jsManager);
    try {
      await jsManager.start();
      const diags = await jsClient.diagnostics(A_JS);
      // double('nope')：string 传给 number 参数 → TS2345（checkJs 下必报）
      expect(diags.some((d) => d.severity === 'error')).toBe(true);
    } finally {
      await jsManager.dispose();
    }
  }, 60_000);
});