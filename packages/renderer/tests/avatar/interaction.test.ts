// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openAiChat } = vi.hoisted(() => ({ openAiChat: vi.fn(() => Promise.resolve()) }));

vi.mock('../../src/services/api', () => ({
  api: { window: { openAiChat }, ai: { avatar: { report: vi.fn() } } },
  hasTransport: () => true,
}));
vi.mock('../../src/mascot/characterVoice', () => ({ speakForActiveCharacter: vi.fn() }));

import { handleAvatarInteraction } from '../../src/avatar/interaction';

describe('handleAvatarInteraction', () => {
  beforeEach(() => openAiChat.mockClear());

  it('opens the workbench on a double click, with or without a reaction line', () => {
    handleAvatarInteraction({ kind: 'double', region: 'head', speak: false });
    handleAvatarInteraction({ kind: 'double', region: 'body', line: 'hi', speak: true });
    expect(openAiChat).toHaveBeenCalledTimes(2);
  });

  it('does not open it on a single click or a pat', () => {
    handleAvatarInteraction({ kind: 'click', region: 'head', line: 'hi', speak: true });
    handleAvatarInteraction({ kind: 'pat', region: 'head', speak: false });
    expect(openAiChat).not.toHaveBeenCalled();
  });
});
