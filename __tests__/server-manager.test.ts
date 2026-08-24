/**
 * LspServerManager 单元测试。
 *
 * 使用 mock 子进程验证生命周期管理逻辑，
 * 不依赖真实的 csharp-ls 安装。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerManagerOptions } from '../src/server-manager.js';

// Mock vscode-jsonrpc — 不需要真实连接
vi.mock('vscode-jsonrpc/node.js', () => ({
  createMessageConnection: vi.fn(() => ({
    sendRequest: vi.fn().mockResolvedValue({
      capabilities: { textDocument: { hover: {} } },
      serverInfo: { name: 'mock-csharp-ls', version: '0.1.0' },
    }),
    sendNotification: vi.fn(),
    onNotification: vi.fn(),
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
});
