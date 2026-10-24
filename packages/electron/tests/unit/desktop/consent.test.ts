// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import { decide, isLocalBaseURL, sanitizePolicy } from '../../../src/desktop/consent';

describe('consent levels', () => {
  it('read is automatic by default', () => {
    expect(decide({ danger: 'read', sessionAllowed: false, tainted: false })).toMatchObject({
      confirm: false,
    });
    expect(
      decide({ danger: 'read', policy: 'ask', sessionAllowed: false, tainted: false }),
    ).toMatchObject({ confirm: true });
  });

  it('write asks once per run (rememberable), then auto', () => {
    expect(decide({ danger: 'write', sessionAllowed: false, tainted: false })).toMatchObject({
      confirm: true,
      dialog: false,
      rememberable: true,
      reason: 'first-use',
    });
    expect(decide({ danger: 'write', sessionAllowed: true, tainted: false })).toMatchObject({
      confirm: false,
    });
    expect(
      decide({ danger: 'write', policy: 'always', sessionAllowed: false, tainted: false }),
    ).toMatchObject({ confirm: false });
    expect(
      decide({ danger: 'write', policy: 'ask', sessionAllowed: true, tainted: false }),
    ).toMatchObject({ confirm: true });
  });

  it('a turn that read file content forces re-confirmation of writes', () => {
    for (const policy of ['always', 'session', 'ask'] as const) {
      expect(
        decide({ danger: 'write', policy, sessionAllowed: true, tainted: true }),
      ).toMatchObject({
        confirm: true,
        rememberable: false,
        reason: 'tainted',
      });
    }
  });

  it('destructive always needs the dialog and can never be remembered', () => {
    for (const policy of ['always', 'session', 'ask'] as const) {
      expect(
        decide({ danger: 'destructive', policy, sessionAllowed: true, tainted: false }),
      ).toEqual({
        confirm: true,
        dialog: true,
        rememberable: false,
        reason: 'destructive',
      });
    }
    expect(sanitizePolicy('destructive', 'always')).toBe('ask');
    expect(sanitizePolicy('write', 'bogus')).toBe('session');
  });

  it('permission modes: plan blocks writes, manual always asks, auto lifts default write prompts', () => {
    const base = { sessionAllowed: false, tainted: false };
    expect(decide({ ...base, danger: 'read', mode: 'plan' })).toMatchObject({ confirm: false });
    for (const danger of ['write', 'destructive'] as const)
      expect(decide({ ...base, danger, mode: 'plan' })).toMatchObject({
        blocked: true,
        reason: 'mode',
      });
    expect(
      decide({ ...base, danger: 'write', policy: 'always', sessionAllowed: true, mode: 'manual' }),
    ).toMatchObject({ confirm: true, rememberable: false });
    expect(decide({ ...base, danger: 'write', mode: 'auto' })).toMatchObject({ confirm: false });
    // 单独设过的策略在「自动」下仍然生效
    expect(
      decide({ ...base, danger: 'write', policy: 'ask', explicitPolicy: true, mode: 'auto' }),
    ).toMatchObject({ confirm: true });
    // 硬规则不受档位影响
    expect(decide({ ...base, danger: 'write', tainted: true, mode: 'auto' })).toMatchObject({
      confirm: true,
      reason: 'tainted',
    });
    expect(decide({ ...base, danger: 'destructive', mode: 'auto' })).toMatchObject({
      confirm: true,
      dialog: true,
    });
  });

  it('local provider detection', () => {
    expect(isLocalBaseURL('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalBaseURL('http://localhost:1234')).toBe(true);
    expect(isLocalBaseURL('http://[::1]:8080')).toBe(true);
    expect(isLocalBaseURL('https://api.deepseek.com')).toBe(false);
    expect(isLocalBaseURL(undefined)).toBe(false);
    expect(isLocalBaseURL('not a url')).toBe(false);
  });
});
