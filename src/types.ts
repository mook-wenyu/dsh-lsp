/**
 * LSP 客户端插件类型定义。
 *
 * @module @echocore/dsh-lsp-client/types
 */

// 输出/位置类型使用 type alias：工具输出契约要求可赋给宿主 JsonValue 形状
// （对象字面量类型带隐式 index signature，interface 没有）。

/** LSP 位置（1-indexed 行列）。 */
export type LspPosition = {
  readonly line: number;
  readonly character: number;
};

/** LSP 文档位置（文件 + 位置）。 */
export type LspTextDocumentPosition = {
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
};

/** LSP 文件位置范围。 */
export type LspLocation = {
  readonly filePath: string;
  readonly range: {
    readonly start: LspPosition;
    readonly end: LspPosition;
  };
};

/** LSP 诊断严重级别映射。 */
export const DIAGNOSTIC_SEVERITY = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
} as const;

/** LSP 服务器运行状态。 */
export type LspServerState =
  | 'idle'        // 未启动
  | 'starting'    // 正在启动
  | 'ready'       // 可用
  | 'error'       // 启动失败或崩溃
  | 'disposed';   // 已关闭
