import {
  applyNomiContext,
  chatRoleOf,
  nomiContextBudget,
  NOMI_MAX_MESSAGES,
  type NomiContextInfo,
} from '../../../src/gateway/nomiContext';

// 同一组数值见 apps/desktop-go/internal/core/gwstore/nomicontext_test.go
describe('nomiContextBudget', () => {
  it.each([
    [200_000, 64_000, 32_000, 168_000, 159_600],
    [8_192, 32_000, 2_048, 6_144, 5_836],
    [1_000_000, 0, 32_000, 968_000, 919_600],
    [128_000, 8_192, 8_192, 119_808, 113_817],
  ])('ctx %d maxOutput %d', (ctx, maxOutput, outputReserve, budget, compactAt) => {
    expect(nomiContextBudget({ ctx, maxOutput })).toEqual({
      window: ctx,
      outputReserve,
      budget,
      compactAt,
    });
  });
});

describe('applyNomiContext', () => {
  const info: NomiContextInfo = {
    model: 'p/m',
    window: 200_000,
    outputReserve: 32_000,
    budget: 168_000,
    compactAt: 159_600,
    source: 'catalog',
  };

  it('sets the budget of the routed role', () => {
    const roles: string[] = [];
    const o: Record<string, unknown> = { messages: [] };
    applyNomiContext(o, 'agentStream', (r) => (roles.push(r), info));
    expect(o.context).toEqual({ maxTokens: 168_000, maxMessages: NOMI_MAX_MESSAGES });
    expect(roles).toEqual(['agent-tools']);
  });

  it('keeps an explicit context / provider and skips without a model', () => {
    const explicit: Record<string, unknown> = { context: false };
    applyNomiContext(explicit, 'stream', () => info);
    expect(explicit.context).toBe(false);
    const pinned: Record<string, unknown> = { provider: 'x' };
    applyNomiContext(pinned, 'stream', () => info);
    expect(pinned.context).toBeUndefined();
    const none: Record<string, unknown> = {};
    applyNomiContext(none, 'stream', () => null);
    expect(none.context).toBeUndefined();
  });

  it('role: explicit wins, agent* methods route to agent-tools', () => {
    expect(chatRoleOf('summary', 'agentStream')).toBe('summary');
    expect(chatRoleOf(undefined, 'agent')).toBe('agent-tools');
    expect(chatRoleOf('bogus', 'stream')).toBe('chat');
  });
});
