/**
 * 终端启动命令（主进程 gateway/TerminalCommands.ts，docs/design/unified-gateway.md §12.6）。
 * 打开后生成 ~/.nomi/bin/nomi-claude 等脚本；只有用户确认后才改 shell 配置文件加 PATH。
 * 应用契约 `gateway.terminalState` / `gateway.terminalSet`。
 */
import { api, hasTransport } from './api';

export interface TerminalCommandsState {
  enabled: boolean;
  pathAdded: boolean;
  binDir: string;
  /** 会写入（或已写入）PATH 段的 shell 配置文件 */
  rcFiles: string[];
  /** 当前平台是否支持自动加入 PATH */
  pathSupported: boolean;
  pathKind?: 'user-path' | 'shell-rc';
  commands: string[];
}

async function call<T>(fn: () => Promise<unknown>): Promise<T> {
  if (!hasTransport()) throw new Error('desktop app connection unavailable');
  return (await fn()) as T;
}

export const terminalCommandsClient = {
  state: () => call<TerminalCommandsState>(() => api.gateway.terminalState()),
  /** addToPath：true 加 PATH 段（界面已确认），false 去掉，省略保持现状 */
  set: (input: { enabled: boolean; addToPath?: boolean }) =>
    call<TerminalCommandsState>(() => api.gateway.terminalSet(input)),
};
