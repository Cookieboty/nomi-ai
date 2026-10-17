import { X } from 'lucide-react';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cx } from './cx';
import { t as tr } from './i18n';
import { Icon } from './icons';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastItem {
  id: number;
  message: React.ReactNode;
  tone: ToastTone;
}

export interface ToastOptions {
  tone?: ToastTone;
  /** ms；0 = 不自动消失。默认 3000 */
  duration?: number;
}

interface ToastApi {
  show: (message: React.ReactNode, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export const Toast: React.FC<{
  tone?: ToastTone;
  onClose?: () => void;
  children: React.ReactNode;
}> = ({ tone = 'info', onClose, children }) => (
  <div
    role={tone === 'danger' ? 'alert' : 'status'}
    className={cx('cd-toast', tone !== 'info' && `cd-toast--${tone}`)}
  >
    <span className="cd-toast__msg">{children}</span>
    {onClose && (
      <button
        type="button"
        className="cd-btn cd-btn--ghost cd-btn--sm cd-icon-btn"
        aria-label={tr('关闭提示')}
        onClick={onClose}
      >
        <Icon icon={X} />
      </button>
    )}
  </div>
);

/** 在应用根部包一层；子组件用 useToast().show('已保存', { tone: 'success' }) */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (message: React.ReactNode, opts: ToastOptions = {}) => {
      const id = ++seq.current;
      setItems((xs) => [...xs, { id, message, tone: opts.tone ?? 'info' }]);
      const duration = opts.duration ?? 3000;
      if (duration > 0)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="cd-toast-stack" aria-live="polite">
        {items.map((t) => (
          <Toast key={t.id} tone={t.tone} onClose={() => dismiss(t.id)}>
            {t.message}
          </Toast>
        ))}
      </div>
    </Ctx.Provider>
  );
};

/** 无 Provider 时返回 no-op，组件可在任何环境安全调用。 */
export function useToast(): ToastApi {
  return useContext(Ctx) ?? { show: () => -1, dismiss: () => undefined };
}
