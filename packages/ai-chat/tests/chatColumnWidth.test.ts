// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  CHAT_COL_W_DEFAULT,
  CHAT_COL_W_KEY,
  CHAT_COL_W_MAX,
  CHAT_COL_W_MIN,
  CHAT_COL_W_TOO_NARROW,
  clampChatColumnWidth,
  persistChatColumnWidth,
  readChatColumnWidth,
} from '../src/utils/chatColumnWidth';

describe('chatColumnWidth', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(CHAT_COL_W_KEY);
    } catch {
      /* ignore */
    }
  });

  it('defaults to a chat-primary width (≥50% feel; not the old 440 narrow strip)', () => {
    expect(CHAT_COL_W_DEFAULT).toBeGreaterThanOrEqual(640);
    expect(CHAT_COL_W_DEFAULT).toBeGreaterThan(CHAT_COL_W_TOO_NARROW);
    expect(CHAT_COL_W_MIN).toBeLessThan(CHAT_COL_W_TOO_NARROW);
    expect(CHAT_COL_W_MAX).toBeGreaterThan(CHAT_COL_W_DEFAULT);
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
  });

  it('migrates historically too-narrow stored values to the new default', () => {
    localStorage.setItem(CHAT_COL_W_KEY, '440');
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
    expect(localStorage.getItem(CHAT_COL_W_KEY)).toBe(String(CHAT_COL_W_DEFAULT));

    localStorage.setItem(CHAT_COL_W_KEY, String(CHAT_COL_W_TOO_NARROW - 1));
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
  });

  it('keeps a user-chosen width at or above the too-narrow floor', () => {
    const kept = Math.max(CHAT_COL_W_TOO_NARROW, 600);
    localStorage.setItem(CHAT_COL_W_KEY, String(kept));
    expect(readChatColumnWidth()).toBe(clampChatColumnWidth(kept));
  });

  it('persistChatColumnWidth clamps into [MIN, MAX]', () => {
    persistChatColumnWidth(10);
    expect(Number(localStorage.getItem(CHAT_COL_W_KEY))).toBe(CHAT_COL_W_MIN);
    persistChatColumnWidth(99999);
    expect(Number(localStorage.getItem(CHAT_COL_W_KEY))).toBe(CHAT_COL_W_MAX);
  });
});
