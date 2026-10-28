jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import path from 'node:path';

jest.mock('electron', () => ({
  app: { isPackaged: false, on: jest.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: { createFromPath: jest.fn() },
}));

import {
  APP_USER_MODEL_ID,
  ICON_VARIANTS,
  applyToWindow,
  diskAssetsDir,
  icoFile,
  iconFile,
  sanitizeVariant,
} from '../../../src/core/appIcon';

const assets = path.join(__dirname, '..', '..', '..', 'assets');
const img = { isEmpty: () => false } as never;

/** 解析 ICO 头：返回各帧尺寸（0 表示 256） */
function icoSizes(file: string): number[] {
  const b = fs.readFileSync(file);
  expect(b.readUInt16LE(0)).toBe(0);
  expect(b.readUInt16LE(2)).toBe(1); // type = icon
  const n = b.readUInt16LE(4);
  return Array.from({ length: n }, (_, i) => b[6 + i * 16] || 256).sort((a, c) => a - c);
}

function fakeWin(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    setIcon: jest.fn(),
    setAppDetails: jest.fn(),
  };
}

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

  it('ships a multi-size .ico (16–256px) for every variant (#56 taskbar)', () => {
    for (const v of ICON_VARIANTS) {
      expect(icoSizes(icoFile(assets, v))).toEqual([16, 24, 32, 48, 64, 128, 256]);
    }
  });

  it('appId matches electron-builder appId (NSIS shortcut AppUserModelID)', () => {
    const yml = fs.readFileSync(path.join(assets, '..', 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, '\\.')}$`, 'm'));
    // .ico 必须在磁盘上（Windows Shell 读不了 asar）：assets 整体作为 extraResources 复制到 resources/assets
    expect(yml).toMatch(/extraResources:[\s\S]*- from: assets\n/);
  });

  it('diskAssetsDir: packaged → resources/assets, dev → source assets', () => {
    expect(diskAssetsDir(true, '/opt/Nomi/resources')).toBe(
      path.join('/opt/Nomi/resources', 'assets'),
    );
    expect(path.resolve(diskAssetsDir(false, '/opt/Nomi/resources'))).toBe(path.resolve(assets));
  });

  it('Windows: setIcon + setAppDetails(appId, .ico, index 0) on each window', () => {
    const w = fakeWin();
    applyToWindow(w, {
      platform: 'win32',
      image: img,
      ico: 'C:\\r\\assets\\app-icons\\ink\\app.ico',
    });
    expect(w.setIcon).toHaveBeenCalledWith(img);
    expect(w.setAppDetails).toHaveBeenCalledWith({
      appId: APP_USER_MODEL_ID,
      appIconPath: 'C:\\r\\assets\\app-icons\\ink\\app.ico',
      appIconIndex: 0,
    });
  });

  it('Windows without an .ico still sets the window icon; Linux never calls setAppDetails', () => {
    const a = fakeWin();
    applyToWindow(a, { platform: 'win32', image: img, ico: null });
    expect(a.setIcon).toHaveBeenCalled();
    expect(a.setAppDetails).not.toHaveBeenCalled();
    const b = fakeWin();
    applyToWindow(b, { platform: 'linux', image: img, ico: '/x.ico' });
    expect(b.setIcon).toHaveBeenCalled();
    expect(b.setAppDetails).not.toHaveBeenCalled();
  });

  it('macOS (Dock handles it) and destroyed windows are skipped; one failing window does not throw', () => {
    const mac = fakeWin();
    applyToWindow(mac, { platform: 'darwin', image: img, ico: '/x.ico' });
    expect(mac.setIcon).not.toHaveBeenCalled();
    const dead = fakeWin(true);
    applyToWindow(dead, { platform: 'win32', image: img, ico: '/x.ico' });
    expect(dead.setIcon).not.toHaveBeenCalled();
    const bad = fakeWin();
    bad.setIcon.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    expect(() =>
      applyToWindow(bad, { platform: 'win32', image: img, ico: '/x.ico' }),
    ).not.toThrow();
    expect(bad.setAppDetails).toHaveBeenCalled();
  });
});
