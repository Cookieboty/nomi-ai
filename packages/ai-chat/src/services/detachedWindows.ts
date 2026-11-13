/**
 * 标签弹到独立窗口：宿主的 chatWindow.*（Go：core/tabwindows + wailsshell/detachedwindow.go）。
 * 浏览器预览 / 测试里没有宿主：available() 为 false，标签栏不显示「在新窗口打开」。
 */
import { createLogger } from '@nomi-ai/ui';
import { useEffect, useState } from 'react';

import { detachedId, detachSpecKey, type DetachSpec } from '../utils/detachedTabs';

import { api, hasTransport } from './api';

const log = createLogger('detached-windows');

export const detachedWindows = {
  available: () => hasTransport(),
  /** 弹出（已开着时把那个窗口提到最前）；返回是否成功 */
  async detach(spec: DetachSpec): Promise<boolean> {
    if (!hasTransport()) return false;
    try {
      const r = await api.chatWindow.detachTab({
        id: detachedId(spec.scope, detachSpecKey(spec)),
        title: spec.title.slice(0, 200),
        spec: JSON.stringify(spec),
      });
      return !!r?.ok;
    } catch (error) {
      log.warn('弹出窗口失败', error);
      return false;
    }
  },
  /** 已经弹出去的标签：把窗口提到最前 */
  focus(scope: string, key: string): void {
    if (!hasTransport()) return;
    void api.chatWindow
      .detachTab({ id: detachedId(scope, key), title: '', spec: '{}' })
      .catch((error: unknown) => log.warn('聚焦弹出窗口失败', error));
  },
  /** 弹出窗口里「放回主窗口」 */
  dock(scope: string, key: string): Promise<boolean> {
    if (!hasTransport()) return Promise.resolve(false);
    return api.chatWindow.dockTab({ id: detachedId(scope, key) }).catch(() => false);
  },
  /** 主窗口：「放回主窗口」后切到那个标签 */
  onDocked(fn: (id: string) => void): () => void {
    if (!hasTransport()) return () => undefined;
    return api.on('chatWindow.tabDocked', (e) => fn(e.id));
  },
};

/** 开着的弹出窗口 id（宿主推送的整份列表） */
export function useDetachedIds(): readonly string[] {
  const [ids, setIds] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!hasTransport()) return;
    let alive = true;
    void api.chatWindow
      .detachedTabs()
      .then((list) => {
        if (alive && Array.isArray(list)) setIds(list);
      })
      .catch(() => undefined);
    const off = api.on('chatWindow.detachedChanged', (list) => {
      if (Array.isArray(list)) setIds(list);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return ids;
}
