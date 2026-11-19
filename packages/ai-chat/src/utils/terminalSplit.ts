/**
 * 终端分屏二叉树与扁平几何投影布局（纯函数，零外部 UI/xterm 依赖，避免拉入首屏分包）。
 * - 支持参考 Ghostty 的递归二分分屏：horizontal（左右并排 ⌘D）与 vertical（上下堆叠 ⇧⌘D）；
 * - 通过 computeSplitLayout 将二叉树投影为归一化 [0, 1] 矩形列表与分隔条列表，供视图扁平渲染，
 *   确保在新建/关闭分屏时，已有终端窗格不会被 React 卸载重建。
 */

export const TERMINAL_SPLIT_MIN_RATIO = 0.15;
export const TERMINAL_SPLIT_MAX_RATIO = 0.85;
export const MAX_TERMINAL_PANES = 12;

export type SplitDirection = 'horizontal' | 'vertical';
export type PaneNavDirection = 'left' | 'right' | 'up' | 'down';

export interface TerminalPaneLeaf {
  kind: 'leaf';
  paneId: string;
  cwd?: string;
  explicitCwd?: boolean;
}

export interface TerminalPaneSplit {
  kind: 'split';
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: TerminalPaneNode;
  second: TerminalPaneNode;
}

export type TerminalPaneNode = TerminalPaneLeaf | TerminalPaneSplit;

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneBox {
  paneId: string;
  leaf: TerminalPaneLeaf;
  rect: NormalizedRect;
}

export interface DividerBox {
  splitId: string;
  direction: SplitDirection;
  ratio: number;
  containerRect: NormalizedRect;
  x: number;
  y: number;
  length: number;
}

export interface ComputedSplitLayout {
  panes: PaneBox[];
  dividers: DividerBox[];
}

export interface TerminalTabController {
  paneCount: () => number;
  closeActivePane: () => void;
}

export function clampTerminalSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(TERMINAL_SPLIT_MAX_RATIO, Math.max(TERMINAL_SPLIT_MIN_RATIO, ratio));
}

export function createRootPane(
  paneId: string,
  cwd?: string,
  explicitCwd?: boolean,
): TerminalPaneLeaf {
  return {
    kind: 'leaf',
    paneId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(explicitCwd !== undefined ? { explicitCwd } : {}),
  };
}

export function collectPaneIds(node: TerminalPaneNode): string[] {
  if (node.kind === 'leaf') return [node.paneId];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

export function countPanes(node: TerminalPaneNode): number {
  if (node.kind === 'leaf') return 1;
  return countPanes(node.first) + countPanes(node.second);
}

export function findPane(node: TerminalPaneNode, paneId: string): TerminalPaneLeaf | null {
  if (node.kind === 'leaf') return node.paneId === paneId ? node : null;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

export function splitPane(
  root: TerminalPaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
  opts?: { cwd?: string; explicitCwd?: boolean; splitId?: string },
): TerminalPaneNode {
  if (!targetPaneId || !newPaneId || countPanes(root) >= MAX_TERMINAL_PANES) return root;
  if (findPane(root, newPaneId)) return root;

  const replace = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.kind === 'leaf') {
      if (node.paneId !== targetPaneId) return node;
      const newLeaf: TerminalPaneLeaf = {
        kind: 'leaf',
        paneId: newPaneId,
        cwd: opts?.cwd !== undefined ? opts.cwd : node.cwd,
        explicitCwd: opts?.explicitCwd !== undefined ? opts.explicitCwd : node.explicitCwd,
      };
      return {
        kind: 'split',
        id: opts?.splitId ?? `split:${newPaneId}`,
        direction,
        ratio: 0.5,
        first: node,
        second: newLeaf,
      };
    }
    const nextFirst = replace(node.first);
    if (nextFirst !== node.first) return { ...node, first: nextFirst };
    const nextSecond = replace(node.second);
    if (nextSecond !== node.second) return { ...node, second: nextSecond };
    return node;
  };

  return replace(root);
}

export function closePane(
  root: TerminalPaneNode,
  targetPaneId: string,
): { root: TerminalPaneNode | null; nextFocusId: string | null } {
  if (root.kind === 'leaf') {
    return root.paneId === targetPaneId
      ? { root: null, nextFocusId: null }
      : { root, nextFocusId: root.paneId };
  }

  let nextFocusId: string | null = null;
  let removed = false;

  const walk = (node: TerminalPaneNode): TerminalPaneNode | null => {
    if (node.kind === 'leaf') {
      if (node.paneId === targetPaneId) {
        removed = true;
        return null;
      }
      return node;
    }

    const firstHasTarget = node.first.kind === 'leaf' && node.first.paneId === targetPaneId;
    if (firstHasTarget) {
      removed = true;
      const secondIds = collectPaneIds(node.second);
      nextFocusId = secondIds[0] ?? null;
      return node.second;
    }

    const secondHasTarget = node.second.kind === 'leaf' && node.second.paneId === targetPaneId;
    if (secondHasTarget) {
      removed = true;
      const firstIds = collectPaneIds(node.first);
      nextFocusId = firstIds[firstIds.length - 1] ?? null;
      return node.first;
    }

    const nextFirst = walk(node.first);
    if (removed) {
      return nextFirst ? { ...node, first: nextFirst } : node.second;
    }

    const nextSecond = walk(node.second);
    if (removed) {
      return nextSecond ? { ...node, second: nextSecond } : node.first;
    }

    return node;
  };

  const nextRoot = walk(root);
  if (!removed) {
    return { root, nextFocusId: null };
  }
  if (!nextRoot) {
    return { root: null, nextFocusId: null };
  }
  return { root: nextRoot, nextFocusId };
}

export function setTerminalSplitRatio(
  root: TerminalPaneNode,
  splitId: string,
  ratio: number,
): TerminalPaneNode {
  const clamped = clampTerminalSplitRatio(ratio);
  const update = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.kind === 'leaf') return node;
    if (node.id === splitId) {
      return clamped === node.ratio ? node : { ...node, ratio: clamped };
    }
    const nextFirst = update(node.first);
    if (nextFirst !== node.first) return { ...node, first: nextFirst };
    const nextSecond = update(node.second);
    if (nextSecond !== node.second) return { ...node, second: nextSecond };
    return node;
  };
  return update(root);
}

export function updatePaneLeaf(
  root: TerminalPaneNode,
  paneId: string,
  patch: { cwd?: string; explicitCwd?: boolean },
): TerminalPaneNode {
  const update = (node: TerminalPaneNode): TerminalPaneNode => {
    if (node.kind === 'leaf') {
      if (node.paneId !== paneId) return node;
      const nextCwd = patch.cwd !== undefined ? patch.cwd : node.cwd;
      const nextExplicit = patch.explicitCwd !== undefined ? patch.explicitCwd : node.explicitCwd;
      if (nextCwd === node.cwd && nextExplicit === node.explicitCwd) return node;
      return {
        ...node,
        ...(nextCwd !== undefined ? { cwd: nextCwd } : {}),
        ...(nextExplicit !== undefined ? { explicitCwd: nextExplicit } : {}),
      };
    }
    const nextFirst = update(node.first);
    if (nextFirst !== node.first) return { ...node, first: nextFirst };
    const nextSecond = update(node.second);
    if (nextSecond !== node.second) return { ...node, second: nextSecond };
    return node;
  };
  return update(root);
}

export function cyclePaneId(
  root: TerminalPaneNode,
  currentPaneId: string | null | undefined,
  dir: 1 | -1,
): string | null {
  const ids = collectPaneIds(root);
  if (!ids.length) return null;
  if (ids.length === 1) return ids[0]!;
  const index = currentPaneId ? ids.indexOf(currentPaneId) : -1;
  if (index < 0) return ids[0]!;
  const next = (index + dir + ids.length) % ids.length;
  return ids[next]!;
}

export function computeSplitLayout(root: TerminalPaneNode): ComputedSplitLayout {
  const panes: PaneBox[] = [];
  const dividers: DividerBox[] = [];

  const visit = (node: TerminalPaneNode, rect: NormalizedRect): void => {
    if (node.kind === 'leaf') {
      panes.push({ paneId: node.paneId, leaf: node, rect });
      return;
    }
    const ratio = clampTerminalSplitRatio(node.ratio);
    if (node.direction === 'horizontal') {
      const firstW = rect.w * ratio;
      const secondW = rect.w - firstW;
      dividers.push({
        splitId: node.id,
        direction: 'horizontal',
        ratio,
        containerRect: rect,
        x: rect.x + firstW,
        y: rect.y,
        length: rect.h,
      });
      visit(node.first, { x: rect.x, y: rect.y, w: firstW, h: rect.h });
      visit(node.second, { x: rect.x + firstW, y: rect.y, w: secondW, h: rect.h });
      return;
    }
    const firstH = rect.h * ratio;
    const secondH = rect.h - firstH;
    dividers.push({
      splitId: node.id,
      direction: 'vertical',
      ratio,
      containerRect: rect,
      x: rect.x,
      y: rect.y + firstH,
      length: rect.w,
    });
    visit(node.first, { x: rect.x, y: rect.y, w: rect.w, h: firstH });
    visit(node.second, { x: rect.x, y: rect.y + firstH, w: rect.w, h: secondH });
  };

  visit(root, { x: 0, y: 0, w: 1, h: 1 });
  return { panes, dividers };
}

const EPS = 1e-6;

export function navigatePane(
  root: TerminalPaneNode,
  currentPaneId: string,
  dir: PaneNavDirection,
): string | null {
  const { panes } = computeSplitLayout(root);
  const current = panes.find((p) => p.paneId === currentPaneId);
  if (!current || panes.length <= 1) return null;

  const cur = current.rect;
  const curCx = cur.x + cur.w / 2;
  const curCy = cur.y + cur.h / 2;

  type Candidate = {
    paneId: string;
    hasOverlap: boolean;
    primaryDist: number;
    centerDistSq: number;
  };

  const candidates: Candidate[] = [];
  for (const p of panes) {
    if (p.paneId === currentPaneId) continue;
    const r = p.rect;
    let inDirection: boolean;
    let primaryDist: number;
    let overlap: number;

    if (dir === 'left') {
      const rightEdge = r.x + r.w;
      inDirection = rightEdge <= cur.x + EPS;
      primaryDist = Math.max(0, cur.x - rightEdge);
      overlap = Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y);
    } else if (dir === 'right') {
      const curRight = cur.x + cur.w;
      inDirection = r.x >= curRight - EPS;
      primaryDist = Math.max(0, r.x - curRight);
      overlap = Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y);
    } else if (dir === 'up') {
      const bottomEdge = r.y + r.h;
      inDirection = bottomEdge <= cur.y + EPS;
      primaryDist = Math.max(0, cur.y - bottomEdge);
      overlap = Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
    } else {
      const curBottom = cur.y + cur.h;
      inDirection = r.y >= curBottom - EPS;
      primaryDist = Math.max(0, r.y - curBottom);
      overlap = Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
    }

    if (!inDirection) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    candidates.push({
      paneId: p.paneId,
      hasOverlap: overlap > EPS,
      primaryDist,
      centerDistSq: (cx - curCx) ** 2 + (cy - curCy) ** 2,
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.hasOverlap !== b.hasOverlap) return a.hasOverlap ? -1 : 1;
    if (Math.abs(a.primaryDist - b.primaryDist) > EPS) return a.primaryDist - b.primaryDist;
    return a.centerDistSq - b.centerDistSq;
  });
  return candidates[0]!.paneId;
}
