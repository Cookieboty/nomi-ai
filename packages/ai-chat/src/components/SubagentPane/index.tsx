/**
 * 子任务导航条：委派出去的编程助手标签在主对话列里打开（同一套会话视图和输入栏）。
 * 这一条只负责回来源会话、状态和停止；消息、审批、提问、模型与权限都走当前标签的主对话。
 * 对话旁的那一栏仍是变更 / 文件，不再被另一套缩小的会话占住。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { ArrowLeft, Square } from 'lucide-react';
import React, { useEffect } from 'react';

import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { SubagentPaneProvider, useSubagentPane } from '../../contexts/SubagentPaneContext';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { shouldIgnoreEscape } from '../../utils/keyboard';
import { EndpointIcon } from '../EndpointIcon';
import { SessionDetailsProvider } from '../SessionDetails';
import { CenterChangesHost, ChangesUiProvider } from '../SessionWorkspace';

import styles from './SubagentPane.module.css';

export { useSubagentPane };

/** 主对话列顶部：从子任务回到打开它之前的会话 */
export const SubagentReturnBar: React.FC = () => {
  const pane = useSubagentPane();
  const tabId = pane?.tabId ?? null;
  const tabs = useHarnessTabs();
  const tab = tabId ? (tabs.state?.tabs.find((item) => item.id === tabId) ?? null) : null;
  const live = useHarnessLive((map) => (tabId ? map[tabId] : undefined));
  const close = pane?.closeSubagent;

  useEffect(() => {
    if (!tab || !close) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || shouldIgnoreEscape(e)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, close]);

  if (!pane || !tab || !close) return null;
  const name = t(ENDPOINT_NAME[tab.backend] ?? tab.backend);
  const running = tab.status === 'running' || tab.status === 'queued';
  const waiting = !!(live?.permissions?.length || tab.sandboxPending?.length);
  const state = waiting ? 'waiting' : running ? 'running' : 'idle';

  return (
    <section
      className={styles.bar}
      data-testid="subagent-return"
      aria-label={t('ui.session-workspace.subagent-pane-title', name)}
    >
      <div className={styles.row}>
        <Button size="sm" variant="ghost" onClick={close} data-testid="subagent-back">
          <Icon icon={ArrowLeft} size={14} />
          {t('ui.chat-settings.back-to-chat')}
        </Button>
        <EndpointIcon backend={tab.backend} size={16} decorative />
        <span className={styles.title}>{name}</span>
        <span className={styles.status} data-testid="subagent-status" data-state={state}>
          {waiting
            ? t('ui.session-workspace.needs-your-approval')
            : running
              ? t('ui.knowledge-local.running')
              : t('ui.mascot-theme.idle')}
        </span>
        <span className={styles.spacer} />
        {running && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void tabs.cancel()}
            data-testid="subagent-stop"
          >
            <Icon icon={Square} size={12} />
            {t('ui.foundation.stop')}
          </Button>
        )}
      </div>
      {tab.delegation?.goal && (
        <p className={styles.goal} title={tab.delegation.goal}>
          {tab.delegation.goal}
        </p>
      )}
      <p className={styles.hint}>
        {running
          ? t('ui.session-workspace.subagent-hint-running')
          : t('ui.session-workspace.subagent-hint-idle')}
      </p>
    </section>
  );
};

/** 对话旁的查看区、子任务导航、会话详情各自的状态（互不影响） */
export const WorkspacePanesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ChangesUiProvider>
    <SubagentPaneProvider>
      <SessionDetailsProvider>{children}</SessionDetailsProvider>
    </SubagentPaneProvider>
  </ChangesUiProvider>
);

/** 对话旁的那一栏：右栏的文件预览挂在这里。子任务会话在主对话列，不占这一栏。 */
export const SideColumn: React.FC<{
  messages: React.ComponentProps<typeof CenterChangesHost>['messages'];
  cwd?: string | null;
  roots?: readonly string[] | null;
}> = ({ messages, cwd, roots }) => (
  <CenterChangesHost messages={messages} cwd={cwd} roots={roots} mode="slot" />
);
