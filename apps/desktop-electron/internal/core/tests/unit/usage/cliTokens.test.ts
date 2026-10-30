import { qualityLedgerInput } from '../../../src/usage/quality/cliTokens';

describe('qualityLedgerInput (#122)', () => {
  it('Codex: subtracts cacheRead from inputTokens (Codex includes cached in input)', () => {
    expect(qualityLedgerInput('codex', { inputTokens: 1000, cacheReadTokens: 400 })).toBe(600);
    expect(qualityLedgerInput('codex', { inputTokens: 100, cacheReadTokens: 200 })).toBe(0);
  });

  it('other clients: pass inputTokens through', () => {
    expect(qualityLedgerInput('claude', { inputTokens: 1000, cacheReadTokens: 400 })).toBe(1000);
    expect(qualityLedgerInput('nomi', { inputTokens: 50 })).toBe(50);
  });

  it('undefined input stays undefined', () => {
    expect(qualityLedgerInput('codex', { cacheReadTokens: 10 })).toBeUndefined();
  });
});
