/** 面板工具保留原组件状态，通过 portal 在桌面顶栏中展示；浏览器预览沿用面板内工具栏。 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

type Slot = 'session' | 'center' | 'files' | 'workspace-actions' | 'rail-toggle';
interface Slots {
  targets: Partial<Record<Slot, HTMLElement>>;
  register: (name: Slot, element: HTMLElement | null) => void;
}
const Context = createContext<Slots | null>(null);

export function TitlebarPanelsProvider({ children }: { children: React.ReactNode }) {
  const [targets, setTargets] = useState<Slots['targets']>({});
  const register = useCallback((name: Slot, element: HTMLElement | null) => {
    if (!document.documentElement.dataset.platform) return;
    setTargets((prev) => {
      if (prev[name] === (element ?? undefined)) return prev;
      const next = { ...prev };
      if (element) next[name] = element;
      else delete next[name];
      return next;
    });
  }, []);
  const value = useMemo(() => ({ targets, register }), [targets, register]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function TitlebarSlot({ name, className }: { name: Slot; className?: string }) {
  const register = useContext(Context)?.register;
  const ref = useCallback((el: HTMLDivElement | null) => register?.(name, el), [register, name]);
  return <div ref={ref} className={className} data-titlebar-slot={name} />;
}

export function TitlebarContent({
  name,
  children,
  enabled = true,
}: {
  name: Slot;
  children: React.ReactNode;
  enabled?: boolean;
}) {
  const target = useContext(Context)?.targets[name];
  return enabled && target ? createPortal(children, target) : <>{children}</>;
}
