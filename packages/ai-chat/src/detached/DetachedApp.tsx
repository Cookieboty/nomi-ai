/**
 * 弹出窗口（标签区的标签弹到独立窗口，见 docs/design/side-tabs-workspace.md）：
 * 同一个对话页面带 ?detached=<spec> 打开，这里只画那一个子任务 / 文件，不挂侧栏、主列和各种整页。
 * 数据层和主窗口一样（AiChatContextProvider / HarnessTabsProvider / 标签区 Provider），都按会话 / 标签 id 绑定，
 * 所以流式输出、输入栏、排队、授权回复和在主窗口里一样；本窗口的标签区状态不落盘（会话键为空）。
 * 侧边聊天的内容只在界面内存里：打开时从宿主取走主窗口交过来的快照，之后每次变化都交回一份
 * （放回 / 关窗口后主窗口取走，见 services/sideChat 的 exportSideChat / importSideChat）。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import * as AISdkReact from '@nomi-ai/ai-sdk-client/react';
import { Button, Icon, t } from '@nomi-ai/ui';
import { IconArrowBackUp as Undo2 } from '@tabler/icons-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { ChatBackgroundLayer } from '../components/ChatBackground/ChatBackgroundLayer';
import { ErrorBoundary } from '../components/ErrorBoundary';
import type { PreviewTabsControl } from '../components/ResourcePreview/ResourcePreview';
import { SideChatPane, type SideChatDockState } from '../components/SideChat';
import type { ComposerDraftLock } from '../components/MessageInput/types';
import { useSubagentPane, SubagentPane, WorkspacePanesProvider } from '../components/SubagentPane';
import { wailsWindow, WindowControls } from '../components/TitleBar';
import { AiChatContextProvider } from '../contexts/AiChatContext';
import { HarnessTabsProvider, useHarnessTabs } from '../contexts/HarnessTabsContext';
import { ResourceScopeProvider } from '../contexts/ResourceContext';
import { useResourcePreview } from '../hooks/useResourcePreview';
import { detachedWindows } from '../services/detachedWindows';
import {
  exportSideChat,
  importSideChat,
  sideChatDraftKey,
  sideChatDrafts,
  subscribeSideChat,
} from '../services/sideChat';
import { detachedId, detachSpecKey, type DetachSpec } from '../utils/detachedTabs';
import { agentKey } from '../utils/sideTabs';
import '../App.css';

import styles from './DetachedApp.module.css';

const NO_MESSAGES: never[] = [];

/** 窗口标题跟着子任务名字变（任务栏 / Dock / ⌘` 里看得到） */
function useWindowTitle(name: string) {
  useEffect(() => {
    const title = name ? `${name} — Nomi` : 'Nomi';
    document.title = title;
    void wailsWindow()
      ?.SetTitle?.(title)
      ?.catch(() => undefined);
  }, [name]);
}

const Bar: React.FC<{ title: string; onDock?: () => void; docking?: boolean }> = ({
  title,
  onDock,
  docking,
}) => (
  <header className={styles.bar} data-testid="detached-bar">
    <span className={styles.title}>{title}</span>
    {onDock && (
      <Button
        size="sm"
        variant="ghost"
        onClick={onDock}
        disabled={docking}
        data-testid="detached-dock"
      >
        <Icon icon={Undo2} size={14} />
        {t('ui.session-workspace.side-tab-dock')}
      </Button>
    )}
    <WindowControls />
  </header>
);

/** 侧边聊天：取走主窗口交过来的内容；之后每次变化（停顿一下）都交回一份，关窗口 / 放回后主窗口取走 */
function useSideChatHandoff(
  spec: Extract<DetachSpec, { kind: 'agent' }>,
  readyRef: React.RefObject<boolean | null>,
  dockRef: React.RefObject<{ transferId: string } | null>,
  lockRef: React.RefObject<ComposerDraftLock | null>,
): boolean | null {
  const chatId = spec.target.kind === 'side-chat' ? spec.target.chatId : null;
  const id = detachedId(spec.scope, agentKey(spec.target));
  const [ready, setReady] = useState<boolean | null>(chatId ? null : true);
  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    let timer: number | undefined;
    const save = () => {
      if (!alive) return;
      // 放回等确认期间草稿在锁里（桶里还是旧的那份），导出要用锁里这份
      const lock = dockRef.current ? lockRef.current : null;
      const data = exportSideChat(chatId, {
        settle: true,
        ...(lock ? { draft: lock.read() } : {}),
      });
      if (!data) return;
      // 放回等确认期间也照常交，而且用放回那个传输 id：主窗口取到的是最新的这份，不是开始等之前的那份
      const dock = dockRef.current;
      void detachedWindows.put(
        id,
        data,
        dock
          ? { transferId: dock.transferId, direction: 'dock', keepUntilAck: true }
          : { direction: 'dock' },
      );
    };
    const scheduleSave = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 150);
    };
    let offChat = () => {};
    let offDraft = () => {};
    void detachedWindows.take(id, { direction: 'detach' }).then((data) => {
      if (!alive) return;
      const ok = importSideChat(data) === chatId;
      readyRef.current = ok;
      setReady(ok);
      if (!ok) return;
      save();
      offChat = subscribeSideChat(save);
      const draftKey = sideChatDraftKey(chatId);
      offDraft = sideChatDrafts.subscribe((k) => {
        if (k === draftKey) scheduleSave();
      });
    });
    window.addEventListener('pagehide', save);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', save);
      offChat();
      offDraft();
    };
  }, [chatId, id, readyRef, dockRef, lockRef]);
  return ready;
}

const AgentWindow: React.FC<{ spec: Extract<DetachSpec, { kind: 'agent' }> }> = ({ spec }) => {
  const pane = useSubagentPane();
  const key = agentKey(spec.target);
  const { openSubagent, openNested, openNomiTask, openSideChatTab } = pane ?? {};
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const sideChatId = spec.target.kind === 'side-chat' ? spec.target.chatId : null;
  const readyRef = useRef<boolean | null>(sideChatId ? null : true);
  /** 正在等主窗口确认的那次放回（没有 = 不在放回） */
  const dockRef = useRef<{ transferId: string } | null>(null);
  const [dockState, setDockState] = useState<'idle' | 'docking' | 'failed'>('idle');
  /** 一次放回；每被主窗口重新打开一次加一（输入栏据此解锁） */
  const [dockRound, setDockRound] = useState(0);
  /** 放回等待期间输入栏读写的那份草稿（写在这里，锁里的那份随每次改动交回主窗口） */
  const [dockLock, setDockLock] = useState<ComposerDraftLock | null>(null);
  /** 给交接 / 定时同步的两个钩子用（它们在 effect 里读，不能依赖每次渲染都变的 state） */
  const lockRef = useRef<ComposerDraftLock | null>(null);
  const setLock = (next: ComposerDraftLock | null) => {
    lockRef.current = next;
    setDockLock(next);
  };
  /**
   * 解锁：锁里那份（等确认期间打的字）先写回草稿桶，再释放。输入栏按最新的桶重新读，之后的改动直接写桶。
   */
  const unlock = () => {
    const lock = lockRef.current;
    if (!lock) return;
    if (sideChatId) sideChatDrafts.write(sideChatDraftKey(sideChatId), lock.read());
    lock.release();
    setLock(null);
  };
  const sideReady = useSideChatHandoff(spec, readyRef, dockRef, lockRef);
  useDockDraftSync(sideChatId, detachedId(spec.scope, key), dockRef, lockRef, dockState === 'docking');
  // 主窗口又把这个侧边聊天打开了（放回实际没有成功 / 这边迟到）：解锁，草稿换成最新的
  const backendDock = () => {
    if (!dockRef.current) return;
    dockRef.current = null;
    unlock();
    setDockRound((n) => n + 1);
    setDockState('idle');
  };
  useEffect(() => {
    const target = spec.target;
    if (target.kind === 'harness') openSubagent?.(target.tabId);
    else if (target.kind === 'nested') openNested?.(target.callId, target.parentTabId);
    else if (target.kind === 'side-chat') {
      if (sideReady) {
        openSideChatTab?.(target.chatId);
        backendDock();
      }
    } else openNomiTask?.(target.taskId);
  }, [spec.target, openSubagent, openNested, openNomiTask, openSideChatTab, sideReady]);
  const name = pane?.meta[key]?.name || spec.title;
  useWindowTitle(name);
  const harnessLoaded = !!useHarnessTabs().state;
  const gone =
    spec.target.kind === 'side-chat'
      ? sideReady === false
      : !!pane && pane.targets.length === 0 && spec.target.kind !== 'nomi-task' && harnessLoaded;
  /**
   * 放回主窗口。侧边聊天先在这里导出快照并锁住草稿：等确认期间输入栏还能写，但写的是锁里的那份，
   * 主窗口手里的就是这里的草稿；每次改动还按同一个传输 id 交一份新的（主窗口取到的是最新的）。
   * 放回失败 / 超时 / 被重新打开：解锁到最新的草稿，不关窗口，可以直接再放回。
   */
  const dock = () => {
    if (dockRef.current) return;
    const transferId = detachedWindows.newTransferId();
    dockRef.current = { transferId };
    setDockState('docking');
    let data: string | null = null;
    if (sideChatId) {
      const lock = sideChatDrafts.lock(sideChatDraftKey(sideChatId));
      data = exportSideChat(sideChatId, { settle: true, draft: lock.read() });
      setLock(lock);
    }
    const run = async () => {
      if (
        data &&
        !(await detachedWindows.put(detachedId(spec.scope, key), data, {
          transferId,
          direction: 'dock',
          keepUntilAck: true,
        }))
      )
        return false;
      return detachedWindows.dock(spec.scope, key, { transferId, requireAck: true });
    };
    void run().then((ok) => {
      if (ok) {
        if (aliveRef.current) setDockState('docking');
        return;
      }
      // 这次放回作废：之后迟到的确认不能把这里解锁掉
      if (dockRef.current?.transferId === transferId) dockRef.current = null;
      // 等确认期间打的字写回草稿桶再解锁：失败态只是提示，不挂锁，输入栏接着写桶，下次放回带最新的
      if (aliveRef.current) unlock();
      else setLock(null);
      setDockRound((n) => n + 1);
      if (aliveRef.current) setDockState('failed');
    });
  };
  // 等确认期间带着锁里的那份（输入栏在锁里接着写，每次改动按同一个传输 id 交回主窗口）
  const sideDockState: SideChatDockState | undefined = !sideChatId
    ? undefined
    : dockState === 'docking'
      ? dockLock
        ? { status: 'pending', lock: dockLock }
        : undefined
      : dockState === 'failed'
        ? { status: 'failed' }
        : dockRound
          ? { status: 'aborted', attempt: dockRound }
          : undefined;
  return (
    <>
      <Bar title={name} onDock={dock} docking={dockState === 'docking'} />
      <main className={styles.body} data-testid="detached-agent">
        {spec.target.kind === 'side-chat' ? (
          <SideChatPane
            chatId={spec.target.chatId}
            slot={{ tabKey: key, active: pane?.active === key }}
            dockState={sideDockState}
          />
        ) : (
          <SubagentPane columnMessages={NO_MESSAGES} standalone />
        )}
        {gone && (
          <p className={styles.empty} data-testid="detached-gone">
            {t('ui.session-workspace.side-tab-detached-missing')}
          </p>
        )}
      </main>
    </>
  );
};

/** 在等放回确认的侧边聊天：每次改动停顿一下，把最新的那份再交一次（同一个传输 id，主窗口取到的是最新的） */
function useDockDraftSync(
  chatId: string | null,
  id: string,
  dockRef: React.RefObject<{ transferId: string } | null>,
  lockRef: React.RefObject<ComposerDraftLock | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!chatId || !enabled) return;
    const draftKey = sideChatDraftKey(chatId);
    let timer: number | undefined;
    const sync = () => {
      const dock = dockRef.current;
      const lock = lockRef.current;
      if (!dock || !lock) return;
      // 这次改动在锁里（草稿桶没变）：交的是锁里这份
      const data = exportSideChat(chatId, { settle: true, draft: lock.read() });
      if (!data) return;
      void detachedWindows.put(id, data, {
        transferId: dock.transferId,
        direction: 'dock',
        keepUntilAck: true,
      });
    };
    const off = sideChatDrafts.subscribe((k) => {
      if (k !== draftKey) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(sync, 150);
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [chatId, id, dockRef, lockRef, enabled]);
}

const FileWindow: React.FC<{ spec: Extract<DetachSpec, { kind: 'file' }> }> = ({ spec }) => {
  const preview = useResourcePreview(spec.origin);
  const { open } = preview.value;
  const [control] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    open(spec.href, spec.origin);
  }, [open, spec.href, spec.origin]);
  if (preview.isOpen && !opened) setOpened(true);
  useWindowTitle(spec.title);
  // 窗口里把文件关掉了：关窗口
  const empty = opened && !preview.isOpen;
  useEffect(() => {
    if (empty) void wailsWindow()?.Close();
  }, [empty]);
  return (
    <ResourceScopeProvider value={preview.value}>
      <Bar title={spec.title} />
      <main className={styles.body} data-testid="detached-file">
        {preview.renderEmbedded({
          inactive: false,
          expanded: true,
          onExpanded: () => undefined,
          controlRef: control,
        })}
        {preview.overlays}
      </main>
    </ResourceScopeProvider>
  );
};

function useOptionalAIClient(): ClientAIClient | undefined {
  const hook = (AISdkReact as { useAIClient?: () => ClientAIClient }).useAIClient;
  if (!hook) return undefined;
  try {
    return hook();
  } catch {
    return undefined;
  }
}

export function DetachedApp({ spec }: { spec: DetachSpec }) {
  const client = useOptionalAIClient();
  const key = useMemo(() => detachSpecKey(spec), [spec]);
  return (
    <ErrorBoundary>
      <AiChatContextProvider client={client}>
        <HarnessTabsProvider>
          <WorkspacePanesProvider detached>
            <div className={styles.app} data-detached-tab={key}>
              <ChatBackgroundLayer />
              {spec.kind === 'agent' ? <AgentWindow spec={spec} /> : <FileWindow spec={spec} />}
            </div>
          </WorkspacePanesProvider>
        </HarnessTabsProvider>
      </AiChatContextProvider>
    </ErrorBoundary>
  );
}
