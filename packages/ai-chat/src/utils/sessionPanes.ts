/**
 * 主区里的会话面板（C-style 并排会话）：[会话 A | 会话 B] | 唯一的工作区。
 *
 * 纯数据 + 纯函数，不依赖 React：
 * - 最多两个面板（与截图一致）：单面板时铺满主对话列，两个面板左右并排，中间的宽窄可拖；
 * - 每个面板绑定一个 sessionKey（nomi:<id> / cli:<backend>:<会话 id> / tab:<标签 id>），
 *   两个面板的 sessionKey 必须不同（同一会话不能同时出现在两个面板里）；
 * - 面板绑定的会话可以来自不同项目：眼光标面板与 ConversationStore 的 currentId 同步，
 *   其余面板按自己的 sessionKey 读消息，互不替换；
 * - 文件区（SideWorkspace）不是面板的一部分：它是 App 里的唯一一份，打开文件永远覆盖到那一份。
 */
import { cliTranscriptKey } from '../services/transcriptView';

/** 最多并排的会话面板数 */
export const MAX_SESSION_PANES = 2;

/**
 * 面板 id 跟位置（不是跟会话）：左面板永远是 pane-a、右面板永远是 pane-b。
 * 换会话不换 id —— 面板组件不因此重挂，输入框、滚动位置都留着；左右交换时两边的会话跟着格子走。
 */
export const PANE_A = 'pane-a';
export const PANE_B = 'pane-b';

export interface SessionPane {
  id: string;
  /** 这个面板显示的会话（见 cliTranscriptKey / nomi:<id>）；空会话（还没拿到会话 id）为 null */
  sessionKey: string | null;
}

export interface SessionPanesState {
  /** 至少一个；顺序就是左右顺序（[0] 在左） */
  panes: SessionPane[];
  focusedPaneId: string;
}

/** 左面板占两个面板可用宽度的比例（拖动后记住） */
export const PANE_RATIO_DEFAULT = 0.5;
/** 拖动比例下限 / 上限：两边都留得出输入框与消息列 */
export const PANE_RATIO_MIN = 0.25;
export const PANE_RATIO_MAX = 0.75;

export const clampPaneRatio = (n: number): number =>
  Math.round(Math.min(PANE_RATIO_MAX, Math.max(PANE_RATIO_MIN, n)) * 10000) / 10000;

/** 两个面板之间的序列键：会话快照变化时用它判断「要不要落盘」 */
export const paneKeysKey = (panes: readonly SessionPane[]): string =>
  panes.map((p) => p.sessionKey ?? '').join('\u0000');

/** 并排中？（两个面板且绑定的会话不同） */
export const isPanesSplit = (panes: readonly SessionPane[]): boolean => panes.length > 1;

/** 按 id 找面板 */
export const findPane = (state: SessionPanesState, id: string): SessionPane | undefined =>
  state.panes.find((p) => p.id === id);

/** 按 sessionKey 找面板：侧栏点会话时先看它是不是已经开在某个面板里 */
export const paneForSession = (
  state: SessionPanesState,
  sessionKey: string | null,
): SessionPane | undefined =>
  sessionKey ? state.panes.find((p) => p.sessionKey && p.sessionKey === sessionKey) : undefined;

/** 焦点面板（焦点面板被关后 state 会改指到剩下的那个） */
export const focusedPane = (state: SessionPanesState): SessionPane =>
  findPane(state, state.focusedPaneId) ?? state.panes[0]!;

/** 另一个面板（焦点面板之外的那个）；单面板时 undefined */
export const otherPane = (state: SessionPanesState): SessionPane | undefined => {
  const focus = focusedPane(state);
  return state.panes.find((p) => p.id !== focus.id);
};

/**
 * 指向某个会话、但不含目标的单面板状态：一个空面板，或只开着另一个会话的面板。
 * （目标会话已经开在某个面板里时不该出现空的面板。）
 */
export function singlePaneFor(
  current: SessionPanesState,
  sessionKey: string | null,
): SessionPanesState {
  if (sessionKey && paneForSession(current, sessionKey)) return current;
  // 冷启动恢复拆分时，currentKey 尚未就绪（null）不能清空已恢复的拆分状态
  if (sessionKey === null && current.panes.length > 1) return current;
  if (current.panes.length === 1 && current.panes[0]!.sessionKey === sessionKey) return current;
  return { panes: [{ id: PANE_A, sessionKey }], focusedPaneId: PANE_A };
}

/**
 * 运行中「当前会话」在面板外部发生变化（如新建对话、灵动岛跳转、关掉 CLI 标签）：
 * - 已开在某个面板里：只聚焦那个面板（保持拆分）；
 * - 没开：只替换焦点面板（保持另一个面板不塌缩）。
 */
export function syncExternalSession(
  current: SessionPanesState,
  sessionKey: string | null,
): SessionPanesState {
  if (!sessionKey) return current;
  const hit = paneForSession(current, sessionKey);
  if (hit) return focusPane(current, hit.id);
  return openSessionInFocus(current, sessionKey);
}

/** 把一个面板绑到会话上（同值返回原对象，不触发重渲染） */
function bind(pane: SessionPane, sessionKey: string | null): SessionPane {
  return pane.sessionKey === sessionKey ? pane : { ...pane, sessionKey };
}

/** 取消拆分：只留下一个面板（缺省是焦点面板），它铺满主对话列 */
export function collapseSplit(state: SessionPanesState, keepPaneId?: string): SessionPanesState {
  const keep = findPane(state, keepPaneId ?? state.focusedPaneId) ?? focusedPane(state);
  // 单面板永远是 pane-a（铺满主对话列），不顶着 pane-b 的 id
  return { panes: [bind({ ...keep, id: PANE_A }, keep.sessionKey)], focusedPaneId: PANE_A };
}

/** 点某个面板让它获得焦点（焦点面板同步 currentId / activeTabId） */
export function focusPane(state: SessionPanesState, id: string): SessionPanesState {
  if (!findPane(state, id) || state.focusedPaneId === id) return state;
  return { ...state, focusedPaneId: id };
}

/**
 * 焦点面板换成 sessionKey：
 * - 目标已在另一个面板里打开：把焦点给那个面板（同一会话不同时出现在两个面板），不抢别的面板的会话；
 * - 否则只改焦点面板；另一个面板（跨项目的也可以）保持原样。
 */
export function setPaneSession(
  state: SessionPanesState,
  paneId: string,
  sessionKey: string | null,
): SessionPanesState {
  const shown = sessionKey ? paneForSession(state, sessionKey) : undefined;
  if (shown && shown.id !== paneId) return focusPane(state, shown.id);
  const panes = state.panes.map((p) => (p.id === paneId ? bind(p, sessionKey) : p));
  return panes.every((p, i) => p === state.panes[i]) ? state : { ...state, panes };
}

/**
 * 侧栏单击会话：
 * - 若已拆分且当前焦点面板已有会话、另一面板为空面板：把新会话填入那个空面板并切过去；
 * - 已开在某个面板里：聚焦那个面板，别的面板不动；
 * - 没开：把焦点面板换成它（另一个面板不动）。
 */
export function openSessionInFocus(
  state: SessionPanesState,
  sessionKey: string | null,
): SessionPanesState {
  if (sessionKey && !paneForSession(state, sessionKey) && state.panes.length > 1) {
    const focus = focusedPane(state);
    const empty = otherPane(state);
    if (focus.sessionKey !== null && empty && empty.sessionKey === null) {
      return focusPane(setPaneSession(state, empty.id, sessionKey), empty.id);
    }
  }
  return setPaneSession(state, focusedPane(state).id, sessionKey);
}

/** 拖放分屏的目标侧 */
export type SessionPaneSide = 'left' | 'right';

/**
 * 「向右打开 / Open to the side」（与 Cursor 一致）：
 * - 还没拆分：新会话放右面板，左面板保持原来的会话（右侧没有可对比的会话时，左边就是焦点面板）；
 * - 已经拆分：右面板换成它（右面板正显示同一个会话时只聚焦）；
 * - 要打开的会话已经在左面板里：把左右交换，它到右边、原来的右面板内容换到左边，仍是一左一右。
 */
export function openSessionToSide(
  state: SessionPanesState,
  sessionKey: string | null,
): SessionPanesState {
  const [first] = state.panes;
  if (!first) return state;
  if (state.panes.length < MAX_SESSION_PANES) {
    // 同一会话不能同时出现在两个面板里
    if (sessionKey !== null && first.sessionKey === sessionKey) return state;
    return {
      panes: [first, { id: PANE_B, sessionKey }],
      focusedPaneId: PANE_B,
    };
  }
  const left = state.panes[0]!;
  const right = state.panes[1]!;
  if (sessionKey !== null && left.sessionKey === sessionKey) {
    // 交换两边的内容（id 跟着位置）；「向右打开」的那个会话到了右边，焦点也跟着它到右边
    return {
      panes: [bind(left, right.sessionKey), bind(right, left.sessionKey)],
      focusedPaneId: right.id,
    };
  }
  if (right.sessionKey === sessionKey) {
    return state.focusedPaneId === right.id ? state : { ...state, focusedPaneId: right.id };
  }
  return { panes: [left, bind(right, sessionKey)], focusedPaneId: right.id };
}

/**
 * 拖放会话到主区左半或右半（复刻拖拽分屏）：
 * - 单面板时：
 *   - 拖的是当前会话：把它固定到落点那一侧，另一侧拆出空面板等待选会话；
 *   - 拖的是别的会话：`right` 与「向右打开」一致；`left` 把新会话放左面板、原会话顺移到右面板；
 * - 已拆分时：`right` 与「向右打开」一致；`left` 若已在右面板则左右交换，否则替换左面板并聚焦它。
 */
export function openSessionOnSide(
  state: SessionPanesState,
  sessionKey: string | null,
  side: SessionPaneSide,
): SessionPanesState {
  const [first] = state.panes;
  if (!first) return state;
  if (state.panes.length < MAX_SESSION_PANES) {
    if (sessionKey !== null && first.sessionKey === sessionKey) {
      return side === 'left'
        ? {
            panes: [
              { id: PANE_A, sessionKey },
              { id: PANE_B, sessionKey: null },
            ],
            focusedPaneId: PANE_A,
          }
        : {
            panes: [
              { id: PANE_A, sessionKey: null },
              { id: PANE_B, sessionKey },
            ],
            focusedPaneId: PANE_B,
          };
    }
    if (side === 'right') return openSessionToSide(state, sessionKey);
    return {
      panes: [
        { id: PANE_A, sessionKey },
        { id: PANE_B, sessionKey: first.sessionKey },
      ],
      focusedPaneId: PANE_A,
    };
  }
  if (side === 'right') return openSessionToSide(state, sessionKey);
  const left = state.panes[0]!;
  const right = state.panes[1]!;
  if (sessionKey !== null && right.sessionKey === sessionKey) {
    return {
      panes: [bind(left, right.sessionKey), bind(right, left.sessionKey)],
      focusedPaneId: left.id,
    };
  }
  if (left.sessionKey === sessionKey) {
    return state.focusedPaneId === left.id ? state : { ...state, focusedPaneId: left.id };
  }
  return { panes: [bind(left, sessionKey), right], focusedPaneId: left.id };
}

/** 判断把某会话拖放到主区指定侧是否有效（单面板均可拆出，已拆分时不放回自己已所在的侧） */
export function canDropSessionOnSide(
  state: SessionPanesState,
  sessionKey: string | null,
  side: SessionPaneSide,
): boolean {
  if (!sessionKey) return false;
  if (state.panes.length < MAX_SESSION_PANES) return true;
  const target = side === 'left' ? state.panes[0] : state.panes[1];
  return target?.sessionKey !== sessionKey;
}

/**
 * 面板标题栏的「拆分 / 布局」按钮：
 * - 单面板：在右边开一个空面板（同一会话不能同时出现在两个面板里），焦点到右边等着选会话；
 * - 已拆分：只把焦点移到另一个面板。
 */
export const splitFromFocused = (state: SessionPanesState): SessionPanesState => {
  const focus = focusedPane(state);
  if (state.panes.length > 1) return focusPane(state, otherPane(state)?.id ?? focus.id);
  return openSessionToSide(state, null);
};

/** 关掉一个面板：剩一个时回到单面板（剩下的铺满主对话列）；关焦点面板时焦点给相邻的 */
export function closePane(state: SessionPanesState, paneId: string): SessionPanesState {
  const index = state.panes.findIndex((p) => p.id === paneId);
  if (index < 0 || state.panes.length <= 1) return state; // 至少留一个面板
  const rest = state.panes.filter((p) => p.id !== paneId);
  if (rest.length === 1) return collapseSplit(state, rest[0]!.id);
  // 面板 id 跟位置：剩下的重新编号（中间拿掉一个时右边补上来）
  const panes = rest.map((p, i) => ({ ...p, id: i === 0 ? PANE_A : PANE_B }));
  const focusedPaneId =
    state.focusedPaneId === paneId
      ? panes[Math.max(0, index - 1)]!.id
      : (panes.find((p) => p.id === state.focusedPaneId)?.id ?? panes[0]!.id);
  return { panes, focusedPaneId };
}

/**
 * 会话没了（被删除 / 归档 / CLI 标签关掉）：把这个会话从面板里摘掉。
 * 单面板时留下一个空面板（空会话）；并排时关掉那个面板，剩下的回到单面板。
 */
export function dropSession(state: SessionPanesState, sessionKey: string): SessionPanesState {
  const hit = paneForSession(state, sessionKey);
  if (!hit) return state;
  if (state.panes.length > 1) return closePane(state, hit.id);
  return setPaneSession(state, hit.id, null);
}

/** 从 cliTranscriptKey 的会话键判断是哪种会话 */
export function parseSessionKey(
  key: string | null,
):
  | { kind: 'nomi'; id: string }
  | { kind: 'cli'; backend: string; sessionId: string }
  | { kind: 'tab'; id: string }
  | null {
  if (!key) return null;
  if (key.startsWith('nomi:')) return { kind: 'nomi', id: key.slice('nomi:'.length) };
  if (key.startsWith('cli:')) {
    const rest = key.slice('cli:'.length);
    const i = rest.indexOf(':');
    if (i > 0) return { kind: 'cli', backend: rest.slice(0, i), sessionId: rest.slice(i + 1) };
    return null;
  }
  if (key.startsWith('tab:')) return { kind: 'tab', id: key.slice('tab:'.length) };
  return null;
}

/** 会话键里显式带的会话 id（nomi:<id> / cli:<backend>:<id>）；tab:<id> 是临时键，返回 undefined */
export const sessionIdOf = (key: string | null | undefined): string | undefined => {
  const parsed = parseSessionKey(key ?? null);
  if (!parsed || parsed.kind === 'tab') return undefined;
  return parsed.kind === 'nomi' ? parsed.id : parsed.sessionId;
};

/** Nomi 会话的会话键 */
export const nomiSessionKey = (id: string | null | undefined): string | null =>
  id ? `nomi:${id}` : null;

/** CLI 标签的会话键（与 App 的 useActiveSessionInfo 用同一套键） */
export const cliSessionKey = (tab: {
  id: string;
  backend: string;
  cliSessionId?: string | null;
}): string =>
  cliTranscriptKey({ id: tab.id, backend: tab.backend, cliSessionId: tab.cliSessionId ?? null });
