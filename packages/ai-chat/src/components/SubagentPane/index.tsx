/**
 * 子任务面板：Nomi 委派出去的编程助手标签，在对话旁边打开（不弹窗），可以接着对话：
 * - 空闲时发送 = 接着这个子任务再做一轮，做完的结果会回到主对话（内核 delegate.completed 带 followUp）；
 * - 运行中发送 = 插话给它（steer）；不支持插话的编程助手先排队，这一轮结束后自动发；
 * - 停止 = 打断这一轮；之后还可以接着发。
 * 审批、沙箱授权、子代理进度都在这里处理，与编程助手标签一致；输入栏里可以换模型 / 思考深度（下一轮起生效）。
 */
import { Button, Icon, IconButton, t, Textarea } from '@nomi-ai/ui';
import { Square, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { SubagentPaneProvider, useSubagentPane } from '../../contexts/SubagentPaneContext';
import { api } from '../../services/api';
import { harnessClient, type HarnessTabMessage } from '../../services/harnessClient';
import { fromHarnessMessage, tabLiveToConv } from '../../utils/convAdapters';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { shouldIgnoreEscape } from '../../utils/keyboard';
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

export const SubagentPane: React.FC = () => {
  const pane = useSubagentPane();
  const tabs = useHarnessTabs();
  const tabId = pane?.tabId ?? '';
  const tab = tabs.state?.tabs.find((x) => x.id === tabId) ?? null;
  const tl = useHarnessLive((l) => (tabId ? l[tabId] : undefined));
  const running = tab?.status === 'running' || tab?.status === 'queued';
  const messages = useTabMessages(tabId, tab?.updatedAt, running);
  const backend = tab?.backend ?? 'claude';
  const conv = useMemo(
    () => messages.map((m) => fromHarnessMessage(m, backend)),
    [messages, backend],
  );
  const live = useMemo(() => tabLiveToConv(tl), [tl]);
  const slots = useMemo(() => buildCliSlots({ cwd: tab?.cwd ?? null }), [tab?.cwd]);
  const [draft, setDraft] = useState('');
  const [queued, setQueued] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const close = pane?.closeSubagent;

  // 标签没了（关掉 / 清理）：面板跟着关
  useEffect(() => {
    if (tabId && tabs.state && !tab) close?.();
  }, [tabId, tab, tabs.state, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || shouldIgnoreEscape(e)) return;
      e.preventDefault();
      close?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const sendNow = useCallback(
    (text: string) => {
      setError(null);
      void harnessClient
        .sendTab(tabId, text)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    },
    [tabId],
  );

  // 排队的消息：这一轮结束后按顺序发
  useEffect(() => {
    if (running || !queued.length) return;
    const [head, ...rest] = queued;
    // 外部状态（这一轮结束）驱动的发送：豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueued(rest);
    sendNow(head!);
  }, [running, queued, sendNow]);

  const onPermission = useCallback(
    (id: string, allow: boolean, opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' }) => {
      // 后台委派是持续任务：审批经任务回应
      const taskId = tab?.delegation?.taskId;
      const done =
        taskId && !opts?.approvePlan
          ? api.tasks.decide({ id: taskId, requestId: id, approve: allow })
          : harnessClient.replyPermission(tabId, id, allow, opts);
      void Promise.resolve(done).catch(() => undefined);
    },
    [tabId, tab?.delegation?.taskId],
  );

  const sandboxRequests = useMemo(() => <TabSandboxRequests tabId={tabId} />, [tabId]);

  if (!pane?.tabId || !tab) return null;
  const name = t(ENDPOINT_NAME[backend] ?? backend);
  const waiting = !!(tl?.permissions?.length || tab.sandboxPending?.length);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (!running) return sendNow(text);
    // 运行中：先试插话，不支持就排队到这一轮结束
    const ok = await harnessClient.steerTab(tabId, text);
    if (!ok) setQueued((q) => [...q, text]);
  };

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
          onRemoveQueued={(i) => setQueued((q) => q.filter((_, k) => k !== i))}
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
          onChange={(e) => setDraft(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composing && !e.nativeEvent.isComposing) {
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
}> = ({ messages, cwd }) =>
  useSubagentPane()?.tabId ? <SubagentPane /> : <CenterChangesHost messages={messages} cwd={cwd} />;
