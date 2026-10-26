import { describe, expect, it, vi } from 'vitest';

import { registerSpeechStopper, stopAllSpeech } from '../../src/mascot/speechStop';

describe('stopAllSpeech', () => {
  it('stops every registered player', () => {
    const a = vi.fn();
    const off = registerSpeechStopper(a);
    stopAllSpeech();
    expect(a).toHaveBeenCalledTimes(1);
    off();
    stopAllSpeech();
    expect(a).toHaveBeenCalledTimes(1);
  });
});
