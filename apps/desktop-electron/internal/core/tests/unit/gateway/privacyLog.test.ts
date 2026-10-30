jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrivacyLog } from '../../../src/gateway/PrivacyLog';
import { __renameDeps, whenPrivateWritesIdle } from '../../../src/utils/privateFile';

const hit = (p: string, extra: Record<string, unknown> = {}) => ({
  kind: 'TOKEN',
  placeholder: p,
  action: 'mask' as const,
  len: 36,
  head: 'ghp_',
  masked: 1,
  restored: 0,
  allowTag: 'abcdefgh',
  ...extra,
});

describe('PrivacyLog', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-log-'));

  it('merges by placeholder, newest first, and survives a restart', async () => {
    const file = path.join(dir(), 'privacy-log.json');
    let now = 1;
    const log = new PrivacyLog(file, () => now);
    log.note({ client: 'codex', redactions: [hit('{{TOKEN_aaaaaaaa}}')] });
    now = 2;
    log.note({ client: 'codex', redactions: [hit('{{TOKEN_bbbbbbbb}}')] });
    now = 3;
    log.note({ client: 'nomi', redactions: [hit('{{TOKEN_aaaaaaaa}}', { restored: 2 })] });
    expect(log.list().map((e) => [e.placeholder, e.requests, e.restored, e.clients])).toEqual([
      ['{{TOKEN_aaaaaaaa}}', 2, 2, ['codex', 'nomi']],
      ['{{TOKEN_bbbbbbbb}}', 1, 0, ['codex']],
    ]);
    log.flush();
    await whenPrivateWritesIdle();
    // Windows 没有 POSIX 权限位
    if (process.platform !== 'win32')
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const again = new PrivacyLog(file);
    expect(again.list().map((e) => e.placeholder)).toEqual([
      '{{TOKEN_aaaaaaaa}}',
      '{{TOKEN_bbbbbbbb}}',
    ]);
    await again.clear();
    await whenPrivateWritesIdle();
    expect(new PrivacyLog(file).list()).toEqual([]);
  });

  it('keeps at most 200 values', () => {
    const log = new PrivacyLog(path.join(dir(), 'privacy-log.json'));
    for (let i = 0; i < 230; i++)
      log.note({ client: 'claude', redactions: [hit(`{{TOKEN_${String(i).padStart(8, 'a')}}}`)] });
    expect(log.list()).toHaveLength(200);
    expect(log.list()[0]!.placeholder).toBe('{{TOKEN_aaaaa229}}');
  });

  it('clear serializes past an in-flight async flush so old entries do not return (#164)', async () => {
    const file = path.join(dir(), 'privacy-log.json');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = __renameDeps.renameAsync;
    let held = 0;
    __renameDeps.renameAsync = async (from, to) => {
      held += 1;
      if (held === 1) await gate;
      return real(from, to);
    };
    try {
      const log = new PrivacyLog(file);
      log.note({ client: 'codex', redactions: [hit('{{TOKEN_aaaaaaaa}}')] });
      log.flush();
      await waitForHeld();
      expect(held).toBe(1);
      // clear 会排在在途写之后；先启动再放行，避免 await 死锁
      const cleared = log.clear();
      await new Promise((r) => setTimeout(r, 10));
      release();
      await cleared;
      await whenPrivateWritesIdle();
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([]);
      expect(new PrivacyLog(file).list()).toEqual([]);
    } finally {
      __renameDeps.renameAsync = real;
    }

    async function waitForHeld() {
      for (let i = 0; i < 50 && held === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(held).toBeGreaterThan(0);
    }
  });
});
