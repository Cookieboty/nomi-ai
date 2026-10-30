import { describe, expect, it } from 'vitest';

import { PreferenceExtractor } from '../../src/plugins/userProfile/PreferenceExtractor';

describe('PreferenceExtractor', () => {
  const ex = new PreferenceExtractor();

  it('captures Chinese reply intent', () => {
    const out = ex.extract('请用中文回复我', 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.patch.preferences?.replyLanguage?.value).toBe('zh');
    expect(out[0]?.source).toBe('inferred');
  });

  it('captures bullet style intent', () => {
    const out = ex.extract('请给我要点', 1);
    expect(out[0]?.patch.preferences?.replyStyle?.value).toBe('bullet');
  });

  it('captures no-comments intent', () => {
    const out = ex.extract('不要加注释', 1);
    expect(out[0]?.patch.preferences?.codeStyle?.comments).toBe('minimal');
  });

  it('returns empty for irrelevant message', () => {
    expect(ex.extract('今天天气怎么样', 1)).toEqual([]);
  });
});
