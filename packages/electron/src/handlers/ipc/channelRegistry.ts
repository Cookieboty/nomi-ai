/**
 * 全局已注册 IPC 通道表。
 *
 * Electron 的 `ipcMain.handle` 对同名通道会直接抛错，而 `ipcMain.on` 同名则会叠加多个监听器
 * （同一条消息被处理两次）。各服务 / Handler 注册通道前先在这里「认领」：
 * 不同所有者认领同一通道立即抛错，把重名问题暴露在启动阶段，而不是运行期的重复副作用。
 * 同一所有者重复认领（服务重启 / registerIpc 被调用两次）是幂等的。
 */
const owners = new Map<string, string>();

export function claimIpcChannel(channel: string, owner: string): void {
  const cur = owners.get(channel);
  if (cur !== undefined && cur !== owner) {
    throw new Error(
      `IPC channel "${channel}" is already registered by ${cur}; ${owner} cannot register it again`,
    );
  }
  owners.set(channel, owner);
}

export function releaseIpcChannel(channel: string, owner?: string): void {
  if (owner !== undefined && owners.get(channel) !== owner) return;
  owners.delete(channel);
}

export function getIpcChannelOwner(channel: string): string | undefined {
  return owners.get(channel);
}

export function listIpcChannels(): string[] {
  return [...owners.keys()];
}

/** 仅测试使用 */
export function resetIpcChannelsForTest(): void {
  owners.clear();
}
