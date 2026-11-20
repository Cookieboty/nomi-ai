/**
 * 侧边工作区内置终端组件（通过 React.lazy 按需加载，确保 xterm.js 零字节进入首屏分包）。
 * - 支持参考 Ghostty 的递归二分分屏（macOS ⌘D 向右 / ⇧⌘D 向下，Win/Linux Ctrl+Shift+D / Alt+Shift+D）；
 * - 采用扁平几何投影布局，新增/关闭分屏时不卸载已有 xterm 实例，完整保留滚动历史与光标；
 * - 关闭运行中分屏或包含运行中进程的终端标签页前触发应用内二次确认。
 */
import '@xterm/xterm/css/xterm.css';

import { Icon, IconButton, t } from '@nomi-ai/ui';
import {
  IconX as CloseIcon,
  IconLayoutColumns as ColumnsSplit,
  IconEraser as Eraser,
  IconExternalLink as ExternalLink,
  IconFolderOpen as FolderOpen,
  IconRefresh as RotateCw,
  IconLayoutRows as RowsSplit,
  IconTerminal2 as TerminalIcon,
} from '@tabler/icons-react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { openProjectTerminal } from '../../services/openProjectTerminal';
import { isMac } from '../../services/shortcuts';
import {
  createTerminalStreamCursor,
  decodeTerminalBytes,
  isTerminalRunning,
  sideTerminalHost,
  sideTerminalIdFor,
  subscribeSideTerminal,
  subscribeSideTerminalInputErrors,
  type SideTerminalExitEvent,
} from '../../services/sideTerminal';
import { isImeComposing } from '../../utils/keyboard';
import { basename } from '../../utils/resourceLinks';
import { newWorkspaceId } from '../../utils/sideTabs';
import {
  closePane,
  collectPaneIds,
  computeSplitLayout,
  createRootPane,
  cyclePaneId,
  findPane,
  MAX_TERMINAL_PANES,
  navigatePane,
  setTerminalSplitRatio,
  splitPane,
  TERMINAL_SPLIT_MAX_RATIO,
  TERMINAL_SPLIT_MIN_RATIO,
  updatePaneLeaf,
  type DividerBox,
  type NormalizedRect,
  type SplitDirection,
  type TerminalPaneLeaf,
  type TerminalPaneNode,
  type TerminalTabController,
} from '../../utils/terminalSplit';
import { confirmDialog } from '../ConfirmDialog';

import {
  formatTerminalErrorReason,
  isSplitDownShortcut,
  isSplitRightShortcut,
  matchCycleDirection,
  matchNavDirection,
  openTerminalUri,
  readXtermTheme,
} from './terminalHelpers';
import styles from './TerminalTab.module.css';

interface PaneRuntimeState {
  cwd: string;
  shell: string;
  dotState: 'running' | 'exited' | 'error';
  explicitCwd: boolean;
}

interface PaneHandle {
  focus: () => void;
  clear: () => void;
  restart: () => void;
  restartWithDir: (cwd: string | undefined, explicit: boolean) => void;
  getCwd: () => string;
  isExplicitCwd: () => boolean;
}

interface TerminalPaneProps {
  leaf: TerminalPaneLeaf;
  rect: NormalizedRect;
  projectId?: string | null;
  defaultCwd?: string | null;
  hidden: boolean;
  isActive: boolean;
  isMulti: boolean;
  onFocusPane: (paneId: string) => void;
  onStateChange: (paneId: string, state: PaneRuntimeState) => void;
  registerHandle: (paneId: string, handle: PaneHandle | null) => void;
}

const TerminalPane: React.FC<TerminalPaneProps> = React.memo(
  ({
    leaf,
    rect,
    projectId,
    defaultCwd,
    hidden,
    isActive,
    isMulti,
    onFocusPane,
    onStateChange,
    registerHandle,
  }) => {
    const paneId = leaf.paneId;
    const termId = sideTerminalIdFor(paneId);
    const hostAvailable = sideTerminalHost.available();

    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const hiddenRef = useRef(hidden);
    const isActiveRef = useRef(isActive);
    const onStateChangeRef = useRef(onStateChange);

    const [runSeq, setRunSeq] = useState(0);
    const [activeCwd, setActiveCwd] = useState<string>(leaf.cwd || defaultCwd || '');
    const [explicitCwdFlag, setExplicitCwdFlag] = useState<boolean>(
      Boolean(leaf.explicitCwd || (leaf.cwd && leaf.cwd !== defaultCwd)),
    );
    const [shellName, setShellName] = useState<string>('shell');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
    const [exitInfo, setExitInfo] = useState<SideTerminalExitEvent | null>(null);
    /** 键盘输入没写进终端（分块写入失败 / 被拒）：可见提示，不自动重试（见 services/terminalInput） */
    const [inputError, setInputError] = useState<string | null>(null);

    const activeCwdRef = useRef(activeCwd);
    const explicitCwdRef = useRef(explicitCwdFlag);
    const activeGenRef = useRef<number | undefined>(undefined);
    const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
    const initialReqRef = useRef<{
      projectId?: string;
      cwd?: string;
      explicitCwd?: boolean;
      replace?: boolean;
    }>({
      projectId: projectId ?? undefined,
      cwd: leaf.cwd || defaultCwd || undefined,
      explicitCwd: Boolean(leaf.explicitCwd || (leaf.cwd && leaf.cwd !== defaultCwd)),
    });

    useEffect(() => {
      hiddenRef.current = hidden;
      isActiveRef.current = isActive;
      onStateChangeRef.current = onStateChange;
      activeCwdRef.current = activeCwd;
      explicitCwdRef.current = explicitCwdFlag;
    });

    const displayError = hostAvailable ? errorMsg : t('ui.session-workspace.terminal-unavailable');
    const dotState: 'running' | 'exited' | 'error' = displayError
      ? 'error'
      : exitInfo
        ? 'exited'
        : 'running';

    useEffect(() => {
      onStateChangeRef.current(paneId, {
        cwd: activeCwd,
        shell: shellName,
        dotState,
        explicitCwd: explicitCwdFlag,
      });
    }, [paneId, activeCwd, shellName, dotState, explicitCwdFlag]);

    const syncSize = useCallback(() => {
      const el = hostRef.current;
      const term = termRef.current;
      const fit = fitRef.current;
      if (!el || !term || !fit || hiddenRef.current) return;
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
      fit.fit();
      const { cols, rows } = term;
      if (
        cols >= 10 &&
        rows >= 4 &&
        (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)
      ) {
        lastSizeRef.current = { cols, rows };
        sideTerminalHost.resize(termId, cols, rows);
      }
    }, [termId]);

    useEffect(() => {
      const container = hostRef.current;
      if (!container || !hostAvailable) return;

      // 重新打开（restartWithDir / 关掉重开后重挂）换代：上一代残留的失败提示与未发出的输入作废
      sideTerminalHost.resetInput(termId);
      setInputError(null);

      let alive = true;
      let streamReady = false;
      let activeGen: number | undefined;
      const cursor = createTerminalStreamCursor();
      let pendingExit: SideTerminalExitEvent | null = null;
      lastSizeRef.current = { cols: 0, rows: 0 };

      const { theme, fontFamily } = readXtermTheme();
      const term = new Terminal({
        fontFamily,
        fontSize: 13,
        lineHeight: 1.35,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: false,
        theme,
      });
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon((_ev, uri) => openTerminalUri(uri));
      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(container);

      termRef.current = term;
      fitRef.current = fitAddon;

      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        // Ctrl+Tab 交给外层标签栏切换工作区标签
        if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey) return false;

        const mac = isMac();
        // 分屏与窗格切换快捷键不透传进 shell PTY
        if (
          isSplitRightShortcut(e, mac) ||
          isSplitDownShortcut(e, mac) ||
          matchNavDirection(e, mac) !== null ||
          matchCycleDirection(e, mac) !== null
        ) {
          return false;
        }

        if (mac) {
          const key = e.key.toLowerCase();
          if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            if (key === 'w') return false;
            if (key === 'k') {
              e.preventDefault();
              term.clear();
              return false;
            }
            if (key === 'c' && term.hasSelection()) {
              e.preventDefault();
              void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
              return false;
            }
          }
        } else {
          const key = e.key.toLowerCase();
          if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'c') {
            if (term.hasSelection()) {
              e.preventDefault();
              void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
            }
            return false;
          }
          if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && key === 'c') {
            if (term.hasSelection()) {
              e.preventDefault();
              void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
              term.clearSelection();
              return false;
            }
          }
        }
        return true;
      });

      let initialCols = 80;
      let initialRows = 24;
      if (!hiddenRef.current && container.clientWidth > 0 && container.clientHeight > 0) {
        fitAddon.fit();
        if (term.cols >= 10 && term.rows >= 4) {
          initialCols = term.cols;
          initialRows = term.rows;
          lastSizeRef.current = { cols: initialCols, rows: initialRows };
        }
      }

      // 一段粘贴可能远超契约上限：交给 sideTerminalHost 分块、串行写入（顺序保持，失败可见）
      const disposeInput = term.onData((data) => {
        void sideTerminalHost.write(termId, data);
      });
      const unsubscribeInputErrors = subscribeSideTerminalInputErrors(termId, () => {
        if (!alive) return;
        setInputError(t('ui.session-workspace.terminal-input-failed'));
      });

      // 先订阅流式输出再 open，避免首行提示符丢失
      const unsubscribe = subscribeSideTerminal(termId, {
        onData: (chunk) => {
          if (!alive || !chunk.bytes.length) return;
          const out = cursor.push(chunk);
          if (out && out.length > 0) term.write(out);
        },
        onExit: (ev) => {
          if (!alive) return;
          if (activeGen !== undefined && ev.generation !== undefined && ev.generation !== activeGen) {
            return;
          }
          if (!streamReady) {
            pendingExit = ev;
            return;
          }
          setExitInfo(ev);
        },
      });

      const req = initialReqRef.current;
      initialReqRef.current = { ...req, replace: false };
      void sideTerminalHost
        .open({
          id: termId,
          projectId: req.explicitCwd ? undefined : req.projectId,
          cwd: req.cwd,
          explicitCwd: req.explicitCwd,
          cols: initialCols,
          rows: initialRows,
          ...(req.replace ? { replace: true } : {}),
        })
        .then((res) => {
          if (!alive) return;
          if (!res.ok) {
            setErrorMsg(formatTerminalErrorReason(res.reason, res.message));
            return;
          }
          activeGen = res.generation;
          activeGenRef.current = res.generation;
          if (res.cwd) {
            setActiveCwd(res.cwd);
          }
          if (res.shell) setShellName(res.shell);

          const replayBytes = res.replay ? decodeTerminalBytes(res.replay) : new Uint8Array(0);
          for (const chunk of cursor.applyOpen(replayBytes, {
            generation: res.generation,
            replayOffset: res.replayOffset,
          })) {
            if (chunk.length > 0) term.write(chunk);
          }
          streamReady = true;

          if (res.exited) {
            setExitInfo({
              id: termId,
              generation: res.generation,
              exitCode: res.exitCode,
            });
          } else if (pendingExit) {
            if (
              activeGen === undefined ||
              pendingExit.generation === undefined ||
              pendingExit.generation === activeGen
            ) {
              setExitInfo(pendingExit);
            }
            pendingExit = null;
          }

          if (!hiddenRef.current) {
            syncSize();
            if (isActiveRef.current) term.focus();
          }
        });

      let resizeTimer: number | null = null;
      const ro =
        typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => {
              if (hiddenRef.current) return;
              if (resizeTimer !== null) window.clearTimeout(resizeTimer);
              resizeTimer = window.setTimeout(() => {
                resizeTimer = null;
                syncSize();
              }, 40);
            })
          : null;
      ro?.observe(container);

      const mo = new MutationObserver(() => {
        const next = readXtermTheme();
        term.options.theme = next.theme;
        term.options.fontFamily = next.fontFamily;
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class', 'style'],
      });

      return () => {
        alive = false;
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        ro?.disconnect();
        mo.disconnect();
        disposeInput.dispose();
        unsubscribeInputErrors();
        unsubscribe();
        term.dispose();
        if (termRef.current === term) termRef.current = null;
        if (fitRef.current === fitAddon) fitRef.current = null;
      };
    }, [hostAvailable, termId, runSeq, syncSize]);

    useEffect(() => {
      if (hidden) return;
      const raf = window.requestAnimationFrame(() => {
        syncSize();
        if (isActive && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
          termRef.current?.focus();
        }
      });
      return () => window.cancelAnimationFrame(raf);
    }, [hidden, isActive, syncSize]);

    const restartWithDir = useCallback(
      (nextCwd: string | undefined, explicit: boolean) => {
        const closingGen = activeGenRef.current;
        activeGenRef.current = undefined;
        void sideTerminalHost.close(termId, closingGen);
        setErrorMsg(null);
        setNoticeMsg(null);
        setExitInfo(null);
        setExplicitCwdFlag(explicit);
        if (nextCwd) setActiveCwd(nextCwd);
        initialReqRef.current = {
          projectId: explicit ? undefined : (projectId ?? undefined),
          cwd: nextCwd,
          explicitCwd: explicit,
          replace: true,
        };
        setRunSeq((n) => n + 1);
      },
      [termId, projectId],
    );

    const handleRestart = useCallback(() => {
      if (activeCwdRef.current) {
        restartWithDir(activeCwdRef.current, explicitCwdRef.current);
      } else {
        restartWithDir(defaultCwd || undefined, false);
      }
    }, [defaultCwd, restartWithDir]);

    useEffect(() => {
      registerHandle(paneId, {
        focus: () => termRef.current?.focus(),
        clear: () => {
          termRef.current?.clear();
          termRef.current?.focus();
        },
        restart: handleRestart,
        restartWithDir,
        getCwd: () => activeCwdRef.current,
        isExplicitCwd: () => explicitCwdRef.current,
      });
      return () => registerHandle(paneId, null);
    }, [paneId, registerHandle, handleRestart, restartWithDir]);

    return (
      <div
        className={styles.paneSlot}
        data-testid="terminal-pane"
        data-pane-id={paneId}
        data-active={isActive}
        data-multi={isMulti}
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
        }}
        onPointerDown={() => {
          if (!isActive) onFocusPane(paneId);
          else termRef.current?.focus();
        }}
      >
        {displayError ? (
          <div className={styles.fallback} data-testid="terminal-error">
            <Icon icon={TerminalIcon} size={28} />
            <p className={styles.fallbackMsg}>{displayError}</p>
            {hostAvailable ? (
              <button type="button" className={styles.bannerBtn} onClick={handleRestart}>
                {t('ui.session-workspace.terminal-restart')}
              </button>
            ) : null}
          </div>
        ) : (
          <div className={styles.surfaceWrap}>
            <div ref={hostRef} className={styles.terminalHost} data-testid="terminal-xterm-host" />
          </div>
        )}

        {inputError && !displayError ? (
          <div
            className={styles.banner}
            data-tone="danger"
            role="alert"
            data-testid="terminal-input-error"
          >
            <span>{inputError}</span>
            <button
              type="button"
              className={styles.bannerBtn}
              aria-label={t('ui.foundation.dismiss-error')}
              onClick={() => setInputError(null)}
            >
              {t('ui.providers-schedule.close')}
            </button>
          </div>
        ) : null}

        {noticeMsg ? (
          <div className={styles.banner} data-tone="danger" role="status">
            <span>{noticeMsg}</span>
            <button
              type="button"
              className={styles.bannerBtn}
              aria-label={t('ui.foundation.dismiss-error')}
              onClick={() => setNoticeMsg(null)}
            >
              {t('ui.providers-schedule.close')}
            </button>
          </div>
        ) : null}

        {exitInfo && !displayError ? (
          <div className={styles.banner} role="status" data-testid="terminal-exit-banner">
            <span>
              {typeof exitInfo.exitCode === 'number'
                ? t('ui.session-workspace.terminal-exited', exitInfo.exitCode)
                : t('ui.session-workspace.terminal-exited-simple')}
            </span>
            <button type="button" className={styles.bannerBtn} onClick={handleRestart}>
              {t('ui.session-workspace.terminal-restart')}
            </button>
          </div>
        ) : null}
      </div>
    );
  },
);
TerminalPane.displayName = 'TerminalPane';

interface SplitDividerProps {
  divider: DividerBox;
  stageRef: React.RefObject<HTMLDivElement | null>;
  onRatio: (splitId: string, ratio: number) => void;
  onDraggingChange: (dragging: boolean) => void;
}

const SplitDivider: React.FC<SplitDividerProps> = ({
  divider,
  stageRef,
  onRatio,
  onDraggingChange,
}) => {
  const dragRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const isHorizontal = divider.direction === 'horizontal';
  const posStyle: React.CSSProperties = isHorizontal
    ? {
        left: `${divider.x * 100}%`,
        top: `${divider.y * 100}%`,
        height: `${divider.length * 100}%`,
      }
    : {
        left: `${divider.x * 100}%`,
        top: `${divider.y * 100}%`,
        width: `${divider.length * 100}%`,
      };

  const computeRatioFromPointer = (clientX: number, clientY: number): number | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const box = stage.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const cr = divider.containerRect;
    if (isHorizontal) {
      const w = cr.w * box.width;
      if (w <= 0) return null;
      const left = box.left + cr.x * box.width;
      return (clientX - left) / w;
    }
    const h = cr.h * box.height;
    if (h <= 0) return null;
    const top = box.top + cr.y * box.height;
    return (clientY - top) / h;
  };

  return (
    <div
      className={styles.splitDivider}
      style={posStyle}
      role="separator"
      tabIndex={0}
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      aria-label={t('ui.session-workspace.terminal-split-handle')}
      aria-valuemin={Math.round(TERMINAL_SPLIT_MIN_RATIO * 100)}
      aria-valuemax={Math.round(TERMINAL_SPLIT_MAX_RATIO * 100)}
      aria-valuenow={Math.round(divider.ratio * 100)}
      data-testid="terminal-split-divider"
      data-direction={divider.direction}
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        dragRef.current = true;
        setDragging(true);
        onDraggingChange(true);
      }}
      onPointerMove={(e) => {
        if (!dragRef.current) return;
        const next = computeRatioFromPointer(e.clientX, e.clientY);
        if (next !== null) onRatio(divider.splitId, next);
      }}
      onPointerUp={() => {
        if (!dragRef.current) return;
        dragRef.current = false;
        setDragging(false);
        onDraggingChange(false);
      }}
      onPointerCancel={() => {
        if (!dragRef.current) return;
        dragRef.current = false;
        setDragging(false);
        onDraggingChange(false);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRatio(divider.splitId, 0.5);
      }}
      onKeyDown={(e) => {
        if (isHorizontal && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          onRatio(divider.splitId, divider.ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        } else if (!isHorizontal && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onRatio(divider.splitId, divider.ratio + (e.key === 'ArrowUp' ? -0.05 : 0.05));
        }
      }}
    />
  );
};

export interface TerminalTabProps {
  tabKey: string;
  pageId: string;
  projectId?: string | null;
  defaultCwd?: string | null;
  cwd?: string;
  layout?: TerminalPaneNode;
  activePaneId?: string;
  hidden?: boolean;
  onMeta: (patch: { cwd?: string; title?: string; shell?: string }) => void;
  onLayoutChange?: (layout: TerminalPaneNode, activePaneId?: string) => void;
  onRequestCloseTab?: () => void;
  registerControl?: (ctrl: TerminalTabController | null) => void;
}

const TerminalTab: React.FC<TerminalTabProps> = ({
  tabKey,
  pageId,
  projectId,
  defaultCwd,
  cwd,
  layout,
  activePaneId,
  hidden = false,
  onMeta,
  onLayoutChange,
  onRequestCloseTab,
  registerControl,
}) => {
  const hostAvailable = sideTerminalHost.available();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [uncontrolledLayout, setUncontrolledLayout] = useState<TerminalPaneNode>(() =>
    createRootPane(pageId, cwd),
  );
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState<string>(pageId);

  const effectiveLayout = useMemo(() => layout ?? uncontrolledLayout, [layout, uncontrolledLayout]);
  const paneIds = useMemo(() => collectPaneIds(effectiveLayout), [effectiveLayout]);
  const rawActiveId = activePaneId ?? uncontrolledActiveId;
  const resolvedActivePaneId =
    rawActiveId && paneIds.includes(rawActiveId) ? rawActiveId : paneIds[0]!;
  const activeIndex = Math.max(0, paneIds.indexOf(resolvedActivePaneId));
  const computed = useMemo(() => computeSplitLayout(effectiveLayout), [effectiveLayout]);

  const [paneStates, setPaneStates] = useState<Record<string, PaneRuntimeState>>({});
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
  const [draggingDivider, setDraggingDivider] = useState(false);

  const paneHandlesRef = useRef<Map<string, PaneHandle>>(new Map());
  const closingPanesRef = useRef<Set<string>>(new Set());

  const onMetaRef = useRef(onMeta);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const onRequestCloseTabRef = useRef(onRequestCloseTab);
  const registerControlRef = useRef(registerControl);
  const effectiveLayoutRef = useRef(effectiveLayout);
  const paneIdsRef = useRef(paneIds);
  const activePaneIdRef = useRef(resolvedActivePaneId);
  const hiddenRef = useRef(hidden);
  const defaultCwdRef = useRef(defaultCwd);

  useEffect(() => {
    onMetaRef.current = onMeta;
    onLayoutChangeRef.current = onLayoutChange;
    onRequestCloseTabRef.current = onRequestCloseTab;
    registerControlRef.current = registerControl;
    effectiveLayoutRef.current = effectiveLayout;
    paneIdsRef.current = paneIds;
    activePaneIdRef.current = resolvedActivePaneId;
    hiddenRef.current = hidden;
    defaultCwdRef.current = defaultCwd;
  });

  const commitLayout = useCallback((nextLayout: TerminalPaneNode, nextActiveId: string) => {
    effectiveLayoutRef.current = nextLayout;
    paneIdsRef.current = collectPaneIds(nextLayout);
    activePaneIdRef.current = nextActiveId;
    setUncontrolledLayout(nextLayout);
    setUncontrolledActiveId(nextActiveId);
    onLayoutChangeRef.current?.(nextLayout, nextActiveId);
  }, []);

  const focusPane = useCallback((paneId: string) => {
    if (!paneIdsRef.current.includes(paneId)) return;
    activePaneIdRef.current = paneId;
    setUncontrolledActiveId(paneId);
    onLayoutChangeRef.current?.(effectiveLayoutRef.current, paneId);
    paneHandlesRef.current.get(paneId)?.focus();
  }, []);

  const handlePaneStateChange = useCallback((paneId: string, state: PaneRuntimeState) => {
    setPaneStates((prev) => {
      const old = prev[paneId];
      if (
        old &&
        old.cwd === state.cwd &&
        old.shell === state.shell &&
        old.dotState === state.dotState &&
        old.explicitCwd === state.explicitCwd
      ) {
        return prev;
      }
      return { ...prev, [paneId]: state };
    });
  }, []);

  const registerHandle = useCallback((paneId: string, handle: PaneHandle | null) => {
    if (handle) paneHandlesRef.current.set(paneId, handle);
    else paneHandlesRef.current.delete(paneId);
  }, []);

  const activePaneMeta = paneStates[resolvedActivePaneId];
  const activeCwd =
    activePaneMeta?.cwd ?? findPane(effectiveLayout, resolvedActivePaneId)?.cwd ?? defaultCwd ?? '';
  const activeShell = activePaneMeta?.shell ?? 'shell';
  const activeDotState = activePaneMeta?.dotState ?? (hostAvailable ? 'running' : 'error');

  // 聚焦窗格的目录变化时同步顶部工作区标签名字
  useEffect(() => {
    if (!activeCwd) return;
    onMetaRef.current({
      cwd: activeCwd,
      title: basename(activeCwd) || activeShell || undefined,
      shell: activeShell,
    });
  }, [activeCwd, activeShell]);

  const handleSplit = useCallback(
    (direction: SplitDirection) => {
      const currentLayout = effectiveLayoutRef.current;
      if (collectPaneIds(currentLayout).length >= MAX_TERMINAL_PANES) return;
      const targetId = activePaneIdRef.current;
      const handle = paneHandlesRef.current.get(targetId);
      const leaf = findPane(currentLayout, targetId);
      const inheritCwd = handle?.getCwd() || leaf?.cwd || defaultCwdRef.current || undefined;
      const inheritExplicit = handle ? handle.isExplicitCwd() : Boolean(leaf?.explicitCwd);
      const newPaneId = newWorkspaceId();
      const nextLayout = splitPane(currentLayout, targetId, direction, newPaneId, {
        cwd: inheritCwd,
        explicitCwd: inheritExplicit,
      });
      if (nextLayout === currentLayout) return;
      commitLayout(nextLayout, newPaneId);
    },
    [commitLayout],
  );

  const handleClosePane = useCallback(
    async (paneId: string) => {
      if (paneIdsRef.current.length <= 1) {
        onRequestCloseTabRef.current?.();
        return;
      }
      if (closingPanesRef.current.has(paneId)) return;

      const termId = sideTerminalIdFor(paneId);
      if (isTerminalRunning(termId)) {
        closingPanesRef.current.add(paneId);
        let confirmed: boolean;
        try {
          confirmed = await confirmDialog({
            title: t('ui.session-workspace.terminal-close-confirm-title'),
            message: t('ui.session-workspace.terminal-close-confirm-message'),
            confirmLabel: t('ui.session-workspace.terminal-close-confirm-action'),
            danger: true,
          });
        } finally {
          closingPanesRef.current.delete(paneId);
        }
        if (!confirmed) {
          paneHandlesRef.current.get(activePaneIdRef.current)?.focus();
          return;
        }
      }

      const latest = effectiveLayoutRef.current;
      if (!findPane(latest, paneId)) return;
      const res = closePane(latest, paneId);
      sideTerminalHost.close(termId);
      setPaneStates((prev) => {
        if (!(paneId in prev)) return prev;
        const rest = { ...prev };
        delete rest[paneId];
        return rest;
      });
      if (!res.root) {
        onRequestCloseTabRef.current?.();
        return;
      }
      const nextFocus =
        res.nextFocusId ??
        (paneIdsRef.current.find((id) => id !== paneId) || collectPaneIds(res.root)[0]!);
      commitLayout(res.root, nextFocus);
    },
    [commitLayout],
  );

  const handleRatioChange = useCallback(
    (splitId: string, ratio: number) => {
      const next = setTerminalSplitRatio(effectiveLayoutRef.current, splitId, ratio);
      if (next !== effectiveLayoutRef.current) {
        commitLayout(next, activePaneIdRef.current);
      }
    },
    [commitLayout],
  );

  // 向外层 SideWorkspace 暴露控制句柄（多窗格时 ⌘W 仅关闭当前聚焦窗格）
  useEffect(() => {
    registerControlRef.current?.({
      paneCount: () => paneIdsRef.current.length,
      closeActivePane: () => {
        void handleClosePane(activePaneIdRef.current);
      },
    });
    return () => {
      registerControlRef.current?.(null);
    };
  }, [tabKey, handleClosePane]);

  // 键盘捕获：分屏（⌘D / ⇧⌘D 或 Win/Linux Ctrl+Shift+D / Alt+Shift+D）与窗格焦点切换
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hiddenRef.current || e.defaultPrevented || isImeComposing(e)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !rootRef.current?.contains(target)) return;

      const mac = isMac();
      if (isSplitRightShortcut(e, mac)) {
        e.preventDefault();
        e.stopPropagation();
        handleSplit('horizontal');
        return;
      }
      if (isSplitDownShortcut(e, mac)) {
        e.preventDefault();
        e.stopPropagation();
        handleSplit('vertical');
        return;
      }
      if (paneIdsRef.current.length <= 1) return;

      const navDir = matchNavDirection(e, mac);
      if (navDir) {
        const nextId = navigatePane(effectiveLayoutRef.current, activePaneIdRef.current, navDir);
        if (nextId) {
          e.preventDefault();
          e.stopPropagation();
          focusPane(nextId);
        }
        return;
      }

      const cycleDir = matchCycleDirection(e, mac);
      if (cycleDir) {
        const nextId = cyclePaneId(effectiveLayoutRef.current, activePaneIdRef.current, cycleDir);
        if (nextId && nextId !== activePaneIdRef.current) {
          e.preventDefault();
          e.stopPropagation();
          focusPane(nextId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleSplit, focusPane]);

  const handleChangeDir = useCallback(async () => {
    const targetId = activePaneIdRef.current;
    const currentCwd = paneHandlesRef.current.get(targetId)?.getCwd() || undefined;
    const picked = await harnessClient.pickDir(currentCwd).catch(() => null);
    if (!picked) return;
    const nextLayout = updatePaneLeaf(effectiveLayoutRef.current, targetId, {
      cwd: picked,
      explicitCwd: true,
    });
    commitLayout(nextLayout, targetId);
    paneHandlesRef.current.get(targetId)?.restartWithDir(picked, true);
  }, [commitLayout]);

  const handleClear = useCallback(() => {
    paneHandlesRef.current.get(activePaneIdRef.current)?.clear();
  }, []);

  const handleRestart = useCallback(() => {
    paneHandlesRef.current.get(activePaneIdRef.current)?.restart();
  }, []);

  const handleOpenExternal = useCallback(() => {
    setNoticeMsg(null);
    openProjectTerminal(activeCwd || null, (msg) => setNoticeMsg(msg));
  }, [activeCwd]);

  const mac = isMac();
  const splitRightShortcut = mac ? '⌘D' : 'Ctrl+Shift+D';
  const splitDownShortcut = mac ? '⇧⌘D' : 'Alt+Shift+D';
  const splitLimitReached = paneIds.length >= MAX_TERMINAL_PANES;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      hidden={hidden}
      data-testid="terminal-tab"
      data-tab-key={tabKey}
      data-terminal-surface=""
    >
      <div className={styles.toolbar}>
        <div className={styles.meta}>
          <span className={styles.statusDot} data-state={activeDotState} aria-hidden="true" />
          <span className={styles.shellBadge}>{activeShell}</span>
          {paneIds.length > 1 ? (
            <span className={styles.paneCounter} data-testid="terminal-pane-counter">
              {activeIndex + 1}/{paneIds.length}
            </span>
          ) : null}
          {activeCwd ? (
            <span className={styles.cwdText} title={activeCwd} data-testid="terminal-cwd">
              {activeCwd}
            </span>
          ) : null}
        </div>
        <div className={styles.actions}>
          <IconButton
            size="sm"
            label={t('ui.session-workspace.terminal-split-right', splitRightShortcut)}
            icon={<Icon icon={ColumnsSplit} size={14} />}
            disabled={splitLimitReached}
            onClick={() => handleSplit('horizontal')}
            data-testid="terminal-split-right"
          />
          <IconButton
            size="sm"
            label={t('ui.session-workspace.terminal-split-down', splitDownShortcut)}
            icon={<Icon icon={RowsSplit} size={14} />}
            disabled={splitLimitReached}
            onClick={() => handleSplit('vertical')}
            data-testid="terminal-split-down"
          />
          {paneIds.length > 1 ? (
            <IconButton
              size="sm"
              label={t('ui.session-workspace.terminal-close-pane')}
              icon={<Icon icon={CloseIcon} size={14} />}
              onClick={() => void handleClosePane(resolvedActivePaneId)}
              data-testid="terminal-pane-close"
            />
          ) : null}
          <span className={styles.toolbarDivider} aria-hidden="true" />
          {hostAvailable ? (
            <IconButton
              size="sm"
              label={t('ui.session-workspace.terminal-change-dir')}
              icon={<Icon icon={FolderOpen} size={14} />}
              onClick={() => void handleChangeDir()}
              data-testid="terminal-change-dir"
            />
          ) : null}
          <IconButton
            size="sm"
            label={t('ui.session-workspace.terminal-clear')}
            icon={<Icon icon={Eraser} size={14} />}
            onClick={handleClear}
            data-testid="terminal-clear"
          />
          <IconButton
            size="sm"
            label={t('ui.session-workspace.terminal-restart')}
            icon={<Icon icon={RotateCw} size={14} />}
            onClick={handleRestart}
            data-testid="terminal-restart"
          />
          {hostAvailable ? (
            <IconButton
              size="sm"
              label={t('ui.session-workspace.terminal-open-external')}
              icon={<Icon icon={ExternalLink} size={14} />}
              disabled={!activeCwd}
              onClick={handleOpenExternal}
              data-testid="terminal-open-external"
            />
          ) : null}
        </div>
      </div>

      {noticeMsg ? (
        <div className={styles.banner} data-tone="danger" role="status">
          <span>{noticeMsg}</span>
          <button
            type="button"
            className={styles.bannerBtn}
            aria-label={t('ui.foundation.dismiss-error')}
            onClick={() => setNoticeMsg(null)}
          >
            {t('ui.providers-schedule.close')}
          </button>
        </div>
      ) : null}

      <div
        ref={stageRef}
        className={styles.splitStage}
        data-testid="terminal-split-stage"
        data-dragging={draggingDivider || undefined}
      >
        {computed.panes.map((box) => (
          <TerminalPane
            key={box.paneId}
            leaf={box.leaf}
            rect={box.rect}
            projectId={projectId}
            defaultCwd={defaultCwd}
            hidden={hidden}
            isActive={box.paneId === resolvedActivePaneId}
            isMulti={paneIds.length > 1}
            onFocusPane={focusPane}
            onStateChange={handlePaneStateChange}
            registerHandle={registerHandle}
          />
        ))}
        {computed.dividers.map((div) => (
          <SplitDivider
            key={div.splitId}
            divider={div}
            stageRef={stageRef}
            onRatio={handleRatioChange}
            onDraggingChange={setDraggingDivider}
          />
        ))}
      </div>
    </div>
  );
};

export default TerminalTab;
