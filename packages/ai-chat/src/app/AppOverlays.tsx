/**
 * 盖在对话窗口上的一层：设置（覆盖层，会话树保持挂载）、命令面板、编程助手插件面板、桌面能力 / 扩展 /
 * 知识中心抽屉、分叉目标选择框与底部的短提示。
 */
import { ModalHostContext } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { CommandPalette } from '../components/CommandPalette';
import { ForkDialog } from '../components/ForkMenu';
import { HubDrawer } from '../components/HubDrawer';
import { DesktopPanel, ExtensionsPanel, SettingsView } from '../components/lazyPanels';
import { PluginPanel } from '../components/PluginPanel';
import { useConversationWriteNotice } from '../hooks/useConversationWriteNotice';
import type { SlashHook } from '../slash/useSlashCommands';
import type { ConversationBackend } from '../types/chat';

import type { useAppCommands } from './useAppCommands';
import type { AppPanels } from './useAppPanels';

/** 底部的短提示（分叉结果、写入失败等），2.4 秒后消失 */
export function useToast(): [string | null, (msg: string | null) => void] {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const tid = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(tid);
  }, [toast]);
  const set = useCallback((msg: string | null) => setToast(msg), []);
  useConversationWriteNotice(set);
  return [toast, set];
}

export const AppOverlays: React.FC<{
  panels: AppPanels;
  commands: ReturnType<typeof useAppCommands>;
  slash: SlashHook;
  slashBackend: ConversationBackend;
  slashCwd: string;
  toast: string | null;
}> = ({ panels: p, commands: c, slash, slashBackend, slashCwd, toast }) => (
  <>
    {/* 设置为覆盖层：会话树保持挂载，仅被此层盖住；关闭即瞬时回到原会话 */}
    {p.settings && (
      <div className="settings-overlay">
        <SettingsView
          section={p.settings}
          deepLink={p.settingsLink}
          onSection={p.setSettings}
          onClose={p.closeSettings}
          collapsed={p.sidebarCollapsed}
        />
      </div>
    )}
    {/* 模型配置保持为弹窗；日常功能为右侧抽屉（快速视图） */}
    <CommandPalette open={c.palette} onClose={c.closePalette} commands={c.paletteCommands} />
    <PluginPanel
      isVisible={p.showPlugins}
      onClose={p.closePlugins}
      backend={slashBackend}
      cwd={slashCwd}
      entries={slash.discovered}
      onRefresh={slash.bridge.refresh}
      onManageNomi={p.pluginsToExt}
    />
    <ModalHostContext.Provider value={p.drawerHost.desktop}>
      <DesktopPanel isVisible={p.showDesktop} onClose={p.closeDesktop} />
    </ModalHostContext.Provider>
    <ModalHostContext.Provider value={p.drawerHost.ext}>
      <ExtensionsPanel isVisible={p.showExt} onClose={p.closeExt} />
    </ModalHostContext.Provider>
    <HubDrawer open={p.showHub} onClose={p.closeHub} onOpenSettings={p.hubToSettings} />
    <ForkDialog
      open={!!c.forkTarget}
      current={c.forkTarget?.backend ?? 'nomi'}
      allowCross={c.isDev}
      fromMessage={!!c.forkTarget?.upto}
      project={c.forkTarget?.projectId}
      onClose={c.closeFork}
      onPick={c.pickFork}
    />
    {toast && (
      <div
        role="status"
        data-testid="fork-toast"
        style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 120,
          padding: 'var(--cd-space-2) var(--cd-space-3)',
          borderRadius: 'var(--cd-radius-md)',
          background: 'var(--cd-color-surface-raised)',
          border: '1px solid var(--cd-color-border)',
          boxShadow: 'var(--cd-shadow-popover)',
          fontSize: 'var(--cd-font-size-sm)',
        }}
      >
        {toast}
      </div>
    )}
  </>
);
