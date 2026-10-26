import { describe, expect, it } from 'vitest';

import { SECTION_TABS, SETTINGS_SECTIONS, tabOf } from '../src/components/SettingsView/sections';

describe('设置分区：合并后的菜单', () => {
  it('13 个分区，高频在前；没有独立的「更新」「屏幕」「语音」', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'shortcuts',
      'models',
      'quality',
      'coding',
      'usage',
      'senses',
      'knowledge',
      'schedule',
      'notify',
      'ext',
      'local',
      'privacy',
    ]);
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      'ui.chat-settings.general',
      'ui.chat-settings.shortcuts',
      'ui.foundation.model',
      'ui.model-quality.model-quality',
      'ui.providers-schedule.coding-agents',
      'ui.usage-tools.usage-cost',
      'ui.chat-settings.voice-screen',
      'ui.chat-settings.knowledge-memory',
      'ui.chat-settings.schedule-calendar',
      'ui.mascot-theme.notifications-island',
      'ui.foundation.extensions-mcp',
      'ui.chat-settings.local-tools',
      'ui.chat-settings.privacy-permissions',
    ]);
  });

  it('有标签页的分区：标签 id 唯一、分区存在，tabOf 只认本分区的标签', () => {
    for (const [section, tabs] of Object.entries(SECTION_TABS)) {
      const ids = tabs.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(SETTINGS_SECTIONS.map((s) => s.id as string)).toContain(section);
    }
    expect(SECTION_TABS.knowledge.map((t) => t.id)).toEqual(['kb', 'memory', 'notes']);
    expect(SECTION_TABS.schedule.map((t) => t.id)).toEqual(['reminders', 'calendar']);
    expect(SECTION_TABS.privacy.map((t) => t.id)).toEqual(['data', 'outbound', 'desktop']);
    expect(SECTION_TABS.senses.map((t) => t.id)).toEqual(['voice', 'screen']);
    expect(SECTION_TABS.quality.map((t) => t.id)).toEqual(['compare', 'trend', 'requests']);
    expect(tabOf('quality', 'requests')).toBe('requests');
    expect(tabOf('knowledge', 'notes')).toBe('notes');
    expect(tabOf('knowledge', 'calendar')).toBeUndefined();
    expect(tabOf('schedule', 'calendar')).toBe('calendar');
    expect(tabOf('privacy', 'desktop')).toBe('desktop');
    expect(tabOf('privacy', 'outbound')).toBe('outbound');
    expect(tabOf('privacy', undefined)).toBeUndefined();
  });
});
