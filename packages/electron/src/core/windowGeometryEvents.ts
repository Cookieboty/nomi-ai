/**
 * 窗口位置 / 大小变化的订阅。
 *
 * Electron 的 `moved` / `resized`（用户拖完 / 缩完）只在 macOS 与 Windows 上触发；
 * Linux 上只有连续的 `move` / `resize`，不监听它们就永远存不下位置。调用方负责防抖，
 * 这里只负责按平台挑对事件。
 */
export interface GeometryEmitter {
  on(event: string, listener: () => void): unknown;
}

export function geometryEventNames(
  opts: { resize?: boolean } = {},
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'linux') return opts.resize ? ['move', 'resize'] : ['move'];
  return opts.resize ? ['moved', 'resized'] : ['moved'];
}

export function onGeometryChange(
  window: GeometryEmitter,
  listener: () => void,
  opts: { resize?: boolean } = {},
  platform: NodeJS.Platform = process.platform,
): void {
  for (const ev of geometryEventNames(opts, platform)) window.on(ev, listener);
}
