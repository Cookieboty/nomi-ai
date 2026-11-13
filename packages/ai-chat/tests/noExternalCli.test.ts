import { describe, expect, it } from 'vitest';

import { isCodingTab } from '../src/services/chatPrefs';
import { isConversationBackend } from '../src/types/chat';
import { ENDPOINT_NAME } from '../src/utils/endpointBadge';

// 不再支持用户添加的「外部 CLI」：旧版本存下的值按非法处理，回到默认（不崩）
describe('no external CLIs', () => {
  it('external is neither a conversation backend nor a coding-page item', () => {
    expect(isConversationBackend('external')).toBe(false);
    expect(isCodingTab('external')).toBe(false);
    expect(isCodingTab('general')).toBe(true);
    expect(isConversationBackend('gemini')).toBe(true);
  });

  it('unknown CLIs (e.g. in the fleet) still get a generic name', () => {
    expect(ENDPOINT_NAME.other).toBe('CLI');
    expect('external' in ENDPOINT_NAME).toBe(false);
  });
});
