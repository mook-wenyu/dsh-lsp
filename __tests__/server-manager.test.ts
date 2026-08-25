/**
 * LspServerManager 单元测试。
 *
 * 使用 mock 子进程验证生命周期管理逻辑，
 * 不依赖真实的 csharp-ls 安装。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerManagerOptions } from '../src/server-manager.js';

/**
 * 注入开关：置 true 时 sendNotification 返回被拒 Promise，
 * 用于复现子进程流销毁后写入失败 → 未处理拒绝 → 宿主崩溃（ERR_STREAM_DESTROYED）。
 */
let rejectNotifications = false;

// Mock vscode-jsonrpc — 不需要真实连接
vi.mock('vscode-jsonrpc/node.js', () => ({
  createMessageConnection: vi.fn(() => ({
    sendRequest: vi.fn().mockResolvedValue({
      capabilities: {
        textDocument: { hover: {} },
        diagnosticProvider: { workspaceDiagnostics: true },
      },
      serverInfo: { name: 'mock-csharp-ls', version: '0.1.0' },
    }),
    sendNotification: vi.fn(() =>
      rejectNotifications ? Promise.reject(new Error('ERR_STREAM_DESTROYED')) : Promise.resolve(),
    ),
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Mock child_process.spawn
vi.mock('node:child_process', () => {
  const { EventEmitter } = require('node:events');
  const mockStdin = new EventEmitter();
  mockStdin.write = vi.fn();
  mockStdin.end = vi.fn();

  const mockStdout = new EventEmitter();
  mockStdout.setEncoding = vi.fn();

  const mockStderr = new EventEmitter();
  mockStderr.setEncoding = vi.fn();

  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.stdin = mockStdin;
      child.stdout = mockStdout;
      child.stderr = mockStderr;
      child.kill = vi.fn();
      // 延迟触发 exit，让 initialize 完成
      setTimeout(() => child.emit('exit', 0, null), 100);
      return child;
    }),
  };
});

function createTestOptions(overrides?: Partial<ServerManagerOptions>): ServerManagerOptions {
  return {
    command: 'csharp-ls',
    args: [],
    workspaceRoot: '/test/project',
    startupTimeoutMs: 5000,
    logLevel: 'warn',
    onStateChange: vi.fn(),
    onLog: vi.fn(),
    ...overrides,
  };
}

describe('LspServerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始状态为 idle', async () => {
    const { LspServerManager } = await import('../src/server-manager.js');
    const manager = new LspServerManager(createTestOptions());
    expect(manager.currentState).toBe('idle');
  });

  it('start() 后状态变为 ready', async () => {
    const { LspServerManager } = await import('../src/server-manager.js');
    const manager = new LspServerManager(createTestOptions());

    const conn = await manager.start();
    expect(conn).toBeDefined();
    expect(manager.currentState).toBe('ready');
    expect(manager.serverCapabilities).toBeDefined();
    expect(manager.serverInfo?.name).toBe('mock-csharp-ls');

  });

  it('重复 start() 复用已有连接', async () => {
    const { LspServerManager } = await import('../src/server-manager.js');
    const manager = new LspServerManager(createTestOptions());

    const conn1 = await manager.start();
    const conn2 = await manager.start();
    expect(conn1).toBe(conn2);
  });

  it('dispose() 后状态变为 disposed', async () => {
    const { LspServerManager } = await import('../src/server-manager.js');
    const manager = new LspServerManager(createTestOptions());

    await manager.start();
    await manager.dispose();
    expect(manager.currentState).toBe('disposed');
  });

  it('onStateChange 回调被正确调用', async () => {
    const onStateChange = vi.fn();
    const { LspServerManager } = await import('../src/server-manager.js');
    const manager = new LspServerManager(createTestOptions({ onStateChange }));

    await manager.start();
    await manager.dispose();

    // 至少被调用：idle → starting, starting → ready, ready → disposed
    expect(onStateChange).toHaveBeenCalled();
  });

  it('子进程退出（ready 态）后连接被废弃，避免写入已销毁流', async () => {
    const { LspServerManager } = await import('../src/server-manager.js');
    const { spawn } = await import('node:child_process');
    const manager = new LspServerManager(createTestOptions());

    await manager.start();
    expect(manager.activeConnection).not.toBeNull();

    // 取出被 mock 的子进程并模拟 csharp-ls 崩溃退出
    const child = (spawn as unknown as vi.Mock).mock.results[0].value;
    child.emit('exit', 1, null);

    // exit 处理器同步执行：activeConnection 立即置空，后续写入不会命中死流
    expect(manager.activeConnection).toBeNull();

    // 重建：start() 应拉起新连接而非复用死连接
    const conn2 = await manager.start();
    expect(conn2).not.toBeNull();
    expect(manager.activeConnection).not.toBeNull();

    await manager.dispose();
  });

  it('握手时 initialized 通知写入失败不会抛出未处理拒绝（崩溃回归）', async () => {
    rejectNotifications = true;
    const { LspServerManager } = await import('../src/server-manager.js');
    const manager = new LspServerManager(createTestOptions());

    const rejections: unknown[] = [];
    const onReject = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onReject);
    try {
      await manager.start();
      // 排空微任务，让潜在未处理拒绝浮现（Promise.resolve 不被 fake timers 伪造）
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onReject);
    }
    expect(rejections).toHaveLength(0);
    rejectNotifications = false;

    await manager.dispose();
  });

  it('dispose 时连接已销毁（dispose 抛错）不引发异常', async () => {
    const { LspServerManager } = await import('../src/server-manager.js');
    const { createMessageConnection } = await import('vscode-jsonrpc/node.js');
    (createMessageConnection as unknown as vi.Mock).mockImplementationOnce(() => ({
      sendRequest: vi.fn().mockResolvedValue({ capabilities: {}, serverInfo: { name: 'x' } }),
      sendNotification: vi.fn().mockReturnValue(Promise.resolve()),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      listen: vi.fn(),
      dispose: vi.fn(() => {
        throw new Error('already destroyed');
      }),
    }));

    const manager = new LspServerManager(createTestOptions());
    await manager.start();
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(manager.currentState).toBe('disposed');
  });

  it('initialize 后 supportsPull/supportsWorkspaceDiagnostic 反映服务器能力', async () => {
    const { LspServerManager } = await import('../src/server-manager.js');
    const manager = new LspServerManager(createTestOptions());
    await manager.start();
    expect(manager.supportsPull).toBe(true);
    expect(manager.supportsWorkspaceDiagnostic).toBe(true);
  });

  it('normalizeUri 在 Windows 上统一小写盘符', async () => {
    const { normalizeUri } = await import('../src/server-manager.js');
    if (process.platform !== 'win32') {
      // 非 Windows 平台不做大小写归一
      expect(normalizeUri('file:///D:/x/Y.cs')).toBe('file:///D:/x/Y.cs');
      return;
    }
    expect(normalizeUri('file:///D:/x/Y.cs')).toBe('file:///d:/x/Y.cs');
    // 已小写保持不变
    expect(normalizeUri('file:///d:/x/Y.cs')).toBe('file:///d:/x/Y.cs');
    // 非 file URI 不报错
    expect(normalizeUri('untitled:Untitled-1')).toBe('untitled:Untitled-1');
  });

  it('normalizeUri 解码百分号转义（tsserver 把盘符冒号编码为 %3A，缓存键失配回归锁）', async () => {
    const { normalizeUri } = await import('../src/server-manager.js');
    // ts-ls 推送形态：file:///d%3A/TSProjects/...（2026-08-25 集成实测）
    // 必须与查询/缓存键 file:///d:/TSProjects/... 归一为同一键
    const pushed = 'file:///d%3A/TSProjects/x/src/app.ts';
    const queried = 'file:///d:/TSProjects/x/src/app.ts';
    expect(normalizeUri(pushed)).toBe(normalizeUri(queried));
    // 常规特殊字符（空格）两种形态也归一（URL 规范化为 %20 编码形态）
    expect(normalizeUri('file:///d:/a b.ts')).toBe(normalizeUri('file:///d:/a%20b.ts'));
  });

  // ─── 多语言化（2026-08-25）：server→client 请求处理 / 语言差异参数 ──
  describe('多语言化', () => {
    it('注册 workspace/configuration handler：formattingOptions 按语言格式默认值应答', async () => {
      const { LspServerManager } = await import('../src/server-manager.js');
      const { createMessageConnection } = await import('vscode-jsonrpc/node.js');
      const manager = new LspServerManager(createTestOptions());
      await manager.start();

      const conn = (createMessageConnection as unknown as vi.Mock).mock.results[0].value;
      const handler = conn.onRequest.mock.calls.find(
        (c: unknown[]) => c[0] === 'workspace/configuration',
      )![1];

      // C# 语言（默认）：4/false
      expect(handler({ items: [{ section: 'formattingOptions' }] })).toEqual([
        { tabSize: 4, insertSpaces: false },
      ]);
      // 未知 section → null（不阻塞服务器）
      expect(handler({ items: [{ section: 'other' }] })).toEqual([null]);
      expect(handler(null)).toBeNull();
    });

    it('typescript 语言：formatDefaults 2/true，初始化选项含 hostInfo/tsserver，诊断等待 5000ms', async () => {
      const { LspServerManager } = await import('../src/server-manager.js');
      const { createMessageConnection } = await import('vscode-jsonrpc/node.js');
      const manager = new LspServerManager(createTestOptions({ languageId: 'typescript' }));

      expect(manager.formatDefaults).toEqual({ tabSize: 2, insertSpaces: true });
      expect(manager.diagnosticWatchMs).toBe(5000);

      // 配置覆盖：diagnosticWaitMs 优先于语言描述符默认
      const overridden = new LspServerManager(createTestOptions({ languageId: 'typescript', diagnosticWaitMs: 8000 }));
      expect(overridden.diagnosticWatchMs).toBe(8000);

      await manager.start();
      const conn = (createMessageConnection as unknown as vi.Mock).mock.results[0].value;
      const handler = conn.onRequest.mock.calls.find(
        (c: unknown[]) => c[0] === 'workspace/configuration',
      )![1];
      expect(handler({ items: [{ section: 'formattingOptions' }] })).toEqual([
        { tabSize: 2, insertSpaces: true },
      ]);

      // 初始化参数携带语言特定 options（hostInfo + tsserver fallbackPath）
      const initParams = conn.sendRequest.mock.calls.find(
        (c: unknown[]) => c[0] === 'initialize',
      )![1];
      expect(initParams.initializationOptions.hostInfo).toBe('dsh-lsp-client');
      expect(initParams.initializationOptions.tsserver.fallbackPath).toContain('typescript');
    });

    it('hasDiagnostics：区分「有推送（含空数组）」与「从未推送」', async () => {
      const { LspServerManager } = await import('../src/server-manager.js');
      const manager = new LspServerManager(createTestOptions());

      expect(manager.hasDiagnostics('file:///d:/x.ts')).toBe(false);
      manager.updateDiagnosticsCache('file:///D:/x.ts', []);
      // 键归一化后命中；空数组推送也算到达
      expect(manager.hasDiagnostics('file:///d:/x.ts')).toBe(true);
    });
  });
});
