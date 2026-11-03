import { describe, expect, it } from 'vitest';

import {
  buildTitleMessages,
  generateSmartTitle,
  heuristicTitle,
  isDefaultChatName,
  sanitizeSmartTitle,
  armNomiAutoTitle,
  clearNomiAutoTitle,
  nomiAutoTitlePending,
} from '../src/services/sessionTitle';

describe('sessionTitle', () => {
  it('detects default Nomi names', () => {
    expect(isDefaultChatName('ui.chat-settings.new-chat')).toBe(true);
    expect(isDefaultChatName('新对话') || isDefaultChatName('New chat')).toBe(true);
    expect(isDefaultChatName('已改名')).toBe(false);
  });

  it('heuristicTitle strips attachments and slices', () => {
    const raw =
      '<attached-file name="a.ts" />\n\nhello world from the first message that is quite long';
    expect(heuristicTitle(raw).length).toBeLessThanOrEqual(30);
    expect(heuristicTitle(raw)).toContain('hello');
  });

  it('sanitizeSmartTitle rejects empty / quoted spam and trims', () => {
    expect(sanitizeSmartTitle('  ')).toBeNull();
    expect(sanitizeSmartTitle('"登录修复"')).toBe('登录修复');
    expect(sanitizeSmartTitle('A'.repeat(80))!.length).toBeLessThanOrEqual(40);
  });

  it('generateSmartTitle returns sanitized model output or null on failure', async () => {
    await expect(generateSmartTitle('fix login', async () => '  "Fix login"  ')).resolves.toBe(
      'Fix login',
    );
    await expect(generateSmartTitle('x', async () => '')).resolves.toBeNull();
    await expect(
      generateSmartTitle('x', async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeNull();
  });

  it('buildTitleMessages uses system+user and includes the text', () => {
    const msgs = buildTitleMessages('修复登录');
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]).toEqual({ role: 'user', content: expect.stringContaining('修复登录') });
  });

  it('pending arm/clear', () => {
    armNomiAutoTitle('c1');
    expect(nomiAutoTitlePending('c1')).toBe(true);
    clearNomiAutoTitle('c1');
    expect(nomiAutoTitlePending('c1')).toBe(false);
  });

  it('manual rename clears pending so smart title must not apply', async () => {
    armNomiAutoTitle('c-renamed');
    clearNomiAutoTitle('c-renamed');
    const title = await generateSmartTitle('fix login', async () => 'Fix login');
    expect(title).toBe('Fix login');
    // UI rename path calls clearNomiAutoTitle before updateMeta; pending stays false.
    expect(nomiAutoTitlePending('c-renamed')).toBe(false);
  });
});
