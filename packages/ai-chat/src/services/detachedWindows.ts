/**
 * 标签弹到独立窗口：宿主的 chatWindow.*（Go：core/tabwindows + wailsshell/detachedwindow.go）。
 * 浏览器预览 / 测试里没有宿主：available() 为 false，标签栏不显示「在新窗口打开」。
 */
import { createLogger } from '@nomi-ai/ui';
import { useEffect, useState } from 'react';

import { detachedId, detachSpecKey, type DetachSpec } from '../utils/detachedTabs';

import { api, hasTransport } from './api';

const log = createLogger('detached-windows');

let transferSeq = 0;

export type HandoffDirection = 'detach' | 'dock';

export const detachedWindows = {
  available: () => hasTransport(),
  /** 生成一次跨窗口交接 / 放回传输 id */
  newTransferId(): string {
    transferSeq += 1;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      return crypto.randomUUID();
    return `tr-${Date.now().toString(36)}-${transferSeq.toString(36)}`;
  },
  /** 主窗口登记为弹出标签放回接收者（排他） */
  async registerHost(): Promise<boolean> {
    if (!hasTransport()) return false;
    try {
      return !!(await api.chatWindow.registerHost());
    } catch (error) {
      log.warn('登记主窗口接收者失败', error);
      return false;
    }
  },
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
  dock(
    scope: string,
    key: string,
    opts?: { transferId?: string; requireAck?: boolean },
  ): Promise<boolean> {
    if (!hasTransport()) return Promise.resolve(false);
    return api.chatWindow
      .dockTab({
        id: detachedId(scope, key),
        ...(opts?.transferId ? { transferId: opts.transferId } : {}),
        ...(opts?.requireAck !== undefined ? { requireAck: opts.requireAck } : {}),
      })
      .catch(() => false);
  },
  /** 主窗口确认已收下放回标签与交接快照 */
  dockAck(id: string, transferId: string, ok: boolean): Promise<boolean> {
    if (!hasTransport()) return Promise.resolve(false);
    return api.chatWindow.dockAck({ id, transferId, ok }).catch(() => false);
  },
  /** 只在界面内存里的标签（侧边聊天）：把快照放到宿主内存里，等另一个窗口取走 */
  async put(
    id: string,
    data: string,
    opts?: { transferId?: string; direction?: HandoffDirection; keepUntilAck?: boolean },
  ): Promise<boolean> {
    if (!hasTransport()) return false;
    try {
      return !!(await api.chatWindow.handoffPut({
        id,
        data,
        ...(opts?.transferId ? { transferId: opts.transferId } : {}),
        ...(opts?.direction ? { direction: opts.direction } : {}),
        ...(opts?.keepUntilAck !== undefined ? { keepUntilAck: opts.keepUntilAck } : {}),
      }));
    } catch (error) {
      log.warn('交接内容失败', error);
      return false;
    }
  },
  /** 取走交接的快照（没有时 null） */
  async take(
    id: string,
    opts?: { transferId?: string; direction?: HandoffDirection },
  ): Promise<string | null> {
    if (!hasTransport()) return null;
    try {
      return (
        (await api.chatWindow.handoffTake({
          id,
          ...(opts?.transferId ? { transferId: opts.transferId } : {}),
          ...(opts?.direction ? { direction: opts.direction } : {}),
        })) ?? null
      );
    } catch (error) {
      log.warn('取交接内容失败', error);
      return null;
    }
  },
  /** 主窗口：收到宿主点名发来的放回接收请求 */
  onDockRequest(fn: (req: { id: string; transferId: string }) => void): () => void {
    if (!hasTransport()) return () => undefined;
    return api.on('chatWindow.dockRequest', (e) => fn(e));
  },
  /** 主窗口：「放回主窗口」后切到那个标签 */
  onDocked(fn: (id: string) => void): () => void {
    if (!hasTransport()) return () => undefined;
    return api.on('chatWindow.tabDocked', (e) => fn(e.id));
  },
};

/** 开着的弹出窗口 id（宿主推送的整份列表）；弹出窗口自身传 enabled=false 不订阅 */
export function useDetachedIds(enabled = true): readonly string[] {
  const [ids, setIds] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!enabled || !hasTransport()) return;
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
  }, [enabled]);
  return enabled ? ids : [];
}
