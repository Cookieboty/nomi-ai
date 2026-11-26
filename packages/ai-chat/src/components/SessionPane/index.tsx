/**
 * 主区里的一个会话面板（并排会话拆出来的左右两半，对齐 Cursor 的会话并排）。
 *
 * - 面板头：`项目名 / 会话名` + 「拆分 / 取消拆分」「关闭面板」两个图标按钮（只有图标，可访问名走 aria-label）；
 *   单面板时标题留给顶栏 / 对话头，这里不重复画；
 * - 内容：这个面板**绑定的会话**的对话区与输入框（由 App 传入，单面板时就是原来那一份：容器不变，
 *   转录视图、滚动位置、输入状态都不重挂）；
 * - 面板不读「当前会话」的消息：另一边聚焦与否都不影响这里显示什么；
 * - 文件区（SideWorkspace）不在这里：它是 App 里唯一的一份，从任一面板打开的文件都覆盖到那一份。
 */
import { Icon, IconButton, t, useLocale } from '@nomi-ai/ui';
import { IconColumns2 as Columns2, IconFolder, IconX as X } from '@tabler/icons-react';
import React from 'react';

import { selectIpcClient, useAiChatSelector } from '../../contexts/aiChatStore';
import { useSessionPanes } from '../../contexts/SessionPanesContext';
import type { ConversationStore } from '../../services/conversationStore';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { IPCClient } from '../../types/ipc';

import styles from './index.module.css';
import { EMPTY_PANE_TITLE, usePaneTitle, type PaneTabInfo } from './usePaneTitle';

export { paneTitleOf, usePaneTitle, type PaneTabInfo, type PaneTitleInfo } from './usePaneTitle';

/** App 按面板的会话键查好的 CLI 标签（面板标题用；Nomi 会话为 undefined） */
export type PaneTabLookup = (sessionKey: string | null) => PaneTabInfo | undefined;

export const SessionPane: React.FC<{
  paneId: string;
  /** 面板顺序里的位置（0 = 左，1 = 右） */
  index: number;
  /** 显示面板头（拆分时是；单面板时标题在顶栏） */
  header: boolean;
  /** 面板绑定的会话键 → CLI 标签（标题用） */
  tabOf?: PaneTabLookup;
  children: React.ReactNode;
}> = ({ paneId, index, header, tabOf, children }) => {
  const panes = useSessionPanes();
  const focused = panes ? panes.focusedPaneId === paneId : index === 0;
  const split = !!panes?.isSplit;
  return (
    <section
      className={styles.pane}
      data-testid="session-pane"
      data-pane={paneId}
      data-pane-index={index}
      data-focused={focused ? 'true' : undefined}
      data-split={split ? 'true' : undefined}
      aria-label={t('ui.session-panes.label')}
      // 在非焦点面板里按下鼠标（输入框、消息、空白）：把它切成焦点，「当前会话」、发送目标与文件区都跟着它。
      // 焦点面板上的点击不清除文本选区（含输入框里的选区）。
      onMouseDownCapture={
        focused
          ? undefined
          : (e) => {
              panes?.focusPane(paneId);
              const target = e.target as HTMLElement | null;
              if (target?.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
            }
      }
    >
      {header && <SessionPaneHeader paneId={paneId} tabOf={tabOf} />}
      <div className={styles.body}>{children}</div>
    </section>
  );
};

/** 面板头：项目 / 会话名 + 拆分与关闭 */
const SessionPaneHeader: React.FC<{ paneId: string; tabOf?: PaneTabLookup }> = ({
  paneId,
  tabOf,
}) => {
  useLocale();
  const panes = useSessionPanes();
  const split = !!panes?.isSplit;
  return (
    <header className={styles.header} data-testid="session-pane-header">
      <SessionPaneName paneId={paneId} tabOf={tabOf} />
      <div className={styles.actions}>
        {split ? (
          <IconButton
            size="sm"
            variant="ghost"
            label={t('ui.session-panes.merge')}
            icon={<Icon icon={Columns2} size={14} />}
            aria-pressed
            onClick={() => panes?.leaveSplit()}
            data-testid="session-pane-merge"
          />
        ) : (
          <IconButton
            size="sm"
            variant="ghost"
            label={t('ui.session-panes.split-right')}
            icon={<Icon icon={Columns2} size={14} />}
            aria-pressed={false}
            onClick={() => panes?.openToSide(null)}
            data-testid="session-pane-split"
          />
        )}
        {split && (
          <IconButton
            size="sm"
            variant="ghost"
            label={t('ui.session-panes.close-pane')}
            icon={<Icon icon={X} size={14} />}
            onClick={() => panes?.closePane(paneId)}
            data-testid="session-pane-close"
          />
        )}
      </div>
    </header>
  );
};

/**
 * 面板标题：`项目名 / 会话名`。会话名从面板绑定的会话键取（不看当前会话）；
 * 会话名里已经带项目名时不再重复（如「app / 周报整理」）。
 */
const SessionPaneName: React.FC<{ paneId: string; tabOf?: PaneTabLookup }> = ({
  paneId,
  tabOf,
}) => {
  const panes = useSessionPanes();
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const key = panes?.panes.find((p) => p.id === paneId)?.sessionKey ?? null;
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const title = usePaneTitle(key, store, tabOf?.(key));
  const info = key ? title : EMPTY_PANE_TITLE;
  const showProject = !!info.project && !info.name.startsWith(`${info.project} /`);
  return (
    <div className={styles.nameGroup}>
      {info.project && (
        <>
          <Icon icon={IconFolder} size={14} className={styles.folder} />
          <span className={styles.project} data-testid="session-pane-project">
            {info.project}
          </span>
          <span className={styles.sep} aria-hidden>
            /
          </span>
        </>
      )}
      <span
        className={styles.name}
        data-testid="session-pane-name"
        {...(showProject ? { title: `${info.project} / ${info.name}` } : {})}
      >
        {info.name || t('ui.session-panes.empty-title')}
      </span>
    </div>
  );
};

/** CLI 标签 → 面板标题需要的字段 */
export const paneTabOf = (tab: HarnessTabMeta | undefined): PaneTabInfo | undefined =>
  tab
    ? { title: tab.title, backend: tab.backend, projectId: tab.projectId, cwd: tab.cwd }
    : undefined;
