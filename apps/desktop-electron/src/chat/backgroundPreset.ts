import path from 'node:path';

export { CHAT_BG_PRESET_URL } from '@nomi-ai/types';

/**
 * 内置背景预设图的位置：正式版在打包资源目录（extraResources），开发版在包内 assets/。
 * `packaged` / `resourcesPath` 由调用方从宿主端口取（`ports.app.isPackaged()` / `ports.paths.resources()`）。
 */
export function getChatBackgroundPresetFile(
  packaged: boolean,
  resourcesPath: string = process.resourcesPath,
): string {
  const assets = packaged
    ? path.join(resourcesPath, 'assets')
    : path.join(__dirname, '..', '..', 'assets');
  return path.join(assets, 'backgrounds', 'nomi-preset.jpg');
}
