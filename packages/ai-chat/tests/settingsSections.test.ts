import { describe, expect, it } from 'vitest';

import { SECTION_TABS, SETTINGS_SECTIONS, tabOf } from '../src/components/SettingsView/sections';

describe('设置分区：合并后的菜单', () => {
  it('7 个分区；快捷键、语音、截图、通知并进「通用」，模型质量并进「用量与质量」', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'models',
      'coding',
      'usage',
      'knowledge',
      'ext',
      'privacy',
    ]);
    // 命令面板的设置条目由分区生成：不再有单独的「快捷键」入口
    expect(SETTINGS_SECTIONS.some((s) => (s.id as string) === 'shortcuts')).toBe(false);
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      'ui.chat-settings.general',
      'ui.chat-settings.models-and-providers',
      'ui.providers-schedule.coding-agents',
      'ui.chat-settings.usage-and-quality',
      'ui.chat-settings.knowledge-memory',
      'ui.foundation.extensions-mcp',
      'ui.chat-settings.privacy-permissions',
    ]);
  });

  it('有标签页的分区：标签 id 唯一、分区存在，tabOf 只认本分区的标签', () => {
    for (const [section, tabs] of Object.entries(SECTION_TABS)) {
      const ids = tabs.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(SETTINGS_SECTIONS.map((s) => s.id as string)).toContain(section);
    }
    expect(SECTION_TABS.general.map((t) => t.id)).toEqual([
      'basics',
      'shortcuts',
      'voice',
      'notify',
    ]);
    expect(SECTION_TABS.models.map((t) => t.id)).toEqual(['providers', 'local']);
    expect(SECTION_TABS.usage.map((t) => t.id)).toEqual(['cost', 'compare', 'trend', 'requests']);
    expect(SECTION_TABS.knowledge.map((t) => t.id)).toEqual(['kb', 'memory', 'schedule']);
    expect(SECTION_TABS.privacy.map((t) => t.id)).toEqual([
      'data',
      'outbound',
      'desktop',
      'export',
    ]);
    expect(tabOf('usage', 'requests')).toBe('requests');
    expect(tabOf('knowledge', 'schedule')).toBe('schedule');
    expect(tabOf('knowledge', 'notes')).toBeUndefined();
    expect(tabOf('privacy', 'export')).toBe('export');
    expect(tabOf('privacy', undefined)).toBeUndefined();
  });
});
