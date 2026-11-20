/**
 * 类 DSH 运行轨迹图的纯函数确定性 DAG/泳道布局引擎：
 * - 自上而下的轮次流：用户输入 → 思考 → 串行/并行工具扇出汇合 → 子代理分支子图 → 回复；
 * - 连续 >= 3 个同类无错工具调用在智能紧凑模式下自动折叠为聚簇卡片，支持单独展开；
 * - 采用 Measure & Place 局部排版 + 平移，保证任何嵌套子图与多列扇出绝对不重叠。
 */
import { t } from '@nomi-ai/ui';

import type { EndpointKey } from '../../utils/endpointBadge';
import { formatDuration, groupTitle, type Bucket } from '../../utils/toolTrace';

import type {
  ModelAuditVerdict,
  TraceDocument,
  TraceNode,
  TraceNodeStatus,
  TraceTurn,
  TraceWave,
} from './model';

export const GRAPH_METRICS = {
  NODE_W: 248,
  NODE_H: 64,
  THINK_H: 76,
  SUB_COLLAPSED_H: 80,
  CLUSTER_H: 68,
  GAP_X: 24,
  GAP_Y: 28,
  WAVE_SUBROW_GAP_Y: 16,
  PAD_X: 22,
  HEADER_H: 38,
  PAD_BOTTOM: 18,
  TURN_GAP_Y: 24,
  CANVAS_PAD: 28,
  MAX_COLS: 3,
  MAX_SUBGRAPH_ROW_W: 1080,
  CLUSTER_THRESHOLD: 3,
} as const;

export interface GraphLayoutOptions {
  compactTools: boolean;
  collapsedTurns: ReadonlySet<string>;
  collapsedAgents: ReadonlySet<string>;
  expandedClusters: ReadonlySet<string>;
  showRequests: boolean;
  /** 若当前正在筛选，仅显示包含命中节点或全量显示 */
  visibleTurnIds?: ReadonlySet<string>;
}

export interface ClusterMeta {
  id: string;
  bucket: Bucket;
  nodeIds: string[];
  title: string;
  durationMs?: number;
  expanded: boolean;
}

export interface LayoutNode {
  id: string;
  kind: 'node' | 'cluster';
  x: number;
  y: number;
  width: number;
  height: number;
  turnId: string;
  laneId: string;
  depth: number;
  node?: TraceNode;
  cluster?: ClusterMeta;
}

export interface LayoutGroup {
  id: string;
  kind: 'turn' | 'subagent';
  title: string;
  subtitle?: string;
  status: TraceNodeStatus;
  laneId: string;
  turnId?: string;
  subagentNodeId?: string;
  backend?: EndpointKey | null;
  model?: string;
  responseModel?: string;
  switchedFromModel?: string;
  auditVerdict?: ModelAuditVerdict;
  closed?: boolean;
  collapsed?: boolean;
  stepCount: number;
  durationMs?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;
  kind: 'flow' | 'parallel' | 'spawn' | 'return';
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  d: string;
  status: TraceNodeStatus;
}

export interface GraphLayout {
  width: number;
  height: number;
  groups: LayoutGroup[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  nodeById: Record<string, LayoutNode>;
}

interface Port {
  id: string;
  x: number;
  y: number;
  status: TraceNodeStatus;
}

interface MeasuredBlock {
  width: number;
  height: number;
  groups: LayoutGroup[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  entryPorts: Port[];
  exitPorts: Port[];
}

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dy = Math.abs(y2 - y1);
  const ctrl = Math.max(18, Math.min(72, dy * 0.5));
  return `M ${x1} ${y1} C ${x1} ${y1 + ctrl}, ${x2} ${y2 - ctrl}, ${x2} ${y2}`;
}

function nodeHeightOf(n: TraceNode, hasChildren: boolean, collapsed: boolean): number {
  if (n.kind === 'thinking') return GRAPH_METRICS.THINK_H;
  if (n.kind === 'subagent') {
    return hasChildren || collapsed ? GRAPH_METRICS.SUB_COLLAPSED_H : GRAPH_METRICS.NODE_H;
  }
  return GRAPH_METRICS.NODE_H;
}

function makeEdge(
  id: string,
  kind: LayoutEdge['kind'],
  fromId: string,
  toId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  status: TraceNodeStatus,
): LayoutEdge {
  return { id, kind, fromId, toId, x1, y1, x2, y2, d: bezierPath(x1, y1, x2, y2), status };
}

function shiftEdges(edges: readonly LayoutEdge[], dx: number, dy: number): LayoutEdge[] {
  if (dx === 0 && dy === 0) return [...edges];
  return edges.map((e) => {
    const x1 = e.x1 + dx;
    const y1 = e.y1 + dy;
    const x2 = e.x2 + dx;
    const y2 = e.y2 + dy;
    return { ...e, x1, y1, x2, y2, d: bezierPath(x1, y1, x2, y2) };
  });
}

function translateBlock(b: MeasuredBlock, dx: number, dy: number): MeasuredBlock {
  if (dx === 0 && dy === 0) return b;
  const shiftPath = (p: Port) => ({ ...p, x: p.x + dx, y: p.y + dy });
  return {
    width: b.width,
    height: b.height,
    groups: b.groups.map((g) => ({ ...g, x: g.x + dx, y: g.y + dy })),
    nodes: b.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })),
    edges: shiftEdges(b.edges, dx, dy),
    entryPorts: b.entryPorts.map(shiftPath),
    exitPorts: b.exitPorts.map(shiftPath),
  };
}

type StepItem =
  | { kind: 'wave'; nodeIds: string[] }
  | { kind: 'cluster'; cluster: ClusterMeta };

function buildStepsForTurn(
  turn: TraceTurn,
  doc: TraceDocument,
  opts: GraphLayoutOptions,
): StepItem[] {
  const baseWaves: TraceWave[] = [...turn.waves];
  if (opts.showRequests && turn.requestNodeIds.length > 0) {
    baseWaves.push({
      id: `w-req-${turn.id}`,
      kind: turn.requestNodeIds.length > 1 ? 'parallel' : 'single',
      nodeIds: turn.requestNodeIds,
    });
  }

  if (!opts.compactTools) {
    return baseWaves.map((w) => ({ kind: 'wave', nodeIds: w.nodeIds }));
  }

  const steps: StepItem[] = [];
  let i = 0;
  let cSeq = 0;
  while (i < baseWaves.length) {
    const w = baseWaves[i]!;
    const first = w.nodeIds.length === 1 ? doc.nodesById[w.nodeIds[0]!] : undefined;
    if (!first || first.kind !== 'tool' || first.status === 'error' || !first.bucket) {
      steps.push({ kind: 'wave', nodeIds: w.nodeIds });
      i += 1;
      continue;
    }

    const bucket = first.bucket;
    const runNodes: TraceNode[] = [first];
    let j = i + 1;
    while (j < baseWaves.length) {
      const nw = baseWaves[j]!;
      const nn = nw.nodeIds.length === 1 ? doc.nodesById[nw.nodeIds[0]!] : undefined;
      if (!nn || nn.kind !== 'tool' || nn.status === 'error' || nn.bucket !== bucket) break;
      runNodes.push(nn);
      j += 1;
    }

    if (runNodes.length < GRAPH_METRICS.CLUSTER_THRESHOLD) {
      for (const rn of runNodes) steps.push({ kind: 'wave', nodeIds: [rn.id] });
    } else {
      const clusterId = `cluster:${turn.id}:${cSeq++}:${runNodes[0]!.id}`;
      const calls = runNodes.map((rn) => rn.call!).filter(Boolean);
      const title = calls.length
        ? groupTitle(bucket, calls)
        : t('ui.devtools.cluster-summary', bucket, String(runNodes.length));
      const starts = runNodes.map((rn) => rn.start).filter((x): x is number => x !== undefined);
      const ends = runNodes.map((rn) => rn.end).filter((x): x is number => x !== undefined);
      const dur =
        starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : undefined;
      if (opts.expandedClusters.has(clusterId)) {
        for (const rn of runNodes) steps.push({ kind: 'wave', nodeIds: [rn.id] });
      } else {
        steps.push({
          kind: 'cluster',
          cluster: {
            id: clusterId,
            bucket,
            nodeIds: runNodes.map((rn) => rn.id),
            title,
            durationMs: dur,
            expanded: false,
          },
        });
      }
    }
    i = j;
  }
  return steps;
}

function measureTurnBlock(
  turn: TraceTurn,
  doc: TraceDocument,
  opts: GraphLayoutOptions,
  depth: number,
  wrapInTurnGroup: boolean,
): MeasuredBlock {
  const {
    NODE_W,
    CLUSTER_H,
    GAP_X,
    GAP_Y,
    WAVE_SUBROW_GAP_Y,
    PAD_X,
    HEADER_H,
    PAD_BOTTOM,
    MAX_COLS,
    MAX_SUBGRAPH_ROW_W,
  } = GRAPH_METRICS;

  const turnCollapsed = wrapInTurnGroup && opts.collapsedTurns.has(turn.id);
  const turnSubtitle = [
    formatDuration(turn.durationMs),
    t('ui.usage-tools.steps', String(turn.nodeIds.length)),
  ]
    .filter(Boolean)
    .join(' · ');

  if (turnCollapsed) {
    const w = NODE_W + PAD_X * 2;
    const h = HEADER_H;
    const g: LayoutGroup = {
      id: `grp-${turn.id}`,
      kind: 'turn',
      title: turn.label,
      subtitle: turnSubtitle,
      status: turn.status,
      laneId: turn.laneId,
      turnId: turn.id,
      model: turn.modelAudit?.requestedModel ?? turn.model,
      responseModel: turn.responseModel,
      switchedFromModel: turn.switchedFromModel,
      auditVerdict: turn.modelAudit?.verdict,
      collapsed: true,
      stepCount: turn.nodeIds.length,
      durationMs: turn.durationMs,
      x: 0,
      y: 0,
      width: w,
      height: h,
    };
    return {
      width: w,
      height: h,
      groups: [g],
      nodes: [],
      edges: [],
      entryPorts: [{ id: g.id, x: w / 2, y: 0, status: turn.status }],
      exitPorts: [{ id: g.id, x: w / 2, y: h, status: turn.status }],
    };
  }

  const steps = buildStepsForTurn(turn, doc, opts);

  interface PlacedStep {
    width: number;
    height: number;
    nodes: LayoutNode[];
    groups: LayoutGroup[];
    edges: LayoutEdge[];
    entryPorts: Port[];
    exitPorts: Port[];
    isParallel?: boolean;
  }

  const placedSteps: PlacedStep[] = [];
  let maxContentW: number = NODE_W;

  for (const step of steps) {
    if (step.kind === 'cluster') {
      const c = step.cluster;
      const ln: LayoutNode = {
        id: c.id,
        kind: 'cluster',
        x: 0,
        y: 0,
        width: NODE_W,
        height: CLUSTER_H,
        turnId: turn.id,
        laneId: turn.laneId,
        depth,
        cluster: c,
      };
      placedSteps.push({
        width: NODE_W,
        height: CLUSTER_H,
        nodes: [ln],
        groups: [],
        edges: [],
        entryPorts: [{ id: c.id, x: NODE_W / 2, y: 0, status: 'done' }],
        exitPorts: [{ id: c.id, x: NODE_W / 2, y: CLUSTER_H, status: 'done' }],
      });
      maxContentW = Math.max(maxContentW, NODE_W);
      continue;
    }

    // 普通波次（单节点或多列并行节点）
    const waveNodes = step.nodeIds.map((id) => doc.nodesById[id]!).filter(Boolean);
    if (!waveNodes.length) continue;

    // 拆成每行最多 MAX_COLS 列
    const rows: TraceNode[][] = [];
    for (let k = 0; k < waveNodes.length; k += MAX_COLS) {
      rows.push(waveNodes.slice(k, k + MAX_COLS));
    }

    const rowNodes: LayoutNode[] = [];
    const rowEntryPorts: Port[] = [];
    const rowExitPorts: Port[] = [];
    let waveW = 0;
    let curRowY = 0;
    const expandedSubgraphs: Array<{ triggerNode: LayoutNode; block: MeasuredBlock }> = [];

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx]!;
      const rw = row.length * NODE_W + (row.length - 1) * GAP_X;
      waveW = Math.max(waveW, rw);
    }

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx]!;
      const rw = row.length * NODE_W + (row.length - 1) * GAP_X;
      const startX = (waveW - rw) / 2;
      let rowH = 0;

      for (let cIdx = 0; cIdx < row.length; cIdx++) {
        const tn = row[cIdx]!;
        const hasChildren = tn.kind === 'subagent' && !!tn.childTurnIds?.length;
        const isCollapsed = hasChildren && opts.collapsedAgents.has(tn.id);
        const nh = nodeHeightOf(tn, hasChildren, isCollapsed);
        rowH = Math.max(rowH, nh);
        const nx = startX + cIdx * (NODE_W + GAP_X);
        const ln: LayoutNode = {
          id: tn.id,
          kind: 'node',
          x: nx,
          y: curRowY,
          width: NODE_W,
          height: nh,
          turnId: turn.id,
          laneId: turn.laneId,
          depth,
          node: tn,
        };
        rowNodes.push(ln);
        if (rIdx === 0) {
          rowEntryPorts.push({ id: tn.id, x: nx + NODE_W / 2, y: curRowY, status: tn.status });
        }

        if (hasChildren && !isCollapsed && tn.childTurnIds?.length) {
          const subBlock = measureSubagentGroup(tn, doc, opts, depth + 1);
          expandedSubgraphs.push({ triggerNode: ln, block: subBlock });
        } else if (rIdx === rows.length - 1) {
          rowExitPorts.push({
            id: tn.id,
            x: nx + NODE_W / 2,
            y: curRowY + nh,
            status: tn.status,
          });
        }
      }

      curRowY += rowH + (rIdx < rows.length - 1 ? WAVE_SUBROW_GAP_Y : 0);
    }

    maxContentW = Math.max(maxContentW, waveW);

    // 若当前波次没有展开的子代理子图，直接收尾
    if (!expandedSubgraphs.length) {
      placedSteps.push({
        width: waveW,
        height: curRowY,
        nodes: rowNodes,
        groups: [],
        edges: [],
        entryPorts: rowEntryPorts,
        exitPorts: rowExitPorts,
        isParallel: waveNodes.length > 1,
      });
      continue;
    }

    // 在触发波次下方排放展开的子代理子图（支持并行多个子图横向并排或自动换行）
    const subRows: Array<typeof expandedSubgraphs> = [[]];
    let accW = 0;
    for (const sg of expandedSubgraphs) {
      const curRow = subRows[subRows.length - 1]!;
      const nextW = accW + (curRow.length ? GAP_X : 0) + sg.block.width;
      if (curRow.length > 0 && nextW > MAX_SUBGRAPH_ROW_W) {
        subRows.push([sg]);
        accW = sg.block.width;
      } else {
        curRow.push(sg);
        accW = nextW;
      }
    }

    let subStartY = curRowY + GAP_Y;
    let totalW = waveW;
    const subGroups: LayoutGroup[] = [];
    const subNodes: LayoutNode[] = [];
    const subEdges: LayoutEdge[] = [];
    const combinedExits: Port[] = [...rowExitPorts];

    for (const sr of subRows) {
      const srW = sr.reduce((s, item, k) => s + item.block.width + (k > 0 ? GAP_X : 0), 0);
      totalW = Math.max(totalW, srW);
    }

    // 将顶部的触发波次居中对齐到 totalW
    const waveShiftX = (totalW - waveW) / 2;
    const shiftedRowNodes = rowNodes.map((n) => ({ ...n, x: n.x + waveShiftX }));
    const shiftedEntries = rowEntryPorts.map((p) => ({ ...p, x: p.x + waveShiftX }));
    const shiftedExits = combinedExits.map((p) => ({ ...p, x: p.x + waveShiftX }));

    for (let sri = 0; sri < subRows.length; sri++) {
      const sr = subRows[sri]!;
      const srW = sr.reduce((s, item, k) => s + item.block.width + (k > 0 ? GAP_X : 0), 0);
      let sx = (totalW - srW) / 2;
      let maxH = 0;
      for (const item of sr) {
        const placed = translateBlock(item.block, sx, subStartY);
        subGroups.push(...placed.groups);
        subNodes.push(...placed.nodes);
        subEdges.push(...placed.edges);
        const trig = shiftedRowNodes.find((n) => n.id === item.triggerNode.id)!;
        const trigPortX = trig.x + trig.width / 2;
        const trigPortY = trig.y + trig.height;
        for (const ep of placed.entryPorts) {
          subEdges.push(
            makeEdge(
              `e-spawn-${trig.id}-${ep.id}`,
              'spawn',
              trig.id,
              ep.id,
              trigPortX,
              trigPortY,
              ep.x,
              ep.y,
              trig.node?.status ?? 'done',
            ),
          );
        }
        shiftedExits.push(...placed.exitPorts);
        maxH = Math.max(maxH, placed.height);
        sx += item.block.width + GAP_X;
      }
      subStartY += maxH + (sri < subRows.length - 1 ? GAP_Y : 0);
    }

    maxContentW = Math.max(maxContentW, totalW);
    placedSteps.push({
      width: totalW,
      height: subStartY,
      nodes: [...shiftedRowNodes, ...subNodes],
      groups: subGroups,
      edges: subEdges,
      entryPorts: shiftedEntries,
      exitPorts: shiftedExits,
      isParallel: true,
    });
  }

  const groupW = maxContentW + PAD_X * 2;
  let curY = wrapInTurnGroup ? HEADER_H + 10 : 12;
  const allNodes: LayoutNode[] = [];
  const allGroups: LayoutGroup[] = [];
  const allEdges: LayoutEdge[] = [];
  let firstPorts: Port[] = [];
  let prevPorts: Port[] = [];
  let prevWasParallel = false;

  placedSteps.forEach((ps, idx) => {
    const dx = (groupW - ps.width) / 2;
    const dy = curY;
    const shiftPort = (p: Port) => ({ ...p, x: p.x + dx, y: p.y + dy });
    const entries = ps.entryPorts.map(shiftPort);
    const exits = ps.exitPorts.map(shiftPort);

    allNodes.push(...ps.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })));
    allGroups.push(...ps.groups.map((g) => ({ ...g, x: g.x + dx, y: g.y + dy })));
    allEdges.push(...shiftEdges(ps.edges, dx, dy));

    if (idx === 0) {
      firstPorts = entries;
    } else if (prevPorts.length && entries.length) {
      const isParallelEdge =
        prevWasParallel || !!ps.isParallel || prevPorts.length > 1 || entries.length > 1;
      for (const pp of prevPorts) {
        for (const ep of entries) {
          const isReturn = pp.id.startsWith('n-') && doc.nodesById[pp.id]?.laneId !== turn.laneId;
          allEdges.push(
            makeEdge(
              `e-flow-${pp.id}-${ep.id}`,
              isReturn ? 'return' : isParallelEdge ? 'parallel' : 'flow',
              pp.id,
              ep.id,
              pp.x,
              pp.y,
              ep.x,
              ep.y,
              ep.status,
            ),
          );
        }
      }
    }

    prevPorts = exits;
    prevWasParallel = !!ps.isParallel;
    curY += ps.height + (idx < placedSteps.length - 1 ? GAP_Y : 0);
  });

  const groupH = curY + (wrapInTurnGroup ? PAD_BOTTOM : 12);
  if (wrapInTurnGroup) {
    allGroups.unshift({
      id: `grp-${turn.id}`,
      kind: 'turn',
      title: turn.label,
      subtitle: turnSubtitle,
      status: turn.status,
      laneId: turn.laneId,
      turnId: turn.id,
      model: turn.modelAudit?.requestedModel ?? turn.model,
      responseModel: turn.responseModel,
      switchedFromModel: turn.switchedFromModel,
      auditVerdict: turn.modelAudit?.verdict,
      collapsed: false,
      stepCount: turn.nodeIds.length,
      durationMs: turn.durationMs,
      x: 0,
      y: 0,
      width: groupW,
      height: groupH,
    });
  }

  return {
    width: groupW,
    height: groupH,
    groups: allGroups,
    nodes: allNodes,
    edges: allEdges,
    entryPorts: firstPorts.length
      ? firstPorts
      : [{ id: `grp-${turn.id}`, x: groupW / 2, y: 0, status: turn.status }],
    exitPorts: prevPorts.length
      ? prevPorts
      : [{ id: `grp-${turn.id}`, x: groupW / 2, y: groupH, status: turn.status }],
  };
}

function measureSubagentGroup(
  subNode: TraceNode,
  doc: TraceDocument,
  opts: GraphLayoutOptions,
  depth: number,
): MeasuredBlock {
  const childTurns = (subNode.childTurnIds ?? [])
    .map((id) => doc.turnsById[id])
    .filter((tr): tr is TraceTurn => !!tr);
  const lane = subNode.subagentLaneId ? doc.lanesById[subNode.subagentLaneId] : undefined;
  const wrapChildTurns = childTurns.length > 1;
  const childBlocks = childTurns.map((tr) =>
    measureTurnBlock(tr, doc, opts, depth, wrapChildTurns),
  );

  const innerW = childBlocks.reduce<number>((m, b) => Math.max(m, b.width), GRAPH_METRICS.NODE_W);
  const padX = 16;
  const groupW = innerW + padX * 2;
  let curY = GRAPH_METRICS.HEADER_H + 6;
  const groups: LayoutGroup[] = [];
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  let entryPorts: Port[] = [];
  let prevPorts: Port[] = [];

  childBlocks.forEach((cb, i) => {
    const dx = (groupW - cb.width) / 2;
    const placed = translateBlock(cb, dx, curY);
    groups.push(...placed.groups);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges);
    if (i === 0) entryPorts = placed.entryPorts;
    else {
      for (const pp of prevPorts) {
        for (const ep of placed.entryPorts) {
          edges.push(
            makeEdge(`e-sub-${pp.id}-${ep.id}`, 'flow', pp.id, ep.id, pp.x, pp.y, ep.x, ep.y, ep.status),
          );
        }
      }
    }
    prevPorts = placed.exitPorts;
    curY += cb.height + (i < childBlocks.length - 1 ? 16 : 0);
  });

  const groupH = curY + 14;
  const subTitle = lane?.name || subNode.title;
  const subSubtitle = [
    lane?.stepCount ? t('ui.usage-tools.steps', String(lane.stepCount)) : '',
    formatDuration(subNode.durationMs),
  ]
    .filter(Boolean)
    .join(' · ');

  groups.unshift({
    id: `grp-sub-${subNode.id}`,
    kind: 'subagent',
    title: subTitle,
    subtitle: subSubtitle,
    status: subNode.status,
    laneId: subNode.subagentLaneId ?? subNode.laneId,
    subagentNodeId: subNode.id,
    backend: lane?.backend ?? null,
    closed: lane?.closed,
    stepCount: lane?.stepCount ?? 0,
    durationMs: subNode.durationMs,
    x: 0,
    y: 0,
    width: groupW,
    height: groupH,
  });

  return {
    width: groupW,
    height: groupH,
    groups,
    nodes,
    edges,
    entryPorts: entryPorts.length
      ? entryPorts
      : [{ id: subNode.id, x: groupW / 2, y: 0, status: subNode.status }],
    exitPorts: prevPorts.length
      ? prevPorts
      : [{ id: subNode.id, x: groupW / 2, y: groupH, status: subNode.status }],
  };
}

export function buildGraphLayout(doc: TraceDocument, opts: GraphLayoutOptions): GraphLayout {
  const rootTurns = doc.rootTurnIds
    .map((id) => doc.turnsById[id])
    .filter((tr): tr is TraceTurn => !!tr)
    .filter((tr) => !opts.visibleTurnIds || opts.visibleTurnIds.has(tr.id));

  if (!rootTurns.length) {
    return { width: 400, height: 240, groups: [], nodes: [], edges: [], nodeById: {} };
  }

  // 当只有一个根 Turn 时也绘制外框以展示轮次头信息与折叠按钮
  const blocks = rootTurns.map((tr) => measureTurnBlock(tr, doc, opts, 0, true));
  const maxW = blocks.reduce<number>((m, b) => Math.max(m, b.width), GRAPH_METRICS.NODE_W);
  const pad = GRAPH_METRICS.CANVAS_PAD;
  const totalW = maxW + pad * 2;
  let curY = pad;
  const groups: LayoutGroup[] = [];
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  let prevExits: Port[] = [];

  blocks.forEach((b, idx) => {
    const dx = (totalW - b.width) / 2;
    const placed = translateBlock(b, dx, curY);
    groups.push(...placed.groups);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges);
    if (idx > 0 && prevExits.length && placed.entryPorts.length) {
      for (const pp of prevExits) {
        for (const ep of placed.entryPorts) {
          edges.push(
            makeEdge(`e-turn-${pp.id}-${ep.id}`, 'flow', pp.id, ep.id, pp.x, pp.y, ep.x, ep.y, ep.status),
          );
        }
      }
    }
    prevExits = placed.exitPorts;
    curY += b.height + (idx < blocks.length - 1 ? GRAPH_METRICS.TURN_GAP_Y : 0);
  });

  const nodeById: Record<string, LayoutNode> = {};
  for (const n of nodes) nodeById[n.id] = n;

  return {
    width: totalW,
    height: curY + pad,
    groups,
    nodes,
    edges,
    nodeById,
  };
}
