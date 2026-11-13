/**
 * 子任务侧栏：主列留在来源对话，这里用同一套会话视图看子任务。
 * harness 标签（委派的编程助手）走 CliConversation + MessageInput，模型、权限、队列、提问都按标签 id 绑定。
 * 进程内子代理和后台 Nomi 没有独立输入通道，步骤仍用 ConversationView，能停止的给停止，不能追问的说明原因。
 */
import { Button, Icon, IconButton, t } from '@nomi-ai/ui';
import { Square, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import {
  useHarnessLive,
  useHarnessTabMessages,
  useHarnessTabs,
  useHarnessTabsCore,
} from '../../contexts/HarnessTabsContext';
import {
  SubagentPaneProvider,
  useSubagentPane,
  type SubagentTarget,
} from '../../contexts/SubagentPaneContext';
import { useTranscriptView } from '../../hooks/useTranscriptView';
import { toHarnessImages } from '../../services/chatImages';
import {
  createComposerDraftStore,
  draftKey,
  sessionHasCommittedUserContent,
} from '../../services/composerDrafts';
import { harnessClient, type HarnessTabMeta } from '../../services/harnessClient';
import { tasksApi } from '../../services/tasksClient';
import { cliTranscriptKey } from '../../services/transcriptView';
import { useSlashCommands } from '../../slash/useSlashCommands';
import type { ConvMessage } from '../../types/conversation';
import { useCliImageSupport } from '../../utils/cliImageSupport';
import { cliTabPlaceholder } from '../../utils/cliTabPlaceholder';
import { fromHarnessMessage } from '../../utils/convAdapters';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { shouldIgnoreEscape } from '../../utils/keyboard';
import { CliConversation } from '../Conversation/CliConversation';
import { buildCliSlots } from '../Conversation/cliSlots';
import { ConversationView } from '../Conversation/index';
import { MessageInput } from '../MessageInput';
import { PendingDock } from '../PendingDock';
import { SessionDetailsProvider } from '../SessionDetails';
import { CenterChangesHost, ChangesUiProvider } from '../SessionWorkspace';
import { UserQuestionDock } from '../UserQuestionCard/dock';

import { nestedMessages, nomiTaskMessages, type TaskTraceLine } from './project';
import styles from './SubagentPane.module.css';

export { useSubagentPane };

const usePaneEscape = (open: boolean, close: () => void) => {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || shouldIgnoreEscape(e)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
};

const PaneHead: React.FC<{
  name: string;
  state: 'running' | 'waiting' | 'idle';
  goal?: string;
  onClose: () => void;
  onStop?: () => void;
}> = ({ name, state, goal, onClose, onStop }) => (
  <>
    <header className={styles.head}>
      <span className={styles.title}>{name}</span>
      <span className={styles.status} data-testid="subagent-status" data-state={state}>
        {state === 'waiting'
          ? t('ui.session-workspace.needs-your-approval')
          : state === 'running'
            ? t('ui.knowledge-local.running')
            : t('ui.mascot-theme.idle')}
      </span>
      <span className={styles.spacer} />
      {onStop && state === 'running' && (
        <Button size="sm" variant="ghost" onClick={onStop} data-testid="subagent-stop">
          <Icon icon={Square} size={12} />
          {t('ui.foundation.stop')}
        </Button>
      )}
      <IconButton
        size="sm"
        label={t('ui.providers-schedule.close')}
        icon={<Icon icon={X} size={14} />}
        onClick={onClose}
        data-testid="subagent-close"
      />
    </header>
    {goal && (
      <p className={styles.goal} title={goal}>
        {goal}
      </p>
    )}
  </>
);

/** 委派的编程助手：和主列同一个 CliConversation / MessageInput，只是绑在这个标签上 */
const HarnessChat: React.FC<{ tab: HarnessTabMeta; onClose: () => void }> = ({ tab, onClose }) => {
  const core = useHarnessTabsCore();
  const raw = useHarnessTabMessages(tab.id);
  const backend = tab.backend;
  const messages = useMemo(() => raw.map((m) => fromHarnessMessage(m, backend)), [raw, backend]);
  const { view: transcriptView } = useTranscriptView(cliTranscriptKey(tab));
  const images = useCliImageSupport(tab);
  const running = tab.status === 'running' || tab.status === 'queued';
  const live = useHarnessLive((map) => map[tab.id]);
  const waiting = !!(live?.permissions?.length || tab.sandboxPending?.length);
  const slots = useMemo(() => buildCliSlots({ cwd: tab.cwd }), [tab.cwd]);
  const [draftStore] = useState(createComposerDraftStore);
  const [fill, setFill] = useState<{ text: string; nonce: number } | null>(null);
  const pending = core.queues[tab.id] ?? [];
  const slash = useSlashCommands({
    backend: tab.backend === 'nomi' ? 'claude' : tab.backend,
    cwd: tab.cwd,
    scopeKey: tab.id,
    messages,
    session: {
      id: tab.cliSessionId,
      running,
    },
    tabId: tab.id,
    send: (text) => void core.sendToTab(tab.id, text, undefined, undefined, 'queue'),
    sendTo: (target, text) =>
      target.tabId
        ? core.sendToTab(
            target.tabId,
            text,
            { backend: target.backend, cwd: target.cwd },
            undefined,
            'queue',
          )
        : false,
    tabExists: core.hasTab,
    newSession: () => undefined,
    onOpenPlugins: () => undefined,
    onOpenProviders: () => undefined,
    onOpenSettings: () => undefined,
  });
  const name = t(ENDPOINT_NAME[tab.backend] ?? tab.backend);
  usePaneEscape(true, onClose);
  return (
    <section
      className={styles.pane}
      data-testid="subagent-pane"
      aria-label={t('ui.session-workspace.subagent-pane-title', name)}
    >
      <PaneHead
        name={name}
        state={waiting ? 'waiting' : running ? 'running' : 'idle'}
        goal={tab.delegation?.goal}
        onClose={onClose}
        onStop={() => void core.cancelRun(tab.id)}
      />
      <p className={styles.hint}>
        {running
          ? t('ui.session-workspace.subagent-hint-running')
          : t('ui.session-workspace.subagent-hint-idle')}
      </p>
      <div className={styles.conv}>
        <CliConversation
          scopeId={tab.id}
          messages={messages}
          transcriptView={transcriptView}
          phase={running ? 'running' : 'idle'}
          slots={slots}
          cards={slash.cards}
          onDismissCard={slash.dismissCard}
          dormant={tab.dormant}
          backgroundAgents={tab.backgroundAgents}
          backgroundCount={tab.background}
        />
      </div>
      <footer className={styles.composer}>
        <UserQuestionDock tabId={tab.id} />
        <PendingDock
          items={pending}
          onRemove={(id) => core.removePendingFrom(tab.id, id)}
          onWithdraw={(item) => {
            core.removePendingFrom(tab.id, item.id);
            setFill((prev) => ({ text: item.text, nonce: (prev?.nonce ?? 0) + 1 }));
          }}
        />
        <MessageInput
          onSend={(text, imgs) => {
            void (async () => {
              const images = imgs?.length ? await toHarnessImages(imgs) : undefined;
              await core.sendToTab(tab.id, text, undefined, images);
            })();
          }}
          busyOverride={running}
          imageCapability={images.capability}
          imageUnsupportedReason={images.reason}
          placeholder={cliTabPlaceholder(tab)}
          queue={{
            onQueue: (text, opts) =>
              void core.sendToTab(tab.id, text, undefined, undefined, opts?.mode),
            onStop: () => void core.cancelRun(tab.id),
            pending: pending.length,
            onFlush: () => void core.flushPendingFor(tab.id),
          }}
          cwd={tab.cwd}
          endpointTab={tab}
          contextMessages={messages}
          contextModel={tab.modelOverride ?? tab.backend}
          slash={slash.bridge}
          fill={fill}
          draftStore={draftStore}
          draftKey={draftKey({
            kind: 'tab',
            id: tab.id,
            hasCommittedUserContent: sessionHasCommittedUserContent(
              raw.length,
              tab.carriedMessages ?? 0,
            ),
          })}
          delegate={false}
        />
      </footer>
    </section>
  );
};

const NestedChat: React.FC<{
  callId: string;
  parentTabId: string | null;
  columnMessages: readonly ConvMessage[];
  onClose: () => void;
}> = ({ callId, parentTabId, columnMessages, onClose }) => {
  const tabs = useHarnessTabs();
  const parent = parentTabId ? tabs.state?.tabs.find((t) => t.id === parentTabId) : undefined;
  const raw = useHarnessTabMessages(parentTabId);
  const parentMessages = useMemo(
    () => (parent ? raw.map((m) => fromHarnessMessage(m, parent.backend)) : columnMessages),
    [parent, raw, columnMessages],
  );
  const live = useHarnessLive((map) => (parentTabId ? map[parentTabId] : undefined));
  const messages = useMemo(
    () => nestedMessages(parentMessages, callId, live?.trace),
    [parentMessages, callId, live?.trace],
  );
  const agent = Object.values(live?.agents ?? {}).find(
    (a) => a.callId === callId || a.id === callId,
  );
  const running = agent?.status === 'running';
  usePaneEscape(true, onClose);
  const name = agent?.label || agent?.agentType || t('ui.usage-tools.subagent');
  return (
    <section className={styles.pane} data-testid="subagent-pane" aria-label={name}>
      <PaneHead
        name={name}
        state={running ? 'running' : 'idle'}
        goal={agent?.progress}
        onClose={onClose}
        onStop={
          parentTabId && agent
            ? () => void harnessClient.stopAgent(parentTabId, agent.id).catch(() => undefined)
            : undefined
        }
      />
      <p className={styles.hint}>{t('ui.session-workspace.subagent-nested-hint')}</p>
      <div className={styles.conv}>
        <ConversationView
          scopeId={`nested:${callId}`}
          messages={messages}
          live={null}
          phase={running ? 'running' : 'idle'}
        />
      </div>
    </section>
  );
};

const NomiTaskChat: React.FC<{ taskId: string; onClose: () => void }> = ({ taskId, onClose }) => {
  const [goal, setGoal] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [lines, setLines] = React.useState<TaskTraceLine[]>([]);
  React.useEffect(() => {
    let alive = true;
    const load = () => {
      void tasksApi
        .get(taskId)
        .then((rec) => {
          if (!alive || !rec) return;
          setGoal(rec.task.goal);
          setTitle(rec.task.title);
          const status = rec.task.status;
          setRunning(status === 'running' || status === 'queued' || status === 'waiting_user');
        })
        .catch(() => undefined);
      void tasksApi
        .trace(taskId)
        .then((view) => {
          if (alive) setLines(view.lines);
        })
        .catch(() => undefined);
    };
    load();
    const off = tasksApi.onChange(load);
    const timer = window.setInterval(load, 1500);
    return () => {
      alive = false;
      off();
      window.clearInterval(timer);
    };
  }, [taskId]);
  const messages = useMemo(() => nomiTaskMessages(goal, lines), [goal, lines]);
  usePaneEscape(true, onClose);
  const name = title || t('ui.usage-tools.subagent');
  return (
    <section
      className={styles.pane}
      data-testid="subagent-pane"
      aria-label={t('ui.session-workspace.subagent-pane-title', name)}
    >
      <PaneHead
        name={name}
        state={running ? 'running' : 'idle'}
        goal={goal}
        onClose={onClose}
        onStop={running ? () => void tasksApi.cancel(taskId).catch(() => undefined) : undefined}
      />
      <p className={styles.hint}>{t('ui.session-workspace.subagent-nomi-hint')}</p>
      <div className={styles.conv}>
        <ConversationView
          scopeId={`nomi-task:${taskId}`}
          messages={messages}
          live={null}
          phase={running ? 'running' : 'idle'}
        />
      </div>
    </section>
  );
};

const PaneBody: React.FC<{
  target: SubagentTarget;
  columnMessages: readonly ConvMessage[];
  onClose: () => void;
}> = ({ target, columnMessages, onClose }) => {
  const tabs = useHarnessTabs();
  if (target.kind === 'harness') {
    const tab = tabs.state?.tabs.find((item) => item.id === target.tabId);
    if (!tab) return null;
    return <HarnessChat key={tab.id} tab={tab} onClose={onClose} />;
  }
  if (target.kind === 'nested') {
    return (
      <NestedChat
        key={target.callId}
        callId={target.callId}
        parentTabId={target.parentTabId}
        columnMessages={columnMessages}
        onClose={onClose}
      />
    );
  }
  return <NomiTaskChat key={target.taskId} taskId={target.taskId} onClose={onClose} />;
};

export const SubagentPane: React.FC<{ columnMessages: readonly ConvMessage[] }> = ({
  columnMessages,
}) => {
  const pane = useSubagentPane();
  if (!pane?.target) return null;
  return (
    <PaneBody target={pane.target} columnMessages={columnMessages} onClose={pane.closeSubagent} />
  );
};

/** 对话旁的查看区、子任务侧栏、会话详情各自的状态（互不影响） */
export const WorkspacePanesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ChangesUiProvider>
    <SubagentPaneProvider>
      <SessionDetailsProvider>{children}</SessionDetailsProvider>
    </SubagentPaneProvider>
  </ChangesUiProvider>
);

/** 对话旁的那一栏：子任务开着时显示它，否则是变更 / 文件查看区 */
export const SideColumn: React.FC<{
  messages: readonly ConvMessage[];
  cwd?: string | null;
  roots?: readonly string[] | null;
}> = ({ messages, cwd, roots }) =>
  useSubagentPane()?.target ? (
    <SubagentPane columnMessages={messages} />
  ) : (
    <CenterChangesHost messages={messages} cwd={cwd} roots={roots} mode="slot" />
  );
