import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkUpdateFeed } from '../release/check-update-feed.mjs';

// 2.0.4（Electron）→ Go 版：update-manifest.py 生成的 latest*.yml 要让 2.0.4 的 electron-updater 在每个平台挑中 Go 安装包
const V = '2.0.5';
const manifest = resolve(__dirname, '../../apps/desktop-go/packaging/update-manifest.py');
// Windows runner 上不一定有 python3（打包与生成清单只在 macOS / Linux 上跑）
const hasPython = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function release() {
  const dir = mkdtempSync(join(tmpdir(), 'go-feed-'));
  for (const name of [
    `Nomi-${V}-arm64.dmg`,
    `Nomi-${V}.dmg`,
    `Nomi-${V}-arm64-mac.zip`,
    `Nomi-${V}-mac.zip`,
    `Nomi-Setup-${V}.exe`,
    `Nomi-${V}.AppImage`,
    `nomi_${V}_amd64.deb`,
  ])
    writeFileSync(join(dir, name), `payload of ${name}`);
  execFileSync('python3', [manifest, V, dir], { stdio: 'ignore' });
  return dir;
}

describe.skipIf(!hasPython)('2.0.4 update feed for the Go release', () => {
  it('every platform resolves to the Go installer with matching sha512 / size', async () => {
    const dir = release();
    expect(await checkUpdateFeed(dir, V)).toEqual([]);
    const mac = readFileSync(join(dir, 'latest-mac.yml'), 'utf8');
    expect(mac).toContain(`url: Nomi-${V}-arm64-mac.zip`);
    expect(mac).toContain(`url: Nomi-${V}-mac.zip`);
    expect(readFileSync(join(dir, 'latest-linux.yml'), 'utf8')).not.toContain('.deb');
  });

  it('reports a file changed after the feed was written', async () => {
    const dir = release();
    appendFileSync(join(dir, `Nomi-Setup-${V}.exe`), 'x');
    const errors = await checkUpdateFeed(dir, V);
    expect(errors.some((e) => e.startsWith('windows:') && e.includes('sha512'))).toBe(true);
  });

  it('reports a version mismatch', async () => {
    expect(await checkUpdateFeed(release(), '2.0.6')).toContainEqual(
      expect.stringContaining('version 2.0.5 != 2.0.6'),
    );
  });
});
