import React from 'react';

/** 是否运行在桌面应用里（有一体化标题栏）：main.tsx 按平台设置 html[data-platform] */
export const hasAppTitleBar = (): boolean =>
  typeof document !== 'undefined' && Boolean(document.documentElement.dataset.platform);

/**
 * 一体化标题栏（仅在桌面应用里出现：html[data-platform] 由 main.tsx 设置）。
 * 整条可拖动；macOS 左侧给红绿灯留位，Windows / Linux 右侧给原生按钮 overlay 留位
 * （`env(titlebar-area-width)` 由 Window Controls Overlay 提供）。
 */
export const AppTitleBar: React.FC = () => (
  <div className="app-titlebar" data-testid="app-titlebar">
    <span className="app-titlebar-title">Nomi</span>
  </div>
);
