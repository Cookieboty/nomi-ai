import { describe, expect, it } from 'vitest';

import { makeDefaultUserProfile } from '../../src/types/UserProfile';
import { userProfileSchema } from '../../src/types/UserProfileSchema';

describe('userProfileSchema', () => {
  it('accepts default profile', () => {
    const p = makeDefaultUserProfile(1_700_000_000_000);
    expect(userProfileSchema.parse(p)).toEqual(p);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const p = { ...makeDefaultUserProfile(), unknown: 1 } as unknown;
    expect(() => userProfileSchema.parse(p)).toThrow();
  });

  it('rejects invalid replyStyle enum', () => {
    const p = {
      ...makeDefaultUserProfile(),
      preferences: {
        replyStyle: { value: 'wrong', source: 'user', updatedAt: 1 },
      },
    };
    expect(() => userProfileSchema.parse(p)).toThrow();
  });

  it('rejects activeHours with wrong length', () => {
    const p = {
      ...makeDefaultUserProfile(),
      habits: { activeHours: [1, 2, 3] },
    };
    expect(() => userProfileSchema.parse(p)).toThrow();
  });
});
