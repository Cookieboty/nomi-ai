import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// 包从 @nomi-ai/electron 改名为 @nomi-ai/host-electron 后，运行时应用名必须不变：
// Electron 的 app.name（productName ?? name）决定 userData 目录与 macOS 钥匙串里 safeStorage 的
// 服务名 / 账户名；electron-builder 的包名决定 electron-updater 缓存目录与 NSIS 的 APP_PACKAGE_NAME。
// 任何一个变了，已安装的 2.0.x 用户升级后都会看到空配置、解不开已存的 API Key。
const RUNTIME_APP_NAME = '@nomi-ai/electron';
const dir = join(__dirname, '../../packages/host-electron');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
  name: string;
  productName?: string;
};
const yml = readFileSync(join(dir, 'electron-builder.yml'), 'utf8');

function extraMetadata(): Record<string, string> {
  const block = yml.split(/^extraMetadata:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^\s+(\w+):\s*'?([^'\s]+)'?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('electron-builder runtime app name', () => {
  it('package.json productName keeps the Electron app name (dev and packaged)', () => {
    expect(pkg.productName).toBe(RUNTIME_APP_NAME);
  });

  it('extraMetadata keeps the packaged package name and main entry', () => {
    expect(extraMetadata()).toEqual({ name: RUNTIME_APP_NAME, main: 'dist/main.js' });
  });

  it('installer and window name still come from the builder productName', () => {
    expect(yml).toMatch(/^productName: Nomi$/m);
  });
});
