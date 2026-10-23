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
    label: () => t('全量模式'),
    hint: () => t('顶部显示对话标签，侧栏底部显示编程助手信息卡（版本、账号、额度、今日用量）'),
  },
  {
    id: 'compact',
    label: () => t('精简模式'),
    hint: () => t('隐藏顶部对话标签与侧栏底部的信息卡，只留会话列表和对话；在侧栏里切换会话'),
  },
];

export const LayoutDensitySettings: React.FC = () => {
  const { density, setDensity } = useLayoutDensity();
  const current = LAYOUT_DENSITIES.find((d) => d.id === density) ?? LAYOUT_DENSITIES[0]!;
  return (
    <SettingRow
      data-testid="settings-layout-density"
      title={t('界面模式')}
      description={t('{0}。只影响工作台，助手模式没有这两块。', current.hint())}
    >
      <SegmentedControl
        aria-label={t('界面模式')}
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
