import { describe, expect, it } from 'vitest';

import {
  cliAcceptsImages,
  cliInfo,
  hasOfficialAccount,
  hasSlashCommands,
} from '../src/utils/cliCaps';
import { cliImageSupport } from '../src/utils/cliImageSupport';

describe('编程助手能力位（来自插件清单，P9.4）', () => {
  it('官方账号、图片、斜杠发现按能力位判断', () => {
    expect(hasOfficialAccount('claude')).toBe(true);
    expect(hasOfficialAccount('dsh')).toBe(false);
    expect(hasOfficialAccount('nomi')).toBe(false);
    expect(cliAcceptsImages('dsh')).toBe(false);
    expect(cliAcceptsImages('codex')).toBe(true);
    // Nomi 自己与未知后端按能收图处理
    expect(cliAcceptsImages('nomi')).toBe(true);
    expect(cliImageSupport('dsh')).toBe('none');
    expect(cliImageSupport('grok')).toBe('full');
    expect(hasSlashCommands('dsh')).toBe(false);
    expect(hasSlashCommands('grok')).toBe(true);
    expect(cliInfo('gemini')?.permissionModes).toEqual(['plan', 'manual', 'acceptEdits', 'bypass']);
    expect(cliInfo('unknown')).toBeNull();
  });
});
