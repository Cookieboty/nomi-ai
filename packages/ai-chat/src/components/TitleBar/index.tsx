import { Icon, t } from '@nomi-ai/ui';
import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { isGoHost } from '../../services/api';

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

/** Go 宿主页面里的 Wails 运行时（/wails/runtime.js 设到 window.wails）：只用到当前窗口的这几个方法 */
interface WailsWindow {
  Minimise(): Promise<void>;
  ToggleMaximise(): Promise<void>;
  IsMaximised(): Promise<boolean>;
  Close(): Promise<void>;
}
const wailsWindow = (): WailsWindow | null =>
  (window as unknown as { wails?: { Window?: WailsWindow } }).wails?.Window ?? null;

/** Windows / Linux 的 Go 宿主：对话窗口无边框，双击标题栏空白处最大化 / 还原（同系统标题栏） */
const onTitleBarDoubleClick = (e: React.MouseEvent) => {
  if (!isGoHost() || (e.target as HTMLElement).closest('button')) return;
  if (document.documentElement.dataset.platform === 'darwin') return;
  void wailsWindow()?.ToggleMaximise();
};

/**
 * Go 宿主（Windows / Linux）的窗口按钮：Electron 由系统画在 Window Controls Overlay 里，Wails 没有，
 * 无边框窗口由这里自绘，占 Electron 给 overlay 留的右侧位置。mac 用红绿灯，样式里隐藏。
 * 关闭走 Wails 的 Window.Close → 宿主的 WindowClosing（与点系统关闭按钮相同：按 closeMain 隐藏或退出）。
 */
const WindowControls: React.FC = () => {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const sync = () =>
      void wailsWindow()
        ?.IsMaximised()
        .then(setMaximized, () => undefined);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  const maxLabel = maximized
    ? t('ui.chat-settings.restore-window')
    : t('ui.chat-settings.maximize-window');
  return (
    <div className="app-window-controls" data-testid="window-controls">
      <button
        type="button"
        onClick={() => void wailsWindow()?.Minimise()}
        aria-label={t('ui.chat-settings.minimize-window')}
        data-testid="window-minimize"
      >
        <Icon icon={Minus} size={16} />
      </button>
      <button
        type="button"
        onClick={() => void wailsWindow()?.ToggleMaximise()}
        aria-label={maxLabel}
        data-testid="window-maximize"
      >
        <Icon icon={maximized ? Copy : Square} size={maximized ? 14 : 13} />
      </button>
      <button
        type="button"
        className="app-window-close"
        onClick={() => void wailsWindow()?.Close()}
        aria-label={t('ui.providers-schedule.close')}
        data-testid="window-close"
      >
        <Icon icon={X} size={16} />
      </button>
    </div>
  );
};

/**
 * 一体化标题栏（仅在桌面应用里出现：html[data-platform] 由 main.tsx 设置）。
 * 整条可拖动；macOS 左侧给红绿灯留位，Windows / Linux 右侧给窗口按钮留位
 * （Electron：原生 Window Controls Overlay，宽度由 `env(titlebar-area-width)` 提供；Go 宿主：WindowControls 自绘）。
 * 侧栏收起 / 展开按钮固定在这里（macOS 紧跟红绿灯），侧栏收起后位置也不变。
 */
export const AppTitleBar: React.FC<{
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** 对话卡片上方左侧：当前会话（工作区图标 + 名称）；新会话时为空 */
  title?: React.ReactNode;
  /** 对话卡片上方右侧：会话菜单「…」、工具栏开关 */
  trailing?: React.ReactNode;
  /** 最右侧、任何页面都显示：Agent 看板的负载指示 */
  status?: React.ReactNode;
}> = ({ sidebarCollapsed, onToggleSidebar, title, trailing, status }) => {
  const labels = sidebarToggleLabels(sidebarCollapsed);
  return (
    <div
      className="app-titlebar"
      data-testid="app-titlebar"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      onDoubleClick={onTitleBarDoubleClick}
    >
      <button
        type="button"
        className="app-titlebar-toggle"
        onClick={onToggleSidebar}
        title={labels.title}
        aria-label={labels.label}
        aria-pressed={!sidebarCollapsed}
        data-testid="titlebar-sidebar-toggle"
      >
        <Icon icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose} size={16} />
      </button>
      {/* 与对话卡片左边对齐：会话名在这里，不再显示产品名 */}
      <div className="app-titlebar-main">
        <div className="app-titlebar-title" data-testid="titlebar-title">
          {title}
        </div>
        {(trailing || status) && (
          <div className="app-titlebar-actions">
            {trailing}
            {status}
          </div>
        )}
      </div>
      {isGoHost() && <WindowControls />}
    </div>
  );
};
