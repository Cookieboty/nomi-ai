import { cleanTitle } from '../../../src/agents/parsers';
import {
  CARRY_MAX_TOTAL,
  buildCarriedContext,
  carriedBudget,
  fitCarried,
  stripCarriedContext,
  withCarriedContext,
} from '../../../src/cli/contextCarry';
import { HISTORY_MAX_MESSAGES } from '../../../src/cli/historyTranscript';
import { parseClaudeTranscript } from '../../../src/cli/historyTranscript';

const msg = (role: 'user' | 'assistant', content: string, extra: object = {}) => ({
  id: `${role}-${content.slice(0, 8)}`,
  role,
  content,
  timestamp: 1,
  ...extra,
});

describe('contextCarry', () => {
  it('skips errors / empty messages and returns null when nothing is left', () => {
    expect(
      buildCarriedContext([msg('assistant', '', {}), msg('user', 'x', { error: true })], '/a'),
    ).toBeNull();
    const c = buildCarriedContext([msg('user', 'hi'), msg('assistant', 'hello')], '/old')!;
    expect(c.messages).toBe(2);
    expect(c.text).toContain('/old');
    expect(c.text).toContain('User: hi\nAssistant: hello');
  });

  it('keeps the newest messages within the total budget', () => {
    const big = Array.from({ length: 40 }, (_, i) => msg('user', `${i}:${'x'.repeat(3500)}`));
    const c = buildCarriedContext(big, '/a')!;
    expect(c.text.length).toBeLessThan(CARRY_MAX_TOTAL + 1000);
    expect(c.text).toContain('User: 39:');
    expect(c.text).not.toContain('User: 0:');
  });

  it('history readers show only the user prompt, not the carried preface', () => {
    const c = buildCarriedContext([msg('user', 'old q')], '/a')!.text;
    const sent = withCarriedContext(c, '新问题');
    expect(stripCarriedContext(sent)).toBe('新问题');
    expect(stripCarriedContext('plain')).toBe('plain');
    expect(cleanTitle(sent)).toBe('新问题');
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-19T00:00:00Z',
      message: { role: 'user', content: sent },
    });
    expect(parseClaudeTranscript(line).map((m) => m.content)).toEqual(['新问题']);
    expect(HISTORY_MAX_MESSAGES).toBeGreaterThan(0);
  });

  it('budget: stdin-fed CLIs get the full budget, argv-fed ones stay under OS limits', () => {
    expect(carriedBudget('claude', 'win32')).toBe(CARRY_MAX_TOTAL);
    expect(carriedBudget('gemini', 'linux')).toBe(CARRY_MAX_TOTAL);
    // Windows .cmd 垫片经 cmd.exe：整条命令行 8191 字符
    expect(carriedBudget('codex', 'win32')).toBeLessThan(8191);
    // Linux 单个参数 128 KB，中文一个字 3 字节
    for (const b of ['codex', 'dsh', 'grok'] as const)
      expect(carriedBudget(b, 'linux') * 3).toBeLessThan(131_072);
  });

  it('fitCarried drops the oldest messages first and keeps the frame', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => msg('user', `${i}:${'x'.repeat(500)}`));
    const full = buildCarriedContext(msgs, '/a')!.text;
    const fit = fitCarried(full, 2000)!;
    expect(fit.length).toBeLessThanOrEqual(2000);
    expect(fit).toContain('User: 9:');
    expect(fit).not.toContain('User: 0:');
    expect(fit.startsWith(full.slice(0, 20))).toBe(true);
    expect(fit.endsWith('</previous_conversation>')).toBe(true);
    expect(fitCarried(full, 50)).toBeNull();
    expect(fitCarried(full, full.length)).toBe(full);
  });
});
