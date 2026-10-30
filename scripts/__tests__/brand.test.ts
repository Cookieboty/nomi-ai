import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { brand } from '../../packages/types/src/brand';

// 产品名只有一个来源（docs/design/core-host-decoupling.md §10.1）：`@nomi-ai/types` 的 `brand`。
// 安装包的名字与 appId 写在 electron-builder.yml 里（YAML 不能 import），这里守住两边一致。
// 运行时应用名（userData 目录名）是另一回事，见 electron-builder-app-name.test.ts。
const root = join(__dirname, '../..');
const yml = readFileSync(join(root, 'apps/desktop-electron/electron-builder.yml'), 'utf8');

describe('product brand', () => {
  it('electron-builder productName / appId match brand', () => {
    expect(yml).toMatch(new RegExp(`^productName: ${brand.appName}$`, 'm'));
    expect(yml).toMatch(new RegExp(`^appId: ${brand.appId.replace(/\./g, '\\.')}$`, 'm'));
  });

  it('the brand module holds product constants only (no character name)', () => {
    expect(brand.appName).toBe('Nomi');
    expect(JSON.stringify(brand)).not.toMatch(/诺米|·/);
  });

  it('the host re-exports brand instead of keeping its own copy', () => {
    const host = readFileSync(join(root, 'apps/desktop-electron/src/brand.ts'), 'utf8');
    expect(host).toMatch(/from '@nomi-ai\/types'/);
    expect(host).not.toMatch(/'Nomi'|诺米/);
  });
});
