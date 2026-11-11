import { describe, expect, it } from 'vitest';

import { SECTION_TABS, SETTINGS_SECTIONS, tabOf } from '../src/components/SettingsView/sections';

describe('设置分区：合并后的菜单', () => {
  it('11 个分区；Nomi 自己的设置单独一个分区，紧跟通用', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'nomi',
      'models',
      'usage',
      'coding',
      'computer',
      'knowledge',
      'ext',
      'connections',
      'privacy',
      'about',
    ]);
    // 命令面板的设置条目由分区生成：不再有单独的「快捷键」入口
    expect(SETTINGS_SECTIONS.some((s) => (s.id as string) === 'shortcuts')).toBe(false);
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      'ui.chat-settings.general',
      'ui.chat-settings.nomi-section',
      'ui.chat-settings.models-and-providers',
      'ui.chat-settings.usage-and-analytics',
      'ui.providers-schedule.coding-agents',
      'ui.chat-settings.computer-section',
      'ui.chat-settings.knowledge-memory',
      'ui.foundation.extensions-mcp',
      'ui.providers-schedule.connections',
      'ui.chat-settings.privacy-permissions',
      'ui.chat-settings.about-section',
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
    // 桌面权限从「隐私与权限」挪到「Nomi」（Nomi 自己的工具权限）
    // 已归档的对话从「通用」挪到「Nomi」（归档的是 Nomi 对话）
    // 权限与委派合在「permissions」一个标签下
    expect(SECTION_TABS.nomi.map((t) => t.id)).toEqual(['permissions', 'tools', 'archived']);
    expect(SECTION_TABS.privacy.map((t) => t.id)).toEqual(['data', 'outbound', 'export']);
    expect(tabOf('usage', 'requests')).toBe('requests');
    expect(tabOf('knowledge', 'schedule')).toBe('schedule');
    expect(tabOf('knowledge', 'notes')).toBeUndefined();
    expect(tabOf('privacy', 'export')).toBe('export');
    expect(tabOf('privacy', undefined)).toBeUndefined();
  });
});
