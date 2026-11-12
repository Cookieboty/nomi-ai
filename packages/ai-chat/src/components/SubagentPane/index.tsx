/**
 * 子任务面板：Nomi 委派出去的编程助手标签，在对话旁边打开（不弹窗），可以接着对话：
 * - 空闲时发送 = 接着这个子任务再做一轮，做完的结果会回到主对话（内核 delegate.completed 带 followUp）；
 * - 运行中发送 = 插话给它（steer）；不支持插话的编程助手先排队，这一轮结束后自动发；
 * - 停止 = 打断这一轮；之后还可以接着发。
 * 审批、沙箱授权、子代理进度都在这里处理，与编程助手标签一致；输入栏里可以换模型 / 思考深度（下一轮起生效）。
 */
import { Button, Icon, IconButton, t, Textarea } from '@nomi-ai/ui';
import { Square, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { SubagentPaneProvider, useSubagentPane } from '../../contexts/SubagentPaneContext';
import { harnessClient, type HarnessTabMessage } from '../../services/harnessClient';
import { replyPermissionRequest } from '../../services/permissionReply';
import { fromHarnessMessage, tabLiveToConv } from '../../utils/convAdapters';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { isImeComposing, shouldIgnoreEscape } from '../../utils/keyboard';
import { buildCliSlots } from '../Conversation/cliSlots';
import { ConversationView } from '../Conversation/index';
import { TabSandboxRequests } from '../Conversation/SandboxRequests';
import { EndpointIcon } from '../EndpointIcon';
import { ModelControls } from '../ModelControls';
import { SessionDetailsProvider } from '../SessionDetails';
import { CenterChangesHost, ChangesUiProvider } from '../SessionWorkspace';

import styles from './SubagentPane.module.css';

/** 标签消息：标签有更新（updatedAt）或一轮开始 / 结束时重新拉 */
function useTabMessages(tabId: string, updatedAt: number | undefined, running: boolean) {
  const [messages, setMessages] = useState<HarnessTabMessage[]>([]);
  useEffect(() => {
    let alive = true;
    void harnessClient
      .tabMessages(tabId)
      .then((m) => alive && setMessages(m))
      .catch(() => alive && setMessages([]));
    return () => {
      alive = false;
    };
  }, [tabId, updatedAt, running]);
  return messages;
}

/** 按标签挂载面板内容：换标签时输入法 / 消息等本地状态从头来，草稿与待发消息在 pane.queue 里按标签保存 */
export const SubagentPane: React.FC = () => {
  const pane = useSubagentPane();
  if (!pane?.tabId) return null;
  return <SubagentPaneBody key={pane.tabId} pane={pane} tabId={pane.tabId} />;
};

const SubagentPaneBody: React.FC<{
  pane: NonNullable<ReturnType<typeof useSubagentPane>>;
  tabId: string;
}> = ({ pane, tabId }) => {
  const tabs = useHarnessTabs();
  const tab = tabs.state?.tabs.find((x) => x.id === tabId) ?? null;
  const tl = useHarnessLive((l) => l[tabId]);
  const running = tab?.status === 'running' || tab?.status === 'queued';
  const messages = useTabMessages(tabId, tab?.updatedAt, running);
  const backend = tab?.backend ?? 'claude';
  const conv = useMemo(
    () => messages.map((m) => fromHarnessMessage(m, backend)),
    [messages, backend],
  );
  const live = useMemo(() => tabLiveToConv(tl), [tl]);
  const slots = useMemo(() => buildCliSlots({ cwd: tab?.cwd ?? null }), [tab?.cwd]);
  const queue = pane.queue;
  const view = useSyncExternalStore(
    queue.subscribe,
    () => queue.view(tabId),
    () => queue.view(tabId),
  );
  const { draft, queued, error } = view;
  const [composing, setComposing] = useState(false);
  const close = pane.closeSubagent;

  // 标签没了（关掉 / 清理）：面板跟着关
  useEffect(() => {
    if (tabs.state && !tab) close();
  }, [tab, tabs.state, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || shouldIgnoreEscape(e)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const taskId = tab?.delegation?.taskId;
  const onPermission = useCallback(
    (id: string, allow: boolean, opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' }) => {
      if (!tabId) return;
      // 后台委派是持续任务：先经任务回应；任务已结束时退回直接回标签（否则按钮成死键）
      void replyPermissionRequest(tabId, id, allow, {
        ...(opts?.approvePlan ? { approvePlan: opts.approvePlan } : {}),
        ...(taskId ? { taskId } : {}),
      }).catch(() => false);
    },
    [tabId, taskId],
  );

  const sandboxRequests = useMemo(() => <TabSandboxRequests tabId={tabId} />, [tabId]);

  if (!tab) return null;
  const name = t(ENDPOINT_NAME[backend] ?? backend);
  const waiting = !!(tl?.permissions?.length || tab.sandboxPending?.length);

  // 空闲时发送、运行中先试插话、不支持就排队到这一轮结束：都按这个标签记账（见 subagentQueue）
  const submit = () => queue.submit(tabId);

  return (
    <section
      className={styles.pane}
      data-testid="subagent-pane"
      aria-label={t('ui.session-workspace.subagent-pane-title', name)}
    >
      <header className={styles.head}>
        <EndpointIcon backend={backend} size={16} decorative />
        <span className={styles.title}>{name}</span>
        <span
          className={styles.status}
          data-testid="subagent-status"
          data-state={waiting ? 'waiting' : running ? 'running' : 'idle'}
        >
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
            onClick={() => void harnessClient.cancelTab(tabId).catch(() => undefined)}
            data-testid="subagent-stop"
          >
            <Icon icon={Square} size={12} />
            {t('ui.foundation.stop')}
          </Button>
        )}
        <IconButton
          size="sm"
          label={t('ui.providers-schedule.close')}
          icon={<Icon icon={X} size={14} />}
          onClick={close}
          data-testid="subagent-close"
        />
      </header>
      {tab.delegation?.goal && (
        <p className={styles.goal} title={tab.delegation.goal}>
          {tab.delegation.goal}
        </p>
      )}
      <div className={styles.conv}>
        <ConversationView
          scopeId={`subagent:${tabId}`}
          messages={conv}
          live={live}
          phase={running ? 'running' : 'idle'}
          queued={queued}
          onRemoveQueued={(i) => queue.removeQueued(tabId, i)}
          onPermission={onPermission}
          slots={slots}
          sandboxRequests={sandboxRequests}
        />
      </div>
      <footer className={styles.composer}>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <Textarea
          value={draft}
          rows={2}
          placeholder={t('ui.session-workspace.subagent-input-placeholder', name)}
          aria-label={t('ui.session-workspace.subagent-input-placeholder', name)}
          onChange={(e) => queue.setDraft(tabId, e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composing && !isImeComposing(e.nativeEvent)) {
              e.preventDefault();
              void submit();
            }
          }}
          data-testid="subagent-input"
        />
        <div className={styles.composerRow}>
          {/* 子任务的模型 / 思考深度：与编程助手标签同一个按钮，下一轮起生效 */}
          {backend !== 'nomi' && <ModelControls key={`model-${backend}`} tab={tab} />}
          <span className={styles.hint}>
            {running
              ? t('ui.session-workspace.subagent-hint-running')
              : t('ui.session-workspace.subagent-hint-idle')}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={!draft.trim()}
            onClick={() => void submit()}
            data-testid="subagent-send"
          >
            {t('ui.knowledge-local.send')}
          </Button>
        </div>
      </footer>
    </section>
  );
};

export { useSubagentPane };

/** 对话旁的查看区、子任务面板、会话详情各自的状态（互不影响） */
export const WorkspacePanesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ChangesUiProvider>
    <SubagentPaneProvider>
      <SessionDetailsProvider>{children}</SessionDetailsProvider>
    </SubagentPaneProvider>
  </ChangesUiProvider>
);

/** 对话旁的那一栏：子任务面板开着时显示它，否则是变更 / 文件查看区 */
export const SideColumn: React.FC<{
  messages: React.ComponentProps<typeof CenterChangesHost>['messages'];
  cwd?: string | null;
  roots?: readonly string[] | null;
}> = ({ messages, cwd, roots }) =>
  useSubagentPane()?.tabId ? (
    <SubagentPane />
  ) : (
    // 本会话 Diff 在预览区的标签里（App 的 useResourcePreview），这一栏只给右栏的文件预览留挂载点
    <CenterChangesHost messages={messages} cwd={cwd} roots={roots} mode="slot" />
  );
