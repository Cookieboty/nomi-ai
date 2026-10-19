import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// 回归 #21：electron-updater 的 MacUpdater 只会从 latest-mac.yml 里挑 zip；
// 只发 dmg 会让已安装的 macOS 版本在「下载」步骤抛 ERR_UPDATER_ZIP_FILE_NOT_FOUND。
const yml = readFileSync(join(__dirname, '../../packages/electron/electron-builder.yml'), 'utf8');

function macTargets(): Record<string, string[]> {
  const mac = yml.split(/^mac:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const out: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of mac.split('\n')) {
    const t = /^\s*- target: (\w+)\s*$/.exec(line);
    if (t) {
      cur = t[1];
      out[cur] = [];
      continue;
    }
    const a = /^\s{8,}- (\w+)\s*$/.exec(line);
    if (cur && a) out[cur].push(a[1]);
  }
  return out;
}

describe('electron-builder mac targets', () => {
  it('同时产出 dmg 和 zip，且两种都覆盖 x64 与 arm64', () => {
    const t = macTargets();
    expect(Object.keys(t).sort()).toEqual(['dmg', 'zip']);
    expect(t.dmg.sort()).toEqual(['arm64', 'x64']);
    expect(t.zip.sort()).toEqual(['arm64', 'x64']);
  });
});
