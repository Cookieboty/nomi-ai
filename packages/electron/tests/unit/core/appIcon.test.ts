import fs from 'node:fs';
import path from 'node:path';

jest.mock('electron', () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn() },
  nativeImage: { createFromPath: jest.fn() },
}));

import { ICON_VARIANTS, iconFile, sanitizeVariant } from '../../../src/core/appIcon';

const assets = path.join(__dirname, '..', '..', '..', 'assets');

describe('appIcon', () => {
  it('defaults unknown variants to sunset', () => {
    expect(sanitizeVariant('nope')).toBe('sunset');
    expect(sanitizeVariant(undefined)).toBe('sunset');
    expect(sanitizeVariant('sunset')).toBe('sunset');
  });
  it('ships window/dock/tray PNGs for every variant', () => {
    for (const v of ICON_VARIANTS)
      for (const part of ['window', 'dock', 'tray'] as const)
        expect(fs.existsSync(iconFile(assets, v, part))).toBe(true);
  });
});
