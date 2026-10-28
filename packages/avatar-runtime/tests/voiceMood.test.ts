import { describe, expect, it } from 'vitest';

import { voiceDirective } from '../src/voiceMood';

describe('voiceDirective', () => {
  it('reacts once per phase change', () => {
    expect(voiceDirective('hearing', 'hearing')).toBeNull();
    expect(voiceDirective('hearing', 'listening')?.gesture).toBe('nod');
    expect(voiceDirective('transcribing', 'hearing')?.gesture).toBe('think');
    expect(voiceDirective('awake', 'wake-armed')).toMatchObject({
      expression: 'happy',
      gesture: 'wave',
    });
    expect(voiceDirective('listening', 'idle')).toBeNull();
    expect(voiceDirective('idle', 'transcribing')?.expression).toBe('neutral');
  });
});
