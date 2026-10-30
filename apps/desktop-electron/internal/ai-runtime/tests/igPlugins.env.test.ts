import { describe, expect, it } from 'vitest';

import { providerOverrideFromEnv } from '../src/igPlugins';

describe('providerOverrideFromEnv', () => {
  it('reads NOMI_PROVIDER', () => {
    expect(providerOverrideFromEnv({ NOMI_PROVIDER: 'nomi-pick' })).toBe('nomi-pick');
  });

  it('ignores blank NOMI_PROVIDER and obsolete COMPANION_PROVIDER', () => {
    expect(providerOverrideFromEnv({ NOMI_PROVIDER: '  ' })).toBeUndefined();
    expect(providerOverrideFromEnv({ COMPANION_PROVIDER: 'legacy-pick' })).toBeUndefined();
    expect(providerOverrideFromEnv({})).toBeUndefined();
  });
});
