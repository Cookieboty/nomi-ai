/**
 * 终端启动命令（主进程 gateway/TerminalCommands.ts，docs/design/unified-gateway.md §12.6）。
 * 打开后生成 ~/.nomi/bin/nomi-claude 等脚本；只有用户确认后才改 shell 配置文件加 PATH。
 */
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

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error('aiIPC unavailable');
  const r = (await b.invoke(channel, ...args)) as T & { __error?: { message: string } };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const terminalCommandsClient = {
  state: () => call<TerminalCommandsState>('ai:gateway:terminal-state'),
  /** addToPath：true 加 PATH 段（界面已确认），false 去掉，省略保持现状 */
  set: (input: { enabled: boolean; addToPath?: boolean }) =>
    call<TerminalCommandsState>('ai:gateway:terminal-set', input),
};
