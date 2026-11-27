/**
 * 并排会话时每个面板各一份输入草稿。
 *
 * - 每个面板都按**它自己绑定的会话键**算键（nomi:<会话 id> / tab:<标签 id>），不按「当前会话」：
 *   并排时两个面板各写各的草稿桶，空会话（还没发过消息）也分开，输入不会串到另一个面板；
 * - 还没有会话 id 的空面板才退回 App 原来共用的那份（SHARED_UNSENT）。
 */
import { useMemo } from 'react';

import { draftKey, SHARED_UNSENT } from '../services/composerDrafts';
import { parseSessionKey } from '../utils/sessionPanes';

export interface PaneDraftDeps {
  /** 这个面板绑定的会话键 */
  sessionKey: string | null;
  /** CLI 标签还没有稳定会话键时用的标签 id */
  tabId: string | undefined;
}

/**
 * 会话键 → 输入草稿的桶（与 App 的单面板草稿同一套命名：nomi:<id> / tab:<id>）。
 * 两个不同会话永远不同，同一个会话切走再切回来还是同一份。
 */
export function draftKeyForPane(deps: PaneDraftDeps): string {
  const parsed = parseSessionKey(deps.sessionKey);
  // 按会话键分桶本身就是隔离，不再看「有没有发过消息」
  if (parsed?.kind === 'nomi')
    return draftKey({ kind: 'nomi', id: parsed.id, hasCommittedUserContent: true });
  if (parsed) {
    const tabId = parsed.kind === 'tab' ? parsed.id : (deps.tabId ?? parsed.sessionId);
    return draftKey({ kind: 'tab', id: tabId, hasCommittedUserContent: true });
  }
  return SHARED_UNSENT;
}

/** 面板的草稿键：会话键变了才换桶（只随这两个值重算，不随消息条数） */
export function usePaneDraftKey(deps: PaneDraftDeps): string {
  const { sessionKey, tabId } = deps;
  return useMemo(() => draftKeyForPane({ sessionKey, tabId }), [sessionKey, tabId]);
}
