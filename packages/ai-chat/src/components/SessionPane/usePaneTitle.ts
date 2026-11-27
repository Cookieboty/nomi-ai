/**
 * 会话面板标题要显示的 `项目名 / 会话名`（对齐截图）。
 *
 * 从面板绑定的会话键取，不看「当前会话」：Nomi 会话读 ConversationStore 的元信息，
 * CLI 标签读标签标题；项目名优先用会话的项目，没有项目时用标签工作目录的末段。
 */
import { t, useLocale } from '@nomi-ai/ui';
import { useEffect, useState } from 'react';

import {
  CONVERSATIONS_CHANGED_EVENT,
  type ConversationStore,
} from '../../services/conversationStore';
import { projectById, useProjects } from '../../services/projects';
import type { ConversationBackend } from '../../types/chat';
import { parseSessionKey } from '../../utils/sessionPanes';

export interface PaneTitleInfo {
  /** 会话名 */
  name: string;
  /** 项目名（没有时为空串） */
  project: string;
}

/** CLI 标签标题（面板标题用；只取显示需要的字段） */
export interface PaneTabInfo {
  title: string;
  backend: ConversationBackend;
  projectId?: string;
  cwd?: string;
}

export const EMPTY_PANE_TITLE: PaneTitleInfo = { name: '', project: '' };

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

/**
 * 纯函数：会话键 → 标题。
 * - nomi:<id>：会话元信息里的名字与项目；
 * - cli:<backend>:<会话 id>：按 CLI 会话 id 在会话列表里找它的镜像项，名字 / 项目以它为准，
 *   找不到时用标签标题与标签的项目 / 目录。
 */
export function paneTitleOf(
  sessionKey: string | null,
  store: Pick<ConversationStore, 'get' | 'findByCliSessionId'> | undefined,
  tab: PaneTabInfo | undefined,
): PaneTitleInfo {
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return EMPTY_PANE_TITLE;
  const meta =
    parsed.kind === 'nomi'
      ? store?.get(parsed.id)
      : parsed.kind === 'cli'
        ? store?.findByCliSessionId(parsed.backend as ConversationBackend, parsed.sessionId)
        : undefined;
  const raw = meta?.name ?? tab?.title ?? '';
  const name = raw ? t(raw) : t('ui.chat-settings.new-chat');
  const projectId = meta?.projectId ?? tab?.projectId;
  const project = projectId ? (projectById(projectId)?.name ?? '') : baseName(tab?.cwd ?? '');
  return { name, project };
}

/** 会话列表 / 项目改名后刷新标题 */
export function usePaneTitle(
  sessionKey: string | null,
  store: Pick<ConversationStore, 'get' | 'findByCliSessionId'> | undefined,
  tab: PaneTabInfo | undefined,
): PaneTitleInfo {
  useLocale();
  useProjects();
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, on);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, on);
  }, []);
  return paneTitleOf(sessionKey, store, tab);
}
