/**
 * 弹出窗口（标签区的标签弹到独立窗口，见 docs/design/side-tabs-workspace.md）：
 * 同一个对话页面带 ?detached=<spec> 打开，这里只画那一个子任务 / 文件，不挂侧栏、主列和各种整页。
 * 数据层和主窗口一样（AiChatContextProvider / HarnessTabsProvider / 标签区 Provider），都按会话 / 标签 id 绑定，
 * 所以流式输出、输入栏、排队、授权回复和在主窗口里一样；本窗口的标签区状态不落盘（会话键为空）。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import * as AISdkReact from '@nomi-ai/ai-sdk-client/react';
import { Button, Icon, t } from '@nomi-ai/ui';
import { Undo2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { ChatBackgroundLayer } from '../components/ChatBackground/ChatBackgroundLayer';
import { ErrorBoundary } from '../components/ErrorBoundary';
import type { PreviewTabsControl } from '../components/ResourcePreview/ResourcePreview';
import { useSubagentPane, SubagentPane, WorkspacePanesProvider } from '../components/SubagentPane';
import { wailsWindow, WindowControls } from '../components/TitleBar';
import { AiChatContextProvider } from '../contexts/AiChatContext';
import { HarnessTabsProvider, useHarnessTabs } from '../contexts/HarnessTabsContext';
import { ResourceScopeProvider } from '../contexts/ResourceContext';
import { useResourcePreview } from '../hooks/useResourcePreview';
import { detachedWindows } from '../services/detachedWindows';
import { detachSpecKey, type DetachSpec } from '../utils/detachedTabs';
import { agentKey } from '../utils/sideTabs';
import '../App.css';

import styles from './DetachedApp.module.css';

const NO_MESSAGES: never[] = [];

/** 窗口标题跟着子任务名字变（任务栏 / Dock / ⌘` 里看得到） */
function useWindowTitle(name: string) {
  useEffect(() => {
    const title = name ? `${name} — Nomi` : 'Nomi';
    document.title = title;
    void wailsWindow()
      ?.SetTitle?.(title)
      ?.catch(() => undefined);
  }, [name]);
}

const Bar: React.FC<{ title: string; onDock?: () => void }> = ({ title, onDock }) => (
  <header className={styles.bar} data-testid="detached-bar">
    <span className={styles.title}>{title}</span>
    {onDock && (
      <Button size="sm" variant="ghost" onClick={onDock} data-testid="detached-dock">
        <Icon icon={Undo2} size={14} />
        {t('ui.session-workspace.side-tab-dock')}
      </Button>
    )}
    <WindowControls />
  </header>
);

const AgentWindow: React.FC<{ spec: Extract<DetachSpec, { kind: 'agent' }> }> = ({ spec }) => {
  const pane = useSubagentPane();
  const key = agentKey(spec.target);
  const { openSubagent, openNested, openNomiTask } = pane ?? {};
  useEffect(() => {
    const target = spec.target;
    if (target.kind === 'harness') openSubagent?.(target.tabId);
    else if (target.kind === 'nested') openNested?.(target.callId, target.parentTabId);
    else openNomiTask?.(target.taskId);
  }, [spec.target, openSubagent, openNested, openNomiTask]);
  const name = pane?.meta[key]?.name || spec.title;
  useWindowTitle(name);
  // 编程助手标签 / 来源标签已经关掉了（标签列表读到之后才判断）
  const harnessLoaded = !!useHarnessTabs().state;
  const gone =
    !!pane && pane.targets.length === 0 && spec.target.kind !== 'nomi-task' && harnessLoaded;
  return (
    <>
      <Bar title={name} onDock={() => void detachedWindows.dock(spec.scope, key)} />
      <main className={styles.body} data-testid="detached-agent">
        <SubagentPane columnMessages={NO_MESSAGES} standalone />
        {gone && (
          <p className={styles.empty}>{t('ui.session-workspace.side-tab-detached-missing')}</p>
        )}
      </main>
    </>
  );
};

const FileWindow: React.FC<{ spec: Extract<DetachSpec, { kind: 'file' }> }> = ({ spec }) => {
  const preview = useResourcePreview(spec.origin);
  const { open } = preview.value;
  const [control] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    open(spec.href, spec.origin);
  }, [open, spec.href, spec.origin]);
  if (preview.isOpen && !opened) setOpened(true);
  useWindowTitle(spec.title);
  // 窗口里把文件关掉了：关窗口
  const empty = opened && !preview.isOpen;
  useEffect(() => {
    if (empty) void wailsWindow()?.Close();
  }, [empty]);
  return (
    <ResourceScopeProvider value={preview.value}>
      <Bar title={spec.title} />
      <main className={styles.body} data-testid="detached-file">
        {preview.renderEmbedded({
          inactive: false,
          expanded: true,
          onExpanded: () => undefined,
          controlRef: control,
        })}
        {preview.overlays}
      </main>
    </ResourceScopeProvider>
  );
};

function useOptionalAIClient(): ClientAIClient | undefined {
  const hook = (AISdkReact as { useAIClient?: () => ClientAIClient }).useAIClient;
  if (!hook) return undefined;
  try {
    return hook();
  } catch {
    return undefined;
  }
}

export function DetachedApp({ spec }: { spec: DetachSpec }) {
  const client = useOptionalAIClient();
  const key = useMemo(() => detachSpecKey(spec), [spec]);
  return (
    <ErrorBoundary>
      <AiChatContextProvider client={client}>
        <HarnessTabsProvider>
          <WorkspacePanesProvider>
            <div className={styles.app} data-detached-tab={key}>
              <ChatBackgroundLayer />
              {spec.kind === 'agent' ? <AgentWindow spec={spec} /> : <FileWindow spec={spec} />}
            </div>
          </WorkspacePanesProvider>
        </HarnessTabsProvider>
      </AiChatContextProvider>
    </ErrorBoundary>
  );
}
