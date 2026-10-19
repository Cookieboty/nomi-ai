import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkMacUpdate, parseUpdateInfo } from '../release/check-mac-update.mjs';

// 回归 #21：发布后核对 latest-mac.yml 真的列出两个架构的 zip，且文件与哈希对得上
const sha = (b: Buffer) => createHash('sha512').update(b).digest('base64');

function dist(opts: { arm?: boolean; x64?: boolean; badSha?: boolean; version?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mac-update-'));
  const files: Array<{ url: string; buf: Buffer }> = [];
  if (opts.x64 !== false) files.push({ url: 'Nomi-1.0.4-mac.zip', buf: Buffer.from('x64 zip') });
  if (opts.arm !== false)
    files.push({ url: 'Nomi-1.0.4-arm64-mac.zip', buf: Buffer.from('arm64 zip') });
  files.push({ url: 'Nomi-1.0.4.dmg', buf: Buffer.from('dmg') });
  for (const f of files) writeFileSync(join(dir, f.url), f.buf);
  const yml = [
    `version: ${opts.version ?? '1.0.4'}`,
    'files:',
    ...files.flatMap((f, i) => [
      `  - url: ${f.url}`,
      `    sha512: ${opts.badSha && i === 0 ? 'AAAA' : sha(f.buf)}`,
      `    size: ${f.buf.length}`,
    ]),
    `path: ${files[0]!.url}`,
    "releaseDate: '2026-10-19T00:00:00.000Z'",
  ].join('\n');
  writeFileSync(join(dir, 'latest-mac.yml'), `${yml}\n`);
  return dir;
}

describe('check-mac-update', () => {
  it('解析 latest-mac.yml 的 version 与 files', () => {
    const info = parseUpdateInfo(
      'version: 1.0.4\nfiles:\n  - url: a.zip\n    sha512: s\n    size: 3\npath: a.zip\n',
    );
    expect(info).toEqual({ version: '1.0.4', files: [{ url: 'a.zip', sha512: 's', size: '3' }] });
  });

  it('两个架构的 zip 都在且哈希一致：通过（签名后无警告）', () => {
    expect(checkMacUpdate(dist(), '1.0.4', { CSC_LINK: 'x' })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it.each([
    ['缺 arm64 zip', { arm: false }, /arm64/],
    ['缺 x64 zip', { x64: false }, /x64/],
    ['sha512 不一致', { badSha: true }, /sha512 mismatch/],
    ['版本不一致', { version: '1.0.3' }, /version/],
  ])('%s：报错', (_n, o, re) => {
    const { errors } = checkMacUpdate(dist(o), '1.0.4', { CSC_LINK: 'x' });
    expect(errors.join('\n')).toMatch(re);
  });

  it('没有 latest-mac.yml：报错；未签名：警告（不报错）', () => {
    expect(checkMacUpdate(mkdtempSync(join(tmpdir(), 'mac-empty-')), '1.0.4').errors[0]).toMatch(
      /missing/,
    );
    const r = checkMacUpdate(dist(), '1.0.4', {});
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/unsigned/);
  });
});
