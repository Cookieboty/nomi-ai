/**
 * 设置 → 通用 → 外观 → 界面模式：工作台的精简 / 全量（services/chatPrefs 的 LayoutDensity）。
 * 精简隐藏顶部对话标签条与侧栏底部的编程助手信息卡；助手模式本来就没有这两块，不受影响。
 */
import { SegmentedControl, SettingRow, t } from '@nomi-ai/ui';
import React from 'react';

import { useLayoutDensity } from '../../hooks/useLayoutDensity';
import type { LayoutDensity } from '../../services/chatPrefs';

export const LAYOUT_DENSITIES: { id: LayoutDensity; label: () => string; hint: () => string }[] = [
  {
    id: 'full',
    label: () => t('ui.chat-settings.full-mode'),
    hint: () => t('ui.chat-settings.conversation-tabs-at-the-top-and-the-coding'),
  },
  {
    id: 'compact',
    label: () => t('ui.chat-settings.compact-mode'),
    hint: () => t('ui.chat-settings.hides-the-conversation-tabs-and-the-sidebar-info'),
  },
];

export const LayoutDensitySettings: React.FC = () => {
  const { density, setDensity } = useLayoutDensity();
  const current = LAYOUT_DENSITIES.find((d) => d.id === density) ?? LAYOUT_DENSITIES[0]!;
  return (
    <SettingRow
      data-testid="settings-layout-density"
      title={t('ui.chat-settings.layout')}
      description={t(
        'ui.chat-settings.only-affects-the-workbench-assistant-mode-has-neither',
        current.hint(),
      )}
    >
      <SegmentedControl
        aria-label={t('ui.chat-settings.layout')}
        value={density}
        onChange={(d) => setDensity(d)}
        options={LAYOUT_DENSITIES.map((d) => ({
          value: d.id,
          label: d.label(),
          testId: `layout-density-${d.id}`,
        }))}
      />
    </SettingRow>
  );
};
