import { describe, expect, it } from 'vitest';

import { missingAssets, referencedFiles } from '../release/check-release-assets.mjs';

// 回归 #146：发布草稿前确认 latest*.yml 引用的安装包和 blockmap 都已上传
const win = `version: 2.0.4
files:
  - url: Nomi-Setup-2.0.4.exe
    sha512: x
    size: 1
path: Nomi-Setup-2.0.4.exe
sha512: x
`;
const mac = `version: 2.0.4
files:
  - url: Nomi-2.0.4-mac.zip
  - url: Nomi-2.0.4-arm64-mac.zip
  - url: Nomi-2.0.4.dmg
path: Nomi-2.0.4-mac.zip
`;
const linux = `version: 2.0.4
files:
  - url: Nomi-2.0.4.AppImage
path: Nomi-2.0.4.AppImage
`;
const yml = { 'latest.yml': win, 'latest-mac.yml': mac, 'latest-linux.yml': linux };
const all = [
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
  'Nomi-Setup-2.0.4.exe',
  'Nomi-Setup-2.0.4.exe.blockmap',
  'Nomi-2.0.4-mac.zip',
  'Nomi-2.0.4-mac.zip.blockmap',
  'Nomi-2.0.4-arm64-mac.zip',
  'Nomi-2.0.4-arm64-mac.zip.blockmap',
  'Nomi-2.0.4.dmg',
  'Nomi-2.0.4.AppImage',
];

describe('check-release-assets', () => {
  it('reads url and path entries', () => {
    expect(referencedFiles(mac)).toEqual([
      'Nomi-2.0.4-mac.zip',
      'Nomi-2.0.4-arm64-mac.zip',
      'Nomi-2.0.4.dmg',
    ]);
    expect(referencedFiles('path: Nomi%20Setup.exe')).toEqual(['Nomi Setup.exe']);
  });

  it('passes when everything is attached (AppImage needs no blockmap)', () => {
    expect(missingAssets(yml, all)).toEqual([]);
  });

  it('reports a missing update file, installer and blockmap', () => {
    const assets = all.filter(
      (a) =>
        a !== 'latest-linux.yml' &&
        a !== 'Nomi-2.0.4-arm64-mac.zip' &&
        a !== 'Nomi-Setup-2.0.4.exe.blockmap',
    );
    expect(missingAssets(yml, assets)).toEqual([
      'Nomi-Setup-2.0.4.exe.blockmap (for latest.yml)',
      'Nomi-2.0.4-arm64-mac.zip (listed in latest-mac.yml)',
      'latest-linux.yml',
    ]);
  });
});
