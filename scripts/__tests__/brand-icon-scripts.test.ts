import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// 图标生成脚本（docs/brand/icon-variants/README.md）无参运行时写到哪：必须是 Electron 宿主真实的打包资源目录。
// 宿主目录迁移时只改了脚本说明、漏了真正拼路径的那行（#204），这里不跑 Chrome / Pillow，只核对默认输出目录。
const root = join(__dirname, '../..');

/** 从 `OUT = ... ROOT / 'a' / 'b' ...` 里取出默认输出目录的各段 */
function defaultOut(script: string): string {
  const src = readFileSync(join(root, 'scripts/brand', script), 'utf8');
  const line = src.split('\n').find((l) => /^OUT = /.test(l));
  expect(line, `${script} has an OUT = line`).toBeDefined();
  const tail = line!.slice(line!.lastIndexOf('ROOT'));
  const parts = [...tail.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  return join(root, ...parts);
}

describe('brand icon scripts write to the Electron host assets', () => {
  it.each([
    ['build-icon-assets.py', 'apps/desktop-electron/assets'],
    ['build-variant-ico.py', 'apps/desktop-electron/assets/app-icons'],
  ])('%s → %s', (script, expected) => {
    const out = defaultOut(script);
    expect(out).toBe(join(root, expected));
    expect(existsSync(out) && statSync(out).isDirectory()).toBe(true);
  });
});
