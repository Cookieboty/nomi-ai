/**
 * 子任务侧栏：主列留在来源对话，这里用同一套会话视图看子任务。
 * harness 标签（委派的编程助手）走 CliConversation + MessageInput，模型、权限、队列、提问都按标签 id 绑定。
 * 进程内子代理（Task / spawn_agent）和后台 Nomi（delegate_to_nomi）也用 ConversationView + MessageInput：
 * 步骤与正文实时更新；输入栏和主列一样能发送、插话、排队、停止（语义见 docs/design/subagent-chat-parity.md）。
 * 设置 / 插件 / 模型等按钮打开主窗口的面板（SubagentPaneActions，由 App 传入）。
 */
import { Button, Icon, IconButton, t } from '@nomi-ai/ui';
import { Square, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import {
  useHarnessDetached,
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
import {
  harnessClient,
  type HarnessImageInput,
  type HarnessTabMeta,
  type MessageAgentResult,
} from '../../services/harnessClient';
import { tasksApi, type TaskTraceView } from '../../services/tasksClient';
import { cliTranscriptKey } from '../../services/transcriptView';
import { useSlashCommands } from '../../slash/useSlashCommands';
import type { ConvLive, ConvMessage } from '../../types/conversation';
import { useCliImageSupport } from '../../utils/cliImageSupport';
import { cliTabPlaceholder } from '../../utils/cliTabPlaceholder';
import { fromHarnessMessage } from '../../utils/convAdapters';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { shouldIgnoreEscape } from '../../utils/keyboard';
import type { LiveAgent } from '../../utils/liveState';
import {
  mergePending,
  newPendingId,
  type PendingMode,
  type PendingSend,
} from '../../utils/pendingSends';
import { agentKey } from '../../utils/sideTabs';
import { CliConversation } from '../Conversation/CliConversation';
import { buildCliSlots } from '../Conversation/cliSlots';
import { ConversationView } from '../Conversation/index';
import { MessageInput } from '../MessageInput';
import { PendingDock } from '../PendingDock';
import { SessionDetailsProvider } from '../SessionDetails';
import { CenterChangesHost, ChangesUiProvider } from '../SessionWorkspace';
import type { SettingsSection } from '../SettingsView/sections';
import { UserQuestionDock } from '../UserQuestionCard/dock';

import {
  agentIdsOfCall,
  applyTaskLiveEvent,
  liveFromView,
  nestedMessages,
  nomiTaskMessages,
  type NomiTaskLive,
} from './project';
import styles from './SubagentPane.module.css';

export { useSubagentPane };

/**
 * 主窗口的面板入口：侧栏里的设置 / 插件 / 模型 / 扩展等按钮和斜杠命令打开的就是主窗口这一份
 * （和主列输入栏是同一组回调）。不传时这些按钮不显示。
 */
export interface SubagentPaneActions {
  openPlugins?: () => void;
  openProviders?: () => void;
  /** 打开统一设置页（输入栏的设置按钮） */
  openSettings?: (section?: SettingsSection, endpoint?: string) => void;
  /** 打开某个编程助手的设置（斜杠命令 /config 之类） */
  openCodingSettings?: (backend: string) => void;
  openDesktop?: () => void;
  openHub?: () => void;
  openExt?: () => void;
  openLocal?: () => void;
}

const ActionsCtx = React.createContext<SubagentPaneActions>({});
const usePaneActions = () => React.useContext(ActionsCtx);
/** 在标签区里：关闭在标签上（×），面板头不再放关闭按钮 */
const TabbedCtx = React.createContext(false);

/** 这个子任务在标签区里的状态：是不是当前标签、标签区是否铺满 */
interface PaneSlot {
  tabKey: string;
  active: boolean;
  maximized: boolean;
}

/** 把名字和状态报给标签栏（标签上显示），卸载时撤掉 */
function useReportMeta(tabKey: string, name: string, state: 'running' | 'waiting' | 'idle') {
  const report = useSubagentPane()?.reportMeta;
  React.useEffect(() => {
    report?.(tabKey, { name, state });
  }, [report, tabKey, name, state]);
  React.useEffect(() => () => report?.(tabKey, null), [report, tabKey]);
}

/** 输入栏上的主窗口面板按钮：和主列同一组 */
function panelButtons(a: SubagentPaneActions, withPlugins: boolean) {
  return {
    onPluginsClick: withPlugins ? a.openPlugins : undefined,
    onProvidersClick: a.openProviders,
    onSettingsClick: a.openSettings,
    onDesktopClick: a.openDesktop,
    onHubClick: a.openHub,
    onExtClick: a.openExt,
    onLocalClick: a.openLocal,
  };
}

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
}> = ({ name, state, goal, onClose, onStop }) => {
  const tabbed = React.useContext(TabbedCtx);
  return (
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
        {!tabbed && (
          <IconButton
            size="sm"
            label={t('ui.providers-schedule.close')}
            icon={<Icon icon={X} size={14} />}
            onClick={onClose}
            data-testid="subagent-close"
          />
        )}
      </header>
      {goal && (
        <p className={styles.goal} title={goal}>
          {goal}
        </p>
      )}
    </>
  );
};

/** 委派的编程助手：和主列同一个 CliConversation / MessageInput，只是绑在这个标签上 */
const HarnessChat: React.FC<{ tab: HarnessTabMeta; onClose: () => void; slot: PaneSlot }> = ({
  tab,
  onClose,
  slot,
}) => {
  const core = useHarnessTabsCore();
  const actions = usePaneActions();
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
    // 子任务没有「新会话」：/new 在这里不开新标签，免得主列被切走
    newSession: () => undefined,
    onOpenPlugins: () => actions.openPlugins?.(),
    onOpenProviders: () => actions.openProviders?.(),
    onOpenSettings: () => {
      if (actions.openCodingSettings) actions.openCodingSettings(tab.backend);
      else actions.openSettings?.('coding');
    },
  });
  const name = t(ENDPOINT_NAME[tab.backend] ?? tab.backend);
  const paneState = waiting ? 'waiting' : running ? 'running' : 'idle';
  useReportMeta(slot.tabKey, name, paneState);
  usePaneEscape(slot.active && !slot.maximized, onClose);
  return (
    <section
      className={styles.pane}
      hidden={!slot.active}
      data-testid="subagent-pane"
      data-side-tab={slot.tabKey}
      data-question-scope="subagent"
      data-selection-label={name}
      aria-label={t('ui.session-workspace.subagent-pane-title', name)}
    >
      <PaneHead
        name={name}
        state={paneState}
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
          {...panelButtons(actions, true)}
        />
      </footer>
    </section>
  );
};

/**
 * 不能直接对子代理说话的 CLI（没有可寻址的子代理）：经来源标签交给主代理，由它转给这个子代理
 * （还在跑就转过去，结束了就在它的结果上接着做）。提示里统一说法，由主代理自己选工具。
 */
export function nestedEnvelope(name: string, agentId: string, text: string): string {
  return t('ui.session-workspace.subagent-envelope', name, agentId, text);
}

/** 这次调用在实时轨迹里开始了还没结束 */
function callOpen(
  trace: readonly { type: string; id?: string; detail?: string; status?: string }[] | undefined,
  callId: string,
) {
  let open = false;
  for (const e of trace ?? []) {
    if (e.type !== 'tool' || (e.id ?? e.detail) !== callId) continue;
    open = e.status === 'start';
  }
  return open;
}

type PaneImages = Parameters<typeof toHarnessImages>[0];

/** 侧栏里等着直接发给子代理的一条（它这一步结束后发） */
interface DirectPending extends PendingSend {
  images?: HarnessImageInput[];
}

const EMPTY_AGENTS: Readonly<Record<string, LiveAgent>> = {};

/**
 * 进程内子代理（Task / spawn_agent）。输入栏里的话直接交给这个子代理本身（harness.messageAgent），不经主代理：
 * Codex 在它自己的线程上插话 / 开新一轮；Claude Code 在它结束后接着它自己的会话（关联标签）往下说。
 * 它还在跑、这一步不收时先排在侧栏里，结束后再发；CLI 没有直接通道时改经主代理转达（信封）。
 */
const NestedChat: React.FC<{
  callId: string;
  parentTabId: string | null;
  columnMessages: readonly ConvMessage[];
  onClose: () => void;
  slot: PaneSlot;
}> = ({ callId, parentTabId, columnMessages, onClose, slot }) => {
  const core = useHarnessTabsCore();
  const actions = usePaneActions();
  const tabs = useHarnessTabs();
  const parent = parentTabId ? tabs.state?.tabs.find((t) => t.id === parentTabId) : undefined;
  const raw = useHarnessTabMessages(parentTabId);
  const parentMessages = useMemo(
    () => (parent ? raw.map((m) => fromHarnessMessage(m, parent.backend)) : columnMessages),
    [parent, raw, columnMessages],
  );
  const live = useHarnessLive((map) => (parentTabId ? map[parentTabId] : undefined));
  const detached = useHarnessDetached((map) => (parentTabId ? map[parentTabId] : undefined));
  const liveAgents = live?.agents ?? EMPTY_AGENTS;
  const offAgents = detached?.agents ?? EMPTY_AGENTS;
  const agent = useMemo(() => {
    const match = (a: LiveAgent) => a.callId === callId || a.id === callId;
    return Object.values(offAgents).find(match) ?? Object.values(liveAgents).find(match);
  }, [liveAgents, offAgents, callId]);
  const agentIds = useMemo(() => {
    const ids = agentIdsOfCall(parentMessages, callId, live?.trace);
    if (agent && agent.id !== callId && !ids.includes(agent.id)) ids.unshift(agent.id);
    return ids;
  }, [parentMessages, callId, live?.trace, agent]);
  // 接着这个子代理自己会话的关联标签（Claude Code 子代理结束后直接对它说话时开的）
  const forkTab = parentTabId
    ? tabs.state?.tabs.find(
        (x) =>
          x.subagentOf?.tabId === parentTabId &&
          (x.subagentOf.callId === callId ||
            (!!x.subagentOf.agentId && agentIds.includes(x.subagentOf.agentId))),
      )
    : undefined;
  const forkRaw = useHarnessTabMessages(forkTab?.id ?? null);
  const forkLive = useHarnessLive((map) => (forkTab ? map[forkTab.id] : undefined));
  const deltas = useMemo(
    () => ({ ...detached?.agentDeltas, ...live?.agentDeltas }),
    [detached?.agentDeltas, live?.agentDeltas],
  );
  const messages = useMemo(() => {
    const own = nestedMessages(parentMessages, callId, live?.trace, { agentIds, deltas });
    if (!forkTab) return own;
    return [...own, ...forkRaw.map((m) => fromHarnessMessage(m, forkTab.backend))];
  }, [parentMessages, callId, live?.trace, agentIds, deltas, forkTab, forkRaw]);
  const forkRunning = forkTab?.status === 'running' || forkTab?.status === 'queued';
  const convLive = useMemo<ConvLive | null>(
    () =>
      forkRunning && forkLive
        ? {
            text: forkLive.text,
            trace: forkLive.trace,
            textBreaks: forkLive.textBreaks,
            startedAt: forkLive.startedAt,
            firstEventAt: forkLive.firstEventAt,
          }
        : null,
    [forkRunning, forkLive],
  );
  const open = callOpen(live?.trace, callId);
  const agentRunning = agent ? agent.status === 'running' : open;
  const running = agentRunning || forkRunning;
  const parentBusy = parent?.status === 'running' || parent?.status === 'queued';
  const images = useCliImageSupport(forkTab ?? parent);
  const [draftStore] = useState(createComposerDraftStore);
  const [fill, setFill] = useState<{ text: string; nonce: number } | null>(null);
  // relay：这个 CLI 没有直接通道，改经主代理转达；notice：最近一次直接发送的结果提示
  const [relay, setRelay] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 侧栏里排着、等子代理这一步结束再直接发的；waitParent：要等来源这一轮也结束（Claude Code 只能在那之后接着说）
  const [queued, setQueued] = useState<DirectPending[]>([]);
  const [waitParent, setWaitParent] = useState(false);
  const flushing = React.useRef(false);
  // 经主代理转达、还在来源标签待发列表里的消息：信封 → 用户原话（列表里只显示原话）
  const [sentHere, setSentHere] = useState<Readonly<Record<string, string>>>({});
  const name = agent?.label || agent?.agentType || t('ui.usage-tools.subagent');
  const relayed = useMemo(
    () =>
      (parentTabId ? (core.queues[parentTabId] ?? []) : []).flatMap((item) => {
        const own = sentHere[item.text];
        return own === undefined ? [] : [{ ...item, text: own }];
      }),
    [core.queues, parentTabId, sentHere],
  );
  const forkQueue = forkTab ? (core.queues[forkTab.id] ?? EMPTY_PENDING) : EMPTY_PENDING;
  const pending = useMemo(
    () => [...queued, ...forkQueue, ...relayed],
    [queued, forkQueue, relayed],
  );
  const relaySend = (text: string, mode?: PendingMode, images?: HarnessImageInput[]) => {
    if (!parentTabId) return;
    const body = nestedEnvelope(name, agentIds[0] ?? agent?.id ?? callId, text);
    setSentHere((cur) => ({ ...cur, [body]: text }));
    void core.sendToTab(parentTabId, body, undefined, images, mode);
  };
  const enqueue = (text: string, images?: HarnessImageInput[]) =>
    setQueued((cur) => [...cur, { id: newPendingId(), text, mode: 'queue', images }]);
  const deliver = async (text: string, mode?: PendingMode, images?: HarnessImageInput[]) => {
    if (!parentTabId) return;
    if (relay) {
      relaySend(text, mode, images);
      return;
    }
    if (forkTab) {
      await core.sendToTab(forkTab.id, text, undefined, images, mode);
      return;
    }
    const r: MessageAgentResult = await harnessClient
      .messageAgent({
        id: parentTabId,
        callId,
        ...(agentIds[0] ? { agentId: agentIds[0] } : {}),
        text,
        ...(images?.length ? { images } : {}),
        mode: mode === 'queue' ? 'queue' : 'steer',
      })
      .catch((e: unknown) => ({ ok: false, reason: 'error', message: String(e) }));
    if (r.ok) {
      setNotice(
        r.via === 'fork' || r.via === 'resume'
          ? t('ui.session-workspace.subagent-direct-resumed')
          : null,
      );
      return;
    }
    switch (r.reason) {
      case 'busy':
      case 'running':
        if (r.reason === 'running') setWaitParent(true);
        enqueue(text, images);
        setNotice(t('ui.session-workspace.subagent-direct-queued'));
        return;
      case 'unsupported':
        setRelay(true);
        setNotice(t('ui.session-workspace.subagent-direct-unsupported'));
        relaySend(text, mode, images);
        return;
      case 'not_found':
        setNotice(t('ui.session-workspace.subagent-direct-not-found'));
        setFill((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
        return;
      default:
        setNotice(t('ui.session-workspace.subagent-direct-failed', r.message ?? r.reason ?? ''));
        setFill((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
    }
  };
  const send = (text: string, mode?: PendingMode, imgs?: PaneImages) => {
    void (async () => {
      const harnessImages = imgs?.length ? await toHarnessImages(imgs) : undefined;
      await deliver(text, mode, harnessImages);
    })();
  };
  // 子代理这一步结束（需要时连同来源这一轮）：排着的合成一条直接发给它
  React.useEffect(() => {
    if (!queued.length || running || flushing.current || (waitParent && parentBusy)) return;
    const items = queued;
    const text = mergePending(items);
    const imgs = items.flatMap((i) => i.images ?? []);
    flushing.current = true;
    setQueued([]);
    setWaitParent(false);
    void deliver(text, undefined, imgs.length ? imgs : undefined).finally(() => {
      flushing.current = false;
    });
    // deliver 每次渲染都是新的；只在排队 / 运行状态变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, running, waitParent, parentBusy]);
  const removePending = (id: string) => {
    if (queued.some((i) => i.id === id)) setQueued((cur) => cur.filter((i) => i.id !== id));
    else if (forkTab && forkQueue.some((i) => i.id === id)) core.removePendingFrom(forkTab.id, id);
    else if (parentTabId) core.removePendingFrom(parentTabId, id);
  };
  const stop = () => {
    if (!parentTabId) return;
    void (async () => {
      if (forkTab && forkRunning) {
        await core.cancelRun(forkTab.id);
        return;
      }
      // 子代理单独停（后台子代理、直接对话后它接着跑的那一轮）；前台子代理是来源这一轮的一部分，停它就是停这一轮
      if (agent && (await harnessClient.stopAgent(parentTabId, agent.id).catch(() => false)))
        return;
      if (open) await core.cancelRun(parentTabId);
    })();
  };
  useReportMeta(slot.tabKey, name, running ? 'running' : 'idle');
  usePaneEscape(slot.active && !slot.maximized, onClose);
  return (
    <section
      className={styles.pane}
      hidden={!slot.active}
      data-testid="subagent-pane"
      data-side-tab={slot.tabKey}
      data-question-scope="subagent"
      data-selection-label={name}
      aria-label={name}
    >
      <PaneHead
        name={name}
        state={running ? 'running' : 'idle'}
        goal={agent?.progress}
        onClose={onClose}
        onStop={parentTabId && (agent || open || forkRunning) ? stop : undefined}
      />
      <p className={styles.hint} data-testid="subagent-hint">
        {!parentTabId
          ? t('ui.session-workspace.subagent-nested-readonly')
          : relay
            ? t('ui.session-workspace.subagent-nested-hint')
            : t('ui.session-workspace.subagent-direct-hint')}
      </p>
      {notice && (
        <p className={styles.hint} data-testid="subagent-notice" role="status">
          {notice}
        </p>
      )}
      <div className={styles.conv}>
        <ConversationView
          scopeId={`nested:${callId}`}
          messages={messages}
          live={convLive}
          phase={running ? 'running' : 'idle'}
        />
      </div>
      {parentTabId && parent ? (
        <footer className={styles.composer}>
          {forkTab && <UserQuestionDock tabId={forkTab.id} />}
          <PendingDock
            items={pending}
            onRemove={removePending}
            onWithdraw={(item) => {
              removePending(item.id);
              setFill((prev) => ({ text: item.text, nonce: (prev?.nonce ?? 0) + 1 }));
            }}
          />
          <MessageInput
            onSend={(text, imgs) => send(text, undefined, imgs)}
            busyOverride={running || (relay && parentBusy)}
            imageCapability={images.capability}
            imageUnsupportedReason={images.reason}
            placeholder={t('ui.session-workspace.subagent-nested-placeholder', name)}
            queue={{
              onQueue: (text, opts) => send(text, opts?.mode),
              onStop: stop,
              pending: pending.length,
              onFlush: () => {
                if (relay) void core.flushPendingFor(parentTabId);
                else if (forkTab) void core.flushPendingFor(forkTab.id);
                else stop();
              },
            }}
            cwd={parent.cwd}
            fill={fill}
            draftStore={draftStore}
            draftKey={draftKey({
              kind: 'tab',
              id: `nested:${callId}`,
              hasCommittedUserContent: true,
            })}
            delegate={false}
            {...panelButtons(actions, true)}
          />
        </footer>
      ) : null}
    </section>
  );
};

const EMPTY_PENDING: PendingSend[] = [];

const TASK_ACTIVE = new Set(['running', 'queued', 'waiting_user']);

/**
 * 后台 Nomi（delegate_to_nomi）：会话来自 tasks.trace（每次执行一轮），正在跑的这次由 tasks.live 实时推送。
 * 输入栏：空闲时发送 = 追问（tasks.followUp，带着这句话在上次结果上再跑一次）；运行中 Enter = 插话
 * （tasks.steer，下一步并进上下文，不收时转为排队），Ctrl/⌘+Enter = 排队，这次跑完后合成一条追问发出；
 * 停止 = 取消这次执行。
 */
const NomiTaskChat: React.FC<{ taskId: string; onClose: () => void; slot: PaneSlot }> = ({
  taskId,
  onClose,
  slot,
}) => {
  const actions = usePaneActions();
  const [goal, setGoal] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [view, setView] = React.useState<TaskTraceView | null>(null);
  const [live, setLive] = React.useState<NomiTaskLive | null>(null);
  const [pending, setPending] = React.useState<
    Array<PendingSend & { images?: Array<{ mime: string; data: string }> }>
  >([]);
  const [draftStore] = useState(createComposerDraftStore);
  const [fill, setFill] = useState<{ text: string; nonce: number } | null>(null);
  const running = TASK_ACTIVE.has(status);
  React.useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () => {
      void tasksApi
        .get(taskId)
        .then((rec) => {
          if (!alive || !rec) return;
          setGoal(rec.task.goal);
          setTitle(rec.task.title);
          setStatus(rec.task.status);
        })
        .catch(() => undefined);
      void tasksApi
        .trace(taskId)
        .then((v) => {
          if (!alive) return;
          setView(v);
          // 快照是这次执行的完整状态：替换掉之前累积的增量
          setLive(liveFromView(v));
        })
        .catch(() => undefined);
    };
    // 状态变化 / 一步做完时重新对一次快照（合并同一时刻的多次通知）
    const schedule = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        load();
      }, 120);
    };
    load();
    const offChange = tasksApi.onChange(schedule);
    const offLive = tasksApi.onLive((p) => {
      if (p.id !== taskId) return;
      setLive((prev) => applyTaskLiveEvent(prev, p.attemptId, p.event));
      if (p.event.type === 'done' || (p.event.type === 'tool' && p.event.status !== 'start'))
        schedule();
    });
    return () => {
      alive = false;
      offChange();
      offLive();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [taskId]);
  // 这次跑完：排队的消息合成一条追问发出（和主列「这一轮结束后发送」一样）
  React.useEffect(() => {
    if (running || !status || pending.length === 0) return;
    const text = mergePending(pending);
    const images = pending.flatMap((p) => p.images ?? []).slice(0, 8);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 待发列表随任务状态出队
    setPending([]);
    void tasksApi.followUp(taskId, text, images).catch(() => undefined);
  }, [running, status, pending, taskId]);
  const messages = useMemo(
    () => nomiTaskMessages(goal, view ?? { attemptId: null, lines: [] }, live?.attemptId),
    [goal, view, live?.attemptId],
  );
  const convLive = useMemo<ConvLive | null>(
    () =>
      live
        ? {
            text: live.text,
            trace: live.trace,
            startedAt: live.startedAt,
            ...(live.text || live.trace.length ? { firstEventAt: live.startedAt } : {}),
          }
        : null,
    [live],
  );
  const enqueue = (text: string, images?: Array<{ mime: string; data: string }>) =>
    setPending((cur) => [...cur, { id: newPendingId(), text, mode: 'queue', images }]);
  const stop = () => void tasksApi.cancel(taskId).catch(() => undefined);
  usePaneEscape(slot.active && !slot.maximized, onClose);
  const name = title || t('ui.usage-tools.subagent');
  const paneState = status === 'waiting_user' ? 'waiting' : running ? 'running' : 'idle';
  useReportMeta(slot.tabKey, name, paneState);
  return (
    <section
      className={styles.pane}
      hidden={!slot.active}
      data-testid="subagent-pane"
      data-side-tab={slot.tabKey}
      data-question-scope="subagent"
      data-selection-label={name}
      aria-label={t('ui.session-workspace.subagent-pane-title', name)}
    >
      <PaneHead
        name={name}
        state={paneState}
        goal={goal}
        onClose={onClose}
        onStop={running ? stop : undefined}
      />
      <p className={styles.hint}>
        {running
          ? t('ui.session-workspace.subagent-nomi-hint-running')
          : t('ui.session-workspace.subagent-nomi-hint')}
      </p>
      <div className={styles.conv}>
        <ConversationView
          scopeId={`nomi-task:${taskId}`}
          messages={messages}
          live={convLive}
          phase={running ? 'running' : 'idle'}
        />
      </div>
      <footer className={styles.composer}>
        <PendingDock
          items={pending}
          onRemove={(id) => setPending((cur) => cur.filter((i) => i.id !== id))}
          onWithdraw={(item) => {
            setPending((cur) => cur.filter((i) => i.id !== item.id));
            setFill((prev) => ({ text: item.text, nonce: (prev?.nonce ?? 0) + 1 }));
          }}
        />
        <MessageInput
          onSend={(text, imgs) => {
            void (async () => {
              const images = imgs?.length
                ? (await toHarnessImages(imgs)).map((i) => ({ mime: i.mime, data: i.data }))
                : undefined;
              const r = await tasksApi.followUp(taskId, text, images).catch(() => null);
              // 刚好又跑起来了（busy）：排进待发列表，这次跑完再发
              if (r && !r.ok && r.reason === 'busy') enqueue(text, images);
            })();
          }}
          busyOverride={running}
          placeholder={t('ui.session-workspace.subagent-nomi-placeholder')}
          queue={{
            onQueue: (text, opts) => {
              if (opts?.mode === 'queue') {
                enqueue(text);
                return;
              }
              // 插话：交给正在跑的工具循环；这一步不收（在写结论）就排队，跑完后追问
              void tasksApi
                .steer(taskId, text)
                .then((ok) => {
                  if (!ok) enqueue(text);
                })
                .catch(() => enqueue(text));
            },
            onStop: stop,
            pending: pending.length,
            onFlush: stop,
          }}
          fill={fill}
          draftStore={draftStore}
          draftKey={draftKey({
            kind: 'tab',
            id: `nomi-task:${taskId}`,
            hasCommittedUserContent: true,
          })}
          delegate={false}
          {...panelButtons(actions, false)}
        />
      </footer>
    </section>
  );
};

const PaneBody: React.FC<{
  target: SubagentTarget;
  columnMessages: readonly ConvMessage[];
  onClose: () => void;
  slot: PaneSlot;
}> = ({ target, columnMessages, onClose, slot }) => {
  const tabs = useHarnessTabs();
  if (target.kind === 'harness') {
    const tab = tabs.state?.tabs.find((item) => item.id === target.tabId);
    if (!tab) return null;
    return <HarnessChat key={tab.id} tab={tab} onClose={onClose} slot={slot} />;
  }
  if (target.kind === 'nested') {
    return (
      <NestedChat
        key={target.callId}
        callId={target.callId}
        parentTabId={target.parentTabId}
        columnMessages={columnMessages}
        onClose={onClose}
        slot={slot}
      />
    );
  }
  return <NomiTaskChat key={target.taskId} taskId={target.taskId} onClose={onClose} slot={slot} />;
};

/**
 * 开着的子任务都挂着（切走的只隐藏），切回来时流式输出、输入框草稿、滚动位置都还在。
 * tabbed：在标签区里（关闭在标签上）；单独用时（单测 / 别的窗口）面板头自带关闭按钮。
 */
export const SubagentPane: React.FC<{
  columnMessages: readonly ConvMessage[];
  actions?: SubagentPaneActions;
  tabbed?: boolean;
  /** 独立窗口里（弹出的标签）：整窗只有它，Esc 不关、没有关闭按钮（关窗口即可） */
  standalone?: boolean;
}> = ({ columnMessages, actions, tabbed = false, standalone = false }) => {
  const pane = useSubagentPane();
  const value = useMemo(() => actions ?? {}, [actions]);
  if (!pane?.targets.length) return null;
  const maximized = pane.tabs.maximized || standalone;
  return (
    <ActionsCtx.Provider value={value}>
      <TabbedCtx.Provider value={tabbed || standalone}>
        {pane.targets.map((target) => {
          const key = agentKey(target);
          return (
            <PaneBody
              key={key}
              target={target}
              columnMessages={columnMessages}
              onClose={() => pane.closeTab(key)}
              slot={{ tabKey: key, active: pane.active === key, maximized }}
            />
          );
        })}
      </TabbedCtx.Provider>
    </ActionsCtx.Provider>
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
  /** 主窗口的面板入口（设置 / 插件 / 模型 …），子任务侧栏里的按钮打开它们 */
  actions?: SubagentPaneActions;
}> = ({ messages, cwd, roots, actions }) =>
  useSubagentPane()?.target ? (
    <SubagentPane columnMessages={messages} actions={actions} />
  ) : (
    <CenterChangesHost messages={messages} cwd={cwd} roots={roots} mode="slot" />
  );
