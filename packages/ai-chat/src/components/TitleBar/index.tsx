import { brand } from '@nomi-ai/types';
import { Icon, t } from '@nomi-ai/ui';
import { PanelLeft } from 'lucide-react';
import React from 'react';

/** 是否运行在桌面应用里（有一体化标题栏）：main.tsx 按平台设置 html[data-platform] */
export const hasAppTitleBar = (): boolean =>
  typeof document !== 'undefined' && Boolean(document.documentElement.dataset.platform);

/** 收起 / 展开侧栏按钮的提示与读屏文字（标题栏按钮与侧栏 Nomi 标志共用） */
export function sidebarToggleLabels(collapsed: boolean): { title: string; label: string } {
  return collapsed
    ? {
        title: t('ui.chat-settings.expand-sidebar-ctrl-b'),
        label: t('ui.chat-settings.expand-sidebar'),
      }
    : {
        title: t('ui.chat-settings.collapse-sidebar-ctrl-b'),
        label: t('ui.chat-settings.collapse-sidebar'),
      };
}

/**
 * 一体化标题栏（仅在桌面应用里出现：html[data-platform] 由 main.tsx 设置）。
 * 整条可拖动；macOS 左侧给红绿灯留位，Windows / Linux 右侧给原生按钮 overlay 留位
 * （`env(titlebar-area-width)` 由 Window Controls Overlay 提供）。
 * 侧栏收起 / 展开按钮固定在这里（macOS 紧跟红绿灯），侧栏收起后位置也不变。
 */
export const AppTitleBar: React.FC<{
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}> = ({ sidebarCollapsed, onToggleSidebar }) => {
  const labels = sidebarToggleLabels(sidebarCollapsed);
  return (
    <div className="app-titlebar" data-testid="app-titlebar">
      <button
        type="button"
        className="app-titlebar-toggle"
        onClick={onToggleSidebar}
        title={labels.title}
        aria-label={labels.label}
        aria-pressed={!sidebarCollapsed}
        data-testid="titlebar-sidebar-toggle"
      >
        <Icon icon={PanelLeft} size={16} />
      </button>
      <span className="app-titlebar-title">{brand.appName}</span>
    </div>
  );
};
