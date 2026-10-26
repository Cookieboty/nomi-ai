import path from 'node:path';

import { app } from 'electron';

export const CHAT_BG_PRESET_URL = 'chat-asset://presets/background.jpg';

export function getChatBackgroundPresetFile(
  packaged = app.isPackaged,
  resourcesPath = process.resourcesPath,
): string {
  const assets = packaged
    ? path.join(resourcesPath, 'assets')
    : path.join(__dirname, '..', '..', 'assets');
  return path.join(assets, 'backgrounds', 'nomi-preset.jpg');
}
