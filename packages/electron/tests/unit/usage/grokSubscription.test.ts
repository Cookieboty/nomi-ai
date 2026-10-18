import { parseGrokBilling } from '../../../src/usage/grokSubscription';

describe('parseGrokBilling', () => {
  it('keeps only the account period and plan fields', () => {
    const r = parseGrokBilling(
      {
        subscription_tier: 'SuperGrok Heavy',
        email: 'must-not-leak@example.com',
        config: {
          creditUsagePercent: 37.5,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-10-12T00:00:00.000Z',
            end: '2026-10-19T00:00:00.000Z',
          },
        },
      },
      Date.parse('2026-10-18T00:00:00.000Z'),
    );
    expect(r).toEqual({
      windows: [
        {
          id: 'USAGE_PERIOD_TYPE_WEEKLY',
          usedPercent: 37.5,
          windowMinutes: 10080,
          resetAt: Date.parse('2026-10-19T00:00:00.000Z'),
        },
      ],
      updatedAt: Date.parse('2026-10-18T00:00:00.000Z'),
      origin: 'grok-acp',
      plan: 'SuperGrok Heavy',
    });
  });

  it('rejects incomplete or malformed billing replies', () => {
    expect(parseGrokBilling({ config: { creditUsagePercent: 20 } })).toBeNull();
    expect(parseGrokBilling({ config: { creditUsagePercent: -1, currentPeriod: {} } })).toBeNull();
  });
});
