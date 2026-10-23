// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  CHAT_COL_W_DEFAULT,
  CHAT_COL_W_KEY,
  CHAT_COL_W_MAX,
  CHAT_COL_W_MIN,
  CHAT_COL_W_LEGACY_DEFAULT,
  CHAT_COL_W_USER_KEY,
  clampChatColumnWidth,
  persistChatColumnWidth,
  readChatColumnWidth,
} from '../src/utils/chatColumnWidth';

describe('chatColumnWidth', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(CHAT_COL_W_KEY);
      localStorage.removeItem(CHAT_COL_W_USER_KEY);
    } catch {
      /* ignore */
    }
  });

  it('defaults to a chat-primary width (≥50% feel; not the old 440 narrow strip)', () => {
    expect(CHAT_COL_W_DEFAULT).toBeGreaterThanOrEqual(640);
    expect(CHAT_COL_W_DEFAULT).toBeGreaterThan(CHAT_COL_W_LEGACY_DEFAULT);
    expect(CHAT_COL_W_MIN).toBeLessThan(CHAT_COL_W_LEGACY_DEFAULT);
    expect(CHAT_COL_W_MAX).toBeGreaterThan(CHAT_COL_W_DEFAULT);
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
  });

  it('只把旧默认 440 迁移到新默认', () => {
    localStorage.setItem(CHAT_COL_W_KEY, String(CHAT_COL_W_LEGACY_DEFAULT));
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
    expect(localStorage.getItem(CHAT_COL_W_KEY)).toBe(String(CHAT_COL_W_DEFAULT));
  });

  it('已经拖过的用户（含标记出现之前拖到 400~720 的任意宽度）不被重置', () => {
    for (const w of [380, 439, 441, 480, 519, 520, 600]) {
      localStorage.setItem(CHAT_COL_W_KEY, String(w));
      expect(readChatColumnWidth()).toBe(w);
      expect(localStorage.getItem(CHAT_COL_W_KEY)).toBe(String(w));
    }
  });

  it('有「用户拖动过」标记时，恰好 440 也原样保留', () => {
    persistChatColumnWidth(CHAT_COL_W_LEGACY_DEFAULT);
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_LEGACY_DEFAULT);
  });

  it('没存过 / 存了非数字：回到默认值（不能当成 0 夹到下限）', () => {
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
    localStorage.setItem(CHAT_COL_W_KEY, '');
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
    localStorage.setItem(CHAT_COL_W_KEY, 'abc');
    expect(readChatColumnWidth()).toBe(CHAT_COL_W_DEFAULT);
  });

  it('用户拖窄后会被记住，不会被迁移逻辑重置回 720', () => {
    persistChatColumnWidth(400);
    expect(readChatColumnWidth()).toBe(400);
    expect(Number(localStorage.getItem(CHAT_COL_W_KEY))).toBe(400);
  });

  it('persistChatColumnWidth clamps into [MIN, MAX]', () => {
    persistChatColumnWidth(10);
    expect(Number(localStorage.getItem(CHAT_COL_W_KEY))).toBe(CHAT_COL_W_MIN);
    persistChatColumnWidth(99999);
    expect(Number(localStorage.getItem(CHAT_COL_W_KEY))).toBe(CHAT_COL_W_MAX);
  });
});
