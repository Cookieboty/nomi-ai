/** preload 里注入的 Electron 模块的最小形状（不静态引 `electron`：测试与 lint 友好） */

export interface PreloadIpcRendererLike {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  off?: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  removeListener?: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ) => unknown;
}

export interface PreloadContextBridgeLike {
  exposeInMainWorld: (apiKey: string, api: unknown) => void;
}

/** `electron.webUtils` 的子集 */
export interface PreloadWebUtilsLike {
  getPathForFile: (file: File) => string;
}
