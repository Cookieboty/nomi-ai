/**
 * 对话窗口的面板与侧栏开关：设置（覆盖层）、桌面能力 / 扩展（右侧抽屉，「在设置中打开」）、知识中心抽屉、
 * 编程助手插件面板、侧栏收起。托盘、桌面角色、新手引导里的「打开某个面板」也接在这里。
 * 回调都保持引用稳定：侧栏、输入框是 memo 组件，换引用会连带整列重渲染。
 */
import type { ModalHost } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { AppEntries } from '../components/AppEntries';
import { OPEN_MODELS_EVENT } from '../components/Onboarding/client';
import type { SettingsSection, SettingsTab } from '../components/SettingsView/sections';
import { setProviderEndpoint } from '../services/chatPrefs';
import { desktopClient } from '../services/desktopClient';
import { providerClient } from '../services/providerClient';
import { isConversationBackend } from '../types/chat';

export function useAppPanels() {
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [settingsLink, setSettingsLink] = useState<{ tab?: SettingsTab } | undefined>();
  const [showDesktop, setShowDesktop] = useState(false);
  const [showExt, setShowExt] = useState(false);
  const [showHub, setShowHub] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 720);

  // 窗口变窄时自动收起侧栏，避免挤压对话区
  useEffect(() => {
    const onResize = () => window.innerWidth < 720 && setSidebarCollapsed(true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const openSettings = useCallback((sec: SettingsSection = 'general', tab?: SettingsTab) => {
    setSettingsLink(tab ? { tab } : undefined);
    setShowExt(false);
    setShowDesktop(false);
    setShowHub(false);
    setSettings(sec);
  }, []);

  // 托盘「桌面能力…」→ 桌面能力面板；托盘「模型设置…」→ 设置 →「模型与供应商」
  useEffect(() => desktopClient.onOpenPanel(() => setShowDesktop(true)), []);
  useEffect(() => providerClient.onOpenPanel(() => openSettings('models')), [openSettings]);
  // 新手引导里「打开完整模型设置」/「去接上模型」
  useEffect(() => {
    const open = () => openSettings('models');
    window.addEventListener(OPEN_MODELS_EVENT, open);
    return () => window.removeEventListener(OPEN_MODELS_EVENT, open);
  }, [openSettings]);
  // 桌面角色「TTS 语音配置」/ 语音错误「去设置」→ 设置 → 通用 → 语音；「日程」→ 知识与记忆 → 日程
  useEffect(
    () => desktopClient.onOpenVoiceSettings(() => openSettings('general', 'voice')),
    [openSettings],
  );
  useEffect(
    () => desktopClient.onOpenSchedule(() => openSettings('knowledge', 'schedule')),
    [openSettings],
  );

  const closeSettings = useCallback(() => setSettings(null), []);
  const toggleSettings = useCallback(() => setSettings((s) => (s ? null : 'general')), []);
  const openPlugins = useCallback(() => setShowPlugins(true), []);
  const closePlugins = useCallback(() => setShowPlugins(false), []);
  /** 插件面板里「管理 Nomi 的扩展」：换到扩展抽屉 */
  const pluginsToExt = useCallback(() => {
    setShowPlugins(false);
    setShowExt(true);
  }, []);
  const openProviders = useCallback(() => openSettings('models'), [openSettings]);
  const openLocal = useCallback(() => openSettings('models', 'local'), [openSettings]);
  const openGeneralSettings = useCallback(() => openSettings(), [openSettings]);
  const onInputSettings = useCallback(
    (sec?: SettingsSection, endpoint?: unknown) => {
      if (isConversationBackend(endpoint)) setProviderEndpoint(endpoint);
      openSettings(sec);
    },
    [openSettings],
  );
  const openDesktop = useCallback(() => setShowDesktop(true), []);
  const closeDesktop = useCallback(() => setShowDesktop(false), []);
  // 知识 · 记忆 · 日程与扩展都是右侧抽屉，一次只开一个
  const openHub = useCallback(() => {
    setShowExt(false);
    setShowHub(true);
  }, []);
  const toggleHub = useCallback(() => {
    setShowExt(false);
    setShowHub((v) => !v);
  }, []);
  const closeHub = useCallback(() => setShowHub(false), []);
  const hubToSettings = useCallback(
    (tab: SettingsTab) => openSettings('knowledge', tab),
    [openSettings],
  );
  const openExt = useCallback(() => {
    setShowHub(false);
    setShowExt(true);
  }, []);
  const toggleExt = useCallback(() => {
    setShowHub(false);
    setShowExt((v) => !v);
  }, []);
  const closeExt = useCallback(() => setShowExt(false), []);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const expandSidebar = useCallback(() => setSidebarCollapsed(false), []);

  // 快速视图：右侧抽屉 + 「在设置中打开」
  const drawerHost = useMemo(() => {
    const mk = (sec: SettingsSection, tab?: SettingsTab): ModalHost => ({
      mode: 'drawer',
      onOpenSettings: () => openSettings(sec, tab),
    });
    return { ext: mk('ext'), desktop: mk('nomi', 'tools') };
  }, [openSettings]);
  // 侧栏底部的应用级入口
  const sidebarFooter = useMemo(
    () => <AppEntries collapsed onHub={openHub} onExt={openExt} onSettings={openGeneralSettings} />,
    [openHub, openExt, openGeneralSettings],
  );

  return {
    settings,
    setSettings,
    settingsLink,
    showDesktop,
    showExt,
    showHub,
    showPlugins,
    sidebarCollapsed,
    openSettings,
    closeSettings,
    toggleSettings,
    openPlugins,
    closePlugins,
    pluginsToExt,
    openProviders,
    openLocal,
    onInputSettings,
    openDesktop,
    closeDesktop,
    openHub,
    toggleHub,
    closeHub,
    hubToSettings,
    openExt,
    toggleExt,
    closeExt,
    toggleSidebar,
    expandSidebar,
    drawerHost,
    sidebarFooter,
  };
}

export type AppPanels = ReturnType<typeof useAppPanels>;
