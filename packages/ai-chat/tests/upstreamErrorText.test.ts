import { describe, expect, it } from 'vitest';

import { upstreamErrorText } from '../src/services/upstreamErrorText';

describe('upstreamErrorText（#78）', () => {
  it('known codes become a short localized hint with the raw detail', () => {
    const s = upstreamErrorText('[upstream_channel_error] upstream channel request failed');
    expect(s).toContain('上游通道请求失败');
    expect(s).toContain('upstream_channel_error：upstream channel request failed');
    expect(upstreamErrorText('[rate_limit_exceeded]')).toContain('限流');
  });

  it('unknown codes keep the code and message', () => {
    expect(upstreamErrorText('[weird_code] boom')).toContain('weird_code');
    expect(upstreamErrorText('[weird_code] boom')).toContain('boom');
  });

  it('plain messages are not touched', () => {
    expect(upstreamErrorText('Service Unavailable')).toBeNull();
    expect(upstreamErrorText('Failed after 3 attempts. Last error: x')).toBeNull();
  });
});
