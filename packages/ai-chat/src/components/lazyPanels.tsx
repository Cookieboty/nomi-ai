/**
 * 路由级拆包：设置页与各功能面板按需加载，不进对话窗首屏 chunk。
 *
 * - `lazyPanel`：面板首次可见时才加载模块；加载后保持挂载（保留面板内部状态 / 关闭动画）。
 * - `LazySection`：设置页里切到某个分区时加载，加载期间显示占位。
 */
import React, { Suspense, lazy, useRef, useState, type ComponentType } from 'react';

import type { ConfigPanel as ConfigPanelT } from './ConfigPanel';
import type { DesktopPanel as DesktopPanelT } from './DesktopPanel';
import type { ExtensionsPanel as ExtensionsPanelT } from './ExtensionsPanel';
import type { HubPanel as HubPanelT } from './HubPanel';
import type { KnowledgePanel as KnowledgePanelT } from './KnowledgePanel';
import type { LocalPanel as LocalPanelT } from './LocalPanel';
import type { MemoryPanel as MemoryPanelT } from './MemoryPanel';
import type { NotesPanel as NotesPanelT } from './NotesPanel';
import { PanelFallback } from './PanelFallback';
import type { ProviderPanel as ProviderPanelT } from './ProviderPanel';
import type { SchedulePanel as SchedulePanelT } from './SchedulePanel';
import type { ScreenPanel as ScreenPanelT } from './ScreenPanel';
import type { SettingsView as SettingsViewT } from './SettingsView';
import type { UsagePanel as UsagePanelT } from './UsagePanel';

type PropsOf<T> = T extends React.ComponentType<infer P> ? P : never;

type Loader<P> = () => Promise<ComponentType<P>>;

/** 共享加载器：预取与懒渲染用同一个 Promise；已加载的组件直接同步渲染（不触发 Suspense）。 */
function loadable<P>(load: Loader<P>) {
  let done: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () =>
    (pending ||= load().then((c) => {
      done = c;
      return c;
    }));
  const Lazy = lazy(async () => ({ default: await get() }));
  prefetchers.push(get);
  return {
    get loaded() {
      return done;
    },
    Lazy,
  };
}

const prefetchers: Array<() => Promise<unknown>> = [];

/** 首屏空闲后预取全部面板 chunk，之后打开设置 / 面板不再等网络与解析。 */
export function prefetchPanels(): void {
  for (const p of prefetchers) void p().catch(() => undefined);
}

export function lazyComponent<P extends object>(load: Loader<P>): React.FC<P> {
  const m = loadable(load);
  const C: React.FC<P> = (props) => {
    // 挂载时定下用哪种渲染，之后不切换（切换会改变元素类型导致面板重挂载、丢状态）
    const [Done] = useState(() => m.loaded);
    if (Done) return <Done {...(props as P & React.JSX.IntrinsicAttributes)} />;
    return (
      <Suspense fallback={<PanelFallback />}>
        <m.Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
      </Suspense>
    );
  };
  return C;
}

export function lazyPanel<P extends { isVisible: boolean }>(load: Loader<P>): React.FC<P> {
  const m = loadable(load);
  const C: React.FC<P> = (props) => {
    const [mounted, setMounted] = useState(props.isVisible);
    if (props.isVisible && !mounted) setMounted(true);
    const choice = useRef<ComponentType<P> | null | undefined>(undefined);
    if (!mounted) return null;
    if (choice.current === undefined) choice.current = m.loaded;
    const Done = choice.current;
    if (Done) return <Done {...(props as P & React.JSX.IntrinsicAttributes)} />;
    return (
      <Suspense fallback={<PanelFallback />}>
        <m.Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
      </Suspense>
    );
  };
  return C;
}

export const SettingsView: React.FC<PropsOf<typeof SettingsViewT>> = lazyComponent(() =>
  import('./SettingsView').then((m) => m.SettingsView),
);
export const ConfigPanel: React.FC<PropsOf<typeof ConfigPanelT>> = lazyPanel(() =>
  import('./ConfigPanel').then((m) => m.ConfigPanel),
);
export const ProviderPanel: React.FC<PropsOf<typeof ProviderPanelT>> = lazyPanel(() =>
  import('./ProviderPanel').then((m) => m.ProviderPanel),
);
export const DesktopPanel: React.FC<PropsOf<typeof DesktopPanelT>> = lazyPanel(() =>
  import('./DesktopPanel').then((m) => m.DesktopPanel),
);
export const KnowledgePanel: React.FC<PropsOf<typeof KnowledgePanelT>> = lazyPanel(() =>
  import('./KnowledgePanel').then((m) => m.KnowledgePanel),
);
export const MemoryPanel: React.FC<PropsOf<typeof MemoryPanelT>> = lazyPanel(() =>
  import('./MemoryPanel').then((m) => m.MemoryPanel),
);
export const NotesPanel: React.FC<PropsOf<typeof NotesPanelT>> = lazyPanel(() =>
  import('./NotesPanel').then((m) => m.NotesPanel),
);
export const HubPanel: React.FC<PropsOf<typeof HubPanelT>> = lazyPanel(() =>
  import('./HubPanel').then((m) => m.HubPanel),
);
export const SchedulePanel: React.FC<PropsOf<typeof SchedulePanelT>> = lazyPanel(() =>
  import('./SchedulePanel').then((m) => m.SchedulePanel),
);
export const ScreenPanel: React.FC<PropsOf<typeof ScreenPanelT>> = lazyPanel(() =>
  import('./ScreenPanel').then((m) => m.ScreenPanel),
);
export const ExtensionsPanel: React.FC<PropsOf<typeof ExtensionsPanelT>> = lazyPanel(() =>
  import('./ExtensionsPanel').then((m) => m.ExtensionsPanel),
);
export const LocalPanel: React.FC<PropsOf<typeof LocalPanelT>> = lazyPanel(() =>
  import('./LocalPanel').then((m) => m.LocalPanel),
);
export const UsagePanel: React.FC<PropsOf<typeof UsagePanelT>> = lazyComponent(() =>
  import('./UsagePanel').then((m) => m.UsagePanel),
);
