jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import path from 'node:path';

import {
  CHAT_BG_PRESET_URL,
  getChatBackgroundPresetFile,
} from '../../../src/chat/backgroundPreset';

const packageRoot = path.resolve(__dirname, '../../..');

describe('bundled background preset', () => {
  it('resolves development assets from the package rather than userData or cwd', () => {
    const preset = getChatBackgroundPresetFile(false, '/unused-resources');
    expect(preset).toBe(path.join(packageRoot, 'assets', 'backgrounds', 'nomi-preset.jpg'));
    expect(fs.statSync(preset).isFile()).toBe(true);
    expect(fs.readFileSync(preset).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(CHAT_BG_PRESET_URL).toBe('chat-asset://presets/background.jpg');
  });

  it('resolves packaged assets from Electron resources', () => {
    const resources = path.resolve('test-app', 'resources');
    expect(getChatBackgroundPresetFile(true, resources)).toBe(
      path.join(resources, 'assets', 'backgrounds', 'nomi-preset.jpg'),
    );
  });

  it('ships the background only via extraResources, not inside asar', () => {
    const config = fs.readFileSync(path.join(packageRoot, 'electron-builder.yml'), 'utf8');
    expect(config).toMatch(/extraResources:[\s\S]*?- from: assets\s+to: assets/);
    expect(config).toMatch(/^files:[\s\S]*?- '!assets\/\*\*'/m);
    const preset = path.join(packageRoot, 'assets/backgrounds/nomi-preset.jpg');
    expect(fs.statSync(preset).size).toBeLessThan(600 * 1024);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, '../../assets-licenses.json'), 'utf8'),
    );
    expect(manifest.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: 'apps/desktop-electron/assets/backgrounds/nomi-preset.jpg',
        }),
      ]),
    );
  });
});
