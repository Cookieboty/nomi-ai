/**
 * 对话标签栏：每个标签绑定一个后端 + 会话 + 工作目录，可并发运行。
 * 状态点：灰 = 空闲 · 蓝（脉动）= 运行中 · 黄 = 排队 · 红 = 出错 · 绿 = 有未读结果。
 */
import { t, Icon } from '@nomi-ai/ui';
import { X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useNewWorkspace } from '../../hooks/useNewWorkspace';
import {
  MAIN_TAB_ID,
  harnessClient,
  type HarnessBackend,
  type HarnessTabMeta,
} from '../../services/harnessClient';
import { formatCombo, useShortcutBindings } from '../../services/shortcuts';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { ConversationMenu } from '../ConversationMenu';
import { EndpointIcon } from '../EndpointIcon';
import { NewChatMenu } from '../NewChatMenu';

import styles from './index.module.css';

const KIND_LABEL = ENDPOINT_NAME;

const CLI_BACKENDS: HarnessBackend[] = ['claude', 'codex', 'dsh', 'grok', 'gemini'];

/** 标签悬停提示：标题 · 端点 · 状态，其后依次是工作目录、会话、最近错误 */
function tabTooltip(tab: HarnessTabMeta, status: string): string {
  return [
    [tab.title, KIND_LABEL[tab.backend], status].join(' · '),
    tab.cwd,
    tab.cliSessionId ? t('会话 {0}', tab.cliSessionId.slice(0, 18)) : '',
    tab.lastError ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function tabDotStatus(tab: HarnessTabMeta, mainLoading = false): string {
  if (tab.id === MAIN_TAB_ID && mainLoading) return 'running';
  if (tab.status !== 'idle') return tab.status;
  if (tab.unread > 0) return 'unread';
  if (tab.background) return 'background';
  return tab.dormant ? 'dormant' : 'idle';
}

function statusLabel(s: string): string {
  return s === 'running'
    ? t('运行中')
    : s === 'queued'
      ? t('排队中')
      : s === 'error'
        ? t('出错')
        : s === 'unread'
          ? t('有新结果')
          : s === 'dormant'
            ? t('已休眠')
            : s === 'background'
              ? t('后台运行中')
              : t('空闲');
}

export const ChatTabs: React.FC<{
  renameRequest?: number;
  newTabRequest?: number;
  /** 主对话（Nomi）正在回复 */
  mainLoading?: boolean;
  /** 右键菜单里的分叉（tabId → 由上层映射到对话） */
  onForkTab?: (tabId: string, mode: 'same' | 'cross') => void;
}> = ({ renameRequest = 0, newTabRequest = 0, mainLoading = false, onForkTab }) => {
  const tabs = useHarnessTabs();
  const bindings = useShortcutBindings();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(false);
  const [ctx, setCtx] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [bins, setBins] = useState<Record<string, string | null>>({});
  const ws = useNewWorkspace();
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const st = tabs.state;
  const activeId = st?.activeTabId ?? MAIN_TAB_ID;

  useEffect(() => {
    if (!menu) return;
    void harnessClient
      .state()
      .then((s) => setBins(s.bins))
      .catch(() => undefined);
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // 快捷键触发：重命名当前标签 / 打开新建菜单（渲染期根据 request 计数变化触发，避免 effect 内 setState 触发级联渲染）
  const [prevRenameRequest, setPrevRenameRequest] = useState(renameRequest);
  if (prevRenameRequest !== renameRequest) {
    setPrevRenameRequest(renameRequest);
    if (renameRequest && tabs.activeTab) {
      setEditing(tabs.activeTab.id);
      setDraft(tabs.activeTab.title);
    }
  }
  const [prevNewTabRequest, setPrevNewTabRequest] = useState(newTabRequest);
  if (prevNewTabRequest !== newTabRequest) {
    setPrevNewTabRequest(newTabRequest);
    if (newTabRequest) setMenu(true);
  }

  // 当前标签滚动到可见
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  if (!tabs.available || !st) return null;

  const closeTab = (tab: { id: string; status: string }) => {
    if (
      (tab.status === 'running' || tab.status === 'queued') &&
      !window.confirm(t('该标签仍在运行，关闭会中止它。确定关闭？'))
    )
      return;
    void tabs.close(tab.id);
  };

  const commitRename = () => {
    const id = editing;
    setEditing(null);
    const title = draft.trim();
    if (id && title) void tabs.rename(id, title).catch(() => undefined);
  };

  return (
    <div className={styles.bar} data-testid="chat-tabs">
      <div
        className={styles.strip}
        ref={stripRef}
        role="tablist"
        aria-label={t('对话标签')}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') tabs.cycle(1);
          else if (e.key === 'ArrowLeft') tabs.cycle(-1);
          else return;
          e.preventDefault();
        }}
      >
        {st.tabs.map((tab, i) => {
          const dot = tabDotStatus(tab, mainLoading);
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              data-testid={`chat-tab-${i}`}
              data-tab-id={tab.id}
              data-status={dot}
              className={`${styles.tab} ${active ? styles.active : ''}`}
              title={tabTooltip(tab, statusLabel(dot))}
              onClick={() => !active && void tabs.activate(tab.id)}
              onDoubleClick={() => {
                setEditing(tab.id);
                setDraft(tab.title);
              }}
              onContextMenu={(e) => {
                if (tab.id === MAIN_TAB_ID) return;
                e.preventDefault();
                setCtx({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && tab.id !== MAIN_TAB_ID) void tabs.close(tab.id);
              }}
            >
              <span className={styles.dot} data-status={dot} aria-label={statusLabel(dot)} />
              <EndpointIcon backend={tab.backend} size={14} />
              {editing === tab.id ? (
                <input
                  className={styles.rename}
                  data-testid="chat-tab-rename"
                  value={draft}
                  autoFocus
                  maxLength={60}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <span className={styles.title}>{tab.title}</span>
              )}
              {tab.unread > 0 && !active && (
                <span className={styles.badge} data-testid="chat-tab-unread">
                  {tab.unread > 9 ? '9+' : tab.unread}
                </span>
              )}
              {tab.id !== MAIN_TAB_ID && (
                <button
                  type="button"
                  className={styles.close}
                  data-testid={`chat-tab-close-${i}`}
                  aria-label={t('关闭标签 {0}', tab.title)}
                  title={`${t('关闭标签')} (${formatCombo(bindings.closeTab)})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab);
                  }}
                >
                  <Icon icon={X} size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {ctx &&
        (() => {
          const tab = st.tabs.find((x) => x.id === ctx.tabId);
          if (!tab) return null;
          return (
            <ConversationMenu
              x={ctx.x}
              y={ctx.y}
              isTab
              onDismiss={() => setCtx(null)}
              onRename={() => {
                setEditing(tab.id);
                setDraft(tab.title);
              }}
              onFork={() => onForkTab?.(tab.id, 'same')}
              onForkCross={() => onForkTab?.(tab.id, 'cross')}
              onClose={() => closeTab(tab)}
            />
          );
        })()}
      <label
        className={styles.load}
        data-testid="chat-tabs-load"
        title={t('同时运行的编程助手标签上限（1–8）')}
      >
        <span>{t('运行 {0}/', st.running)}</span>
        <select
          className={styles.limitSelect}
          data-testid="chat-tabs-max-concurrent"
          aria-label={t('并发上限')}
          value={st.maxConcurrent}
          onChange={(e) => void tabs.setMaxConcurrent(Number(e.target.value))}
        >
          {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {st.queued ? <span>{t(' · 排队 {0}', st.queued)}</span> : null}
      </label>
      <div className={styles.add} ref={menuRef}>
        <button
          type="button"
          className={styles.addBtn}
          data-testid="chat-tab-add"
          aria-haspopup="menu"
          aria-expanded={menu}
          title={`${t('新建编程助手标签')} (${formatCombo(bindings.newTab)})`}
          onClick={() => setMenu((v) => !v)}
        >
          +
        </button>
        {menu && (
          <NewChatMenu
            className={styles.menu}
            backends={CLI_BACKENDS}
            bins={bins}
            lastBackend={tabs.lastBackend}
            workspace={ws}
            testId="chat-tab-menu"
            itemTestId={(b) => `chat-tab-new-${b}`}
            workspaceTestId="new-tab-workspace"
            onPick={(b) => {
              setMenu(false);
              void tabs.create(b, ws.chosen).catch(() => undefined);
            }}
          />
        )}
      </div>
    </div>
  );
};

const CLI_LABEL: Record<string, string> = ENDPOINT_NAME;

/** CLI 标签的输入框提示：随运行状态与后端变化（不显示 Nomi 的「请先选择AI模型」） */
export function cliTabPlaceholder(tab: { title: string; backend: string; status: string }): string {
  const label = CLI_LABEL[tab.backend] ?? tab.backend;
  if (tab.status === 'running') return t('{0} 正在处理，完成后可继续发送…', label);
  if (tab.status === 'queued') return t('{0} 排队中，等待其它标签完成…', label);
  if (tab.title && tab.title !== label) return t('发给 {0}（{1}）…', tab.title, label);
  return t('发给 {0}…', label);
}
