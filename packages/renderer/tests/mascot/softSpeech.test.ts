import { describe, expect, it } from 'vitest';

import * as softSpeech from '../../src/mascot/softSpeech';
import { clausePauseParts, DEFAULT_SOFT_SPEECH } from '../../src/mascot/softSpeech';

describe('softSpeech', () => {
  it('splits clauses for pauses', () => {
    expect(clausePauseParts('你好，我是诺米。加油！')).toEqual(['你好，', '我是诺米。', '加油！']);
  });

  it('ships soft defaults slower than 1.0', () => {
    expect(DEFAULT_SOFT_SPEECH.rate).toBeLessThan(1);
  });

  it('no longer exposes system speech playback', () => {
    expect('speakSoft' in softSpeech).toBe(false);
    expect(() => softSpeech.stopSoftSpeech()).not.toThrow();
  });
});
