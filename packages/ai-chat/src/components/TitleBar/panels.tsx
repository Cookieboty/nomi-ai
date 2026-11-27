/** 面板工具保留原组件状态，通过 portal 在桌面顶栏中展示；浏览器预览沿用面板内工具栏。 */
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Slot = 'session' | 'center' | 'files' | 'workspace-actions' | 'rail-toggle';
interface Slots {
  targets: Partial<Record<Slot, HTMLElement>>;
  register: (name: Slot, element: HTMLElement | null, expectedPrev?: HTMLElement | null) => void;
}
const Context = createContext<Slots | null>(null);

export function TitlebarPanelsProvider({ children }: { children: React.ReactNode }) {
  const [targets, setTargets] = useState<Slots['targets']>({});
  const register = useCallback(
    (name: Slot, element: HTMLElement | null, expectedPrev?: HTMLElement | null) => {
      if (!document.documentElement.dataset.platform) return;
      setTargets((prev) => {
        if (element) {
          if (prev[name] === element) return prev;
          return { ...prev, [name]: element };
        }
        // 新旧槽位交替挂载时只删自己注册过的那个节点，避免后清理的旧槽位误删新槽位
        if (expectedPrev !== undefined && prev[name] !== expectedPrev) return prev;
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
    },
    [],
  );
  const value = useMemo(() => ({ targets, register }), [targets, register]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function TitlebarSlot({ name, className }: { name: Slot; className?: string }) {
  const register = useContext(Context)?.register;
  const elRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        elRef.current = el;
        register?.(name, el);
      } else {
        const prevEl = elRef.current;
        elRef.current = null;
        register?.(name, null, prevEl);
      }
    },
    [register, name],
  );
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
