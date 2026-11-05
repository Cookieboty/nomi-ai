import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { brand } from '../../packages/types/src/brand';

// 产品名只有一个来源（docs/design/core-host-decoupling.md §10.1）：`@nomi-ai/types` 的 `brand`。
// Go 版的 appId 写在 Go 常量与各平台打包模板里（不能 import TS），这里守住几处一致。
const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('product brand', () => {
  it('Go shell, Windows AppUserModelID and installers use brand.appId', () => {
    const id = brand.appId.replace(/\./g, '\\.');
    expect(read('apps/desktop-go/internal/shell/wailsshell/wails.go')).toMatch(
      new RegExp(`const AppID = "${id}"`),
    );
    expect(read('apps/desktop-go/internal/core/appicon/appicon.go')).toMatch(
      new RegExp(`const AppUserModelID = "${id}"`),
    );
    expect(read('apps/desktop-go/packaging/windows/installer.nsi')).toMatch(
      new RegExp(`!define APP_ID "${id}"`),
    );
    expect(read('apps/desktop-go/packaging/mac/Info.plist.in')).toMatch(
      new RegExp(`<key>CFBundleIdentifier</key><string>${id}</string>`),
    );
  });

  it('the brand module holds product constants only (no character name)', () => {
    expect(brand.appName).toBe('Nomi');
    expect(JSON.stringify(brand)).not.toMatch(/诺米|·/);
  });
});
