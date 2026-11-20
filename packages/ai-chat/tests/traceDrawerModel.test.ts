/** 执行轨迹模型、布局引擎与查询工具测试：时间窗、瀑布图、多层级轨迹文档、子代理嵌套与紧凑聚类 */
import { describe, expect, it } from 'vitest';

import { buildGraphLayout } from '../src/components/TraceDrawer/graphLayout';
import {
  FALLBACK_WINDOW_MS,
  barOf,
  buildTraceDocument,
  computeTraceInsights,
  extractNestedAgentMessages,
  extractThinkingChain,
  filterTraceDocument,
  formatThinkingMarkdown,
  offsetLabel,
  prettyJson,
  turnWindow,
  waterfallRows,
  waterfallSpan,
} from '../src/components/TraceDrawer/model';
import type { QualityRequestItem } from '../src/services/qualityClient';
import type { Attempt } from '../src/services/tasksClient';
import type { ConvMessage } from '../src/types/conversation';

const T0 = 1_800_000_000_000;

describe('turnWindow', () => {
  it('结束 = 消息时间，开始取耗时与最早事件中较早的', () => {
    expect(turnWindow({ at: T0 + 10_000, durationMs: 8000 })).toEqual({
      from: T0 + 2000,
      to: T0 + 10_000,
    });
    expect(
      turnWindow({
        at: T0 + 10_000,
        durationMs: 5000,
        trace: [{ type: 'tool', name: 'Read', status: 'start', detail: 'c1', at: T0 + 1000 }],
      }),
    ).toEqual({ from: T0 + 1000, to: T0 + 10_000 });
  });

  it('没有耗时也没有时间戳时往前看一段', () => {
    expect(turnWindow({ at: T0 })).toEqual({ from: T0 - FALLBACK_WINDOW_MS, to: T0 });
  });
});

describe('waterfallRows', () => {
  const req = {
    id: 'q1',
    layer: 'gateway',
    ts: T0 + 500,
    client: 'claude',
    source: 'thirdParty',
    stream: true,
    outcome: 'ok',
    timing: { endMs: 2000, firstContentMs: 300 },
    tokens: {},
  } as QualityRequestItem;

  it('工具调用按 id 配对，子调用缩进，和网关请求一起按开始时间排', () => {
    const rows = waterfallRows(
      {
        trace: [
          { type: 'tool', name: 'Task', status: 'start', detail: 'p', at: T0 + 1000 },
          {
            type: 'tool',
            name: 'Read',
            status: 'start',
            detail: 'c',
            parentId: 'p',
            at: T0 + 1200,
          },
          { type: 'tool', name: 'Read', status: 'done', detail: 'c', at: T0 + 1500 },
          {
            type: 'tool',
            name: 'Task',
            status: 'error',
            detail: 'p',
            output: 'boom',
            at: T0 + 3000,
          },
        ],
      },
      [req],
    );
    expect(rows.map((r) => r.kind)).toEqual(['request', 'tool', 'tool']);
    const [r0, task, read] = rows;
    expect(r0).toMatchObject({ start: T0 + 500, end: T0 + 2500, firstAt: T0 + 800 });
    expect(task).toMatchObject({ kind: 'tool', depth: 0, end: T0 + 3000 });
    expect(task?.kind === 'tool' && task.call.status).toBe('error');
    expect(read).toMatchObject({ kind: 'tool', depth: 1, start: T0 + 1200, end: T0 + 1500 });
  });

  it('刻度覆盖所有行；条的位置按比例', () => {
    const rows = waterfallRows({}, [req]);
    const span = waterfallSpan({ from: T0 + 1000, to: T0 + 2000 }, rows);
    expect(span).toEqual({ from: T0 + 500, to: T0 + 2500 });
    expect(barOf(rows[0]!, span)).toEqual({ left: 0, width: 100 });
  });
});

describe('格式化', () => {
  it('相对时间与 JSON 美化', () => {
    expect(offsetLabel(T0 + 1234, T0)).toBe('+1.23s');
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('not json')).toBe('not json');
  });
});

describe('buildTraceDocument：Nomi 工具语义、多轮与子代理', () => {
  it('解析 Nomi 内置工具语义标题并提取思考首行摘要（不重复「思考过程」）', () => {
    const msgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: '帮我修改配置并运行测试', at: T0 },
      {
        id: 'a1',
        role: 'assistant',
        text: '已经改完并通过测试。',
        at: T0 + 8000,
        durationMs: 8000,
        model: 'deepseek-reasoner',
        usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 600 },
        trace: [
          {
            type: 'thinking',
            text: '先检查配置文件路径\n然后修改参数并运行 vitest',
            at: T0 + 100,
          },
          {
            type: 'tool',
            name: 'fs_read_text',
            status: 'start',
            id: 't1',
            input: JSON.stringify({ path: 'src/config.ts' }),
            at: T0 + 500,
          },
          { type: 'tool', name: 'fs_read_text', status: 'done', id: 't1', output: 'ok', at: T0 + 700 },
          {
            type: 'tool',
            name: 'fs_write_text',
            status: 'start',
            id: 't2',
            input: JSON.stringify({ path: 'src/config.ts', text: 'export const x = 1;' }),
            at: T0 + 900,
          },
          { type: 'tool', name: 'fs_write_text', status: 'done', id: 't2', output: 'written', at: T0 + 1200 },
          {
            type: 'tool',
            name: 'workspace_run',
            status: 'start',
            id: 't3',
            input: JSON.stringify({ command: 'pnpm test' }),
            at: T0 + 1400,
          },
          { type: 'tool', name: 'workspace_run', status: 'done', id: 't3', output: 'pass', at: T0 + 4200 },
          {
            type: 'tool',
            name: 'browser_open',
            status: 'start',
            id: 't4',
            input: JSON.stringify({ url: 'https://example.com' }),
            at: T0 + 4400,
          },
          { type: 'tool', name: 'browser_open', status: 'done', id: 't4', output: '200', at: T0 + 4800 },
        ],
      },
    ];

    const doc = buildTraceDocument({
      scope: 'turn',
      title: '单轮轨迹',
      mainLaneName: 'Nomi',
      mainBackend: 'nomi',
      messages: msgs,
    });

    expect(doc.stats.turns).toBe(1);
    expect(doc.stats.thinkingCount).toBe(1);
    expect(doc.stats.toolCount).toBe(4);
    expect(doc.stats.slowCount).toBe(2); // workspace_run 2800ms + assistant reply 8000ms >= 2000ms
    expect(doc.stats.hitRate).toBe(0.5);

    const nodes = doc.orderedNodeIds.map((id) => doc.nodesById[id]!);
    const think = nodes.find((n) => n.kind === 'thinking')!;
    expect(think.title).toContain('先检查配置文件路径');
    expect(think.title).not.toContain('思考过程 思考过程');

    const toolTitles = nodes.filter((n) => n.kind === 'tool').map((n) => n.title);
    expect(toolTitles[0]).toContain('src/config.ts');
    expect(toolTitles[1]).toContain('src/config.ts');
    expect(toolTitles[2]).toContain('pnpm test');
    expect(toolTitles[3]).toContain('https://example.com');
  });

  it('extractNestedAgentMessages 完整还原进程内子代理思考、工具、输入输出与嵌套层次', () => {
    const nested = extractNestedAgentMessages(
      [
        { type: 'thinking', text: '子代理先读文件', parentId: 'call-sub', at: T0 + 200 },
        { type: 'tool', name: 'Read', status: 'start', id: 'r1', parentId: 'call-sub', input: '{"file_path":"a.ts"}', at: T0 + 300 },
        { type: 'tool', name: 'Read', status: 'done', id: 'r1', parentId: 'call-sub', output: 'code', at: T0 + 500 },
        { type: 'tool', name: 'Agent', status: 'start', id: 'grand-sub', parentId: 'call-sub', at: T0 + 600 },
        { type: 'thinking', text: '孙代理思路', parentId: 'grand-sub', at: T0 + 650 },
        { type: 'agent-text', text: '孙代理汇总', parentId: 'grand-sub', at: T0 + 700 },
        { type: 'tool', name: 'Agent', status: 'done', id: 'grand-sub', parentId: 'call-sub', output: 'ok', at: T0 + 800 },
        { type: 'agent-text', text: '主结果第一段', parentId: 'call-sub', at: T0 + 900 },
        { type: 'agent-input', text: '继续补充检查', parentId: 'call-sub', at: T0 + 1000 },
        { type: 'thinking', text: '第二轮思考', parentId: 'call-sub', at: T0 + 1100 },
        { type: 'agent-text', text: '第二轮回答', parentId: 'call-sub', at: T0 + 1200 },
      ],
      'call-sub',
      ['ag-1'],
      JSON.stringify({ prompt: '分析模块依赖' }),
      undefined,
      T0 + 100,
    );

    expect(nested.length).toBe(4);
    expect(nested[0]).toMatchObject({ role: 'user', text: '分析模块依赖' });
    expect(nested[1]).toMatchObject({ role: 'assistant', text: '主结果第一段' });
    // 直接子节点剥离 parentId 以免被 reduceTrace 丢弃，孙代理保留 parentId
    const directTrace = nested[1]!.trace!;
    expect(directTrace.some((e) => e.type === 'thinking' && !e.parentId && e.text === '子代理先读文件')).toBe(true);
    expect(directTrace.some((e) => e.type === 'thinking' && e.parentId === 'grand-sub')).toBe(true);
    expect(nested[2]).toMatchObject({ role: 'user', text: '继续补充检查' });
    expect(nested[3]).toMatchObject({ role: 'assistant', text: '第二轮回答' });
  });

  it('会话内同一 tabId 多次 delegate_to_cli 按时间窗切片，不串扰；支持环引用保护与已关闭降级', () => {
    const mainMsgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: '先查 A 再改 B', at: T0 },
      {
        id: 'a1',
        role: 'assistant',
        text: '都完成了',
        at: T0 + 25_000,
        durationMs: 25_000,
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'start',
            id: 'del-1',
            input: JSON.stringify({ cli: 'codex', goal: '第一步检查' }),
            at: T0 + 1000,
          },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'del-1',
            output: JSON.stringify({ ok: true, data: { taskId: 'dt-1', tabId: 'tab-shared', cli: 'codex', summary: '发现 1 处问题' } }),
            at: T0 + 8000,
          },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'start',
            id: 'del-2',
            input: JSON.stringify({ cli: 'codex', goal: '第二步修改' }),
            at: T0 + 12_000,
          },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'del-2',
            output: JSON.stringify({ ok: true, data: { taskId: 'dt-2', tabId: 'tab-shared', cli: 'codex', summary: '已修复' } }),
            at: T0 + 22_000,
          },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'start',
            id: 'del-closed',
            input: JSON.stringify({ cli: 'claude', goal: '已关闭子任务' }),
            at: T0 + 23_000,
          },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'del-closed',
            output: JSON.stringify({ ok: true, data: { taskId: 'dt-3', tabId: 'tab-gone', cli: 'claude', summary: '离线摘要' } }),
            at: T0 + 24_000,
          },
        ],
      },
    ];

    // 构造一个包含反指主代理的环引用，确保 visitedTabs 防护不会死循环
    const sharedTabMessages: ConvMessage[] = [
      { id: 'su1', role: 'user', text: '第一步问句', at: T0 + 1500 },
      {
        id: 'sa1',
        role: 'assistant',
        text: '第一步答复',
        at: T0 + 6000,
        trace: [
          { type: 'thinking', text: '第一步推理', at: T0 + 2000 },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'cycle-call',
            output: JSON.stringify({ ok: true, data: { taskId: 'dt-cycle', tabId: 'tab-shared', cli: 'codex' } }),
            at: T0 + 4000,
          },
        ],
      },
      { id: 'su2', role: 'user', text: '第二步问句', at: T0 + 13_000 },
      {
        id: 'sa2',
        role: 'assistant',
        text: '第二步答复',
        at: T0 + 20_000,
        trace: [{ type: 'thinking', text: '第二步推理', at: T0 + 14_000 }],
      },
    ];

    const doc = buildTraceDocument({
      scope: 'session',
      title: '会话轨迹',
      mainLaneName: 'Nomi',
      mainBackend: 'nomi',
      messages: mainMsgs,
      subTabs: {
        'tab-shared': {
          tabId: 'tab-shared',
          title: 'Codex 协作者',
          backend: 'codex',
          messages: sharedTabMessages,
        },
      },
    });

    const subNodes = doc.orderedNodeIds
      .map((id) => doc.nodesById[id]!)
      .filter((n) => n.kind === 'subagent');
    expect(subNodes.length).toBe(4); // del-1, del-2, cycle-call(降级), del-closed(降级)

    const del1 = subNodes.find((n) => n.call?.id === 'del-1')!;
    const del2 = subNodes.find((n) => n.call?.id === 'del-2')!;
    const delClosed = subNodes.find((n) => n.call?.id === 'del-closed')!;

    // del-1 只拿到 su1/sa1，del-2 本例因为 visitedTabs 同 tabId 防环降级，验证不会无限递归且 closed 标记正确
    const del1Texts = (del1.childTurnIds ?? [])
      .flatMap((tid) => doc.turnsById[tid]?.nodeIds ?? [])
      .map((id) => doc.nodesById[id]?.text ?? '');
    expect(del1Texts.some((txt) => txt.includes('第一步推理'))).toBe(true);
    expect(del1Texts.some((txt) => txt.includes('第二步推理'))).toBe(false);
    expect(del2.childTurnIds).toEqual([]);
    expect(doc.lanesById[delClosed.subagentLaneId!]?.closed).toBe(true);
  });

  it('任务模式：支持已关闭载体 tab 的 CLI 任务由 attempts + journal 回放与状态标注', () => {
    const attempts: Attempt[] = [
      {
        id: 'att-2',
        taskId: 'tk-1',
        gen: 1,
        cause: { kind: 'schedule' },
        status: 'failed',
        startedAt: T0 + 10_000,
        endedAt: T0 + 14_000,
        usage: { inputTokens: 0, outputTokens: 0, costKnown: false },
        error: { code: 'exec', message: '单测未通过' },
      },
      {
        id: 'att-1',
        taskId: 'tk-1',
        gen: 1,
        cause: { kind: 'manual', note: '首次检查构建' },
        status: 'succeeded',
        startedAt: T0,
        endedAt: T0 + 3000,
        usage: { inputTokens: 0, outputTokens: 0, costKnown: false },
        result: {
          summary: '检查通过',
          artifacts: [{ kind: 'file', ref: 'src/index.ts' }],
        },
      },
    ];

    const doc = buildTraceDocument({
      scope: 'task',
      title: 'CLI 巡检任务',
      mainLaneName: 'Claude',
      mainBackend: 'claude',
      messages: [],
      attempts,
      journal: [
        { t: 'done', attemptId: 'att-1', seq: 1, action: 'git_status', summary: 'clean', at: T0 + 1200 },
        { t: 'failed', attemptId: 'att-2', seq: 1, action: 'run_tests', msg: 'exit 1', at: T0 + 12_000 },
      ],
    });

    expect(doc.turns.length).toBe(2);
    expect(doc.stats.failedCount).toBeGreaterThanOrEqual(2);
    const nodes = doc.orderedNodeIds.map((id) => doc.nodesById[id]!);
    expect(nodes.some((n) => n.kind === 'error' && n.text === '单测未通过')).toBe(true);
    expect(nodes.some((n) => n.kind === 'reply' && n.text?.includes('src/index.ts'))).toBe(true);
  });
});

describe('查询、思考脉络、洞察与 DAG 图谱布局', () => {
  const sampleMsgs: ConvMessage[] = [
    { id: 'u1', role: 'user', text: '排查报错', at: T0 },
    {
      id: 'a1',
      role: 'assistant',
      text: '完成排查',
      at: T0 + 10_000,
      durationMs: 10_000,
      trace: [
        { type: 'thinking', text: '第一步思考读取三个文件\n第二行详细说明', at: T0 + 100 },
        { type: 'tool', name: 'Read', status: 'start', id: 'r1', input: '{"file_path":"a.ts"}', at: T0 + 500 },
        { type: 'tool', name: 'Read', status: 'done', id: 'r1', output: '1', at: T0 + 700 },
        { type: 'tool', name: 'Read', status: 'start', id: 'r2', input: '{"file_path":"b.ts"}', at: T0 + 800 },
        { type: 'tool', name: 'Read', status: 'done', id: 'r2', output: '2', at: T0 + 1000 },
        { type: 'tool', name: 'Read', status: 'start', id: 'r3', input: '{"file_path":"c.ts"}', at: T0 + 1100 },
        { type: 'tool', name: 'Read', status: 'done', id: 'r3', output: '3', at: T0 + 1300 },
        // 并行两个 Bash（同毫秒开始，时间重叠）
        { type: 'tool', name: 'Bash', status: 'start', id: 'b1', input: '{"command":"lint"}', at: T0 + 2000 },
        { type: 'tool', name: 'Bash', status: 'start', id: 'b2', input: '{"command":"typecheck"}', at: T0 + 2000 },
        { type: 'tool', name: 'Bash', status: 'done', id: 'b1', output: 'ok', at: T0 + 3000 },
        { type: 'tool', name: 'Bash', status: 'error', id: 'b2', output: 'type error', at: T0 + 5000 },
        // 子代理
        { type: 'tool', name: 'Agent', status: 'start', id: 'sub1', input: '{"subagent_type":"explorer","description":"查定义"}', at: T0 + 6000 },
        { type: 'thinking', text: '子代理内部思考', parentId: 'sub1', at: T0 + 6100 },
        { type: 'agent-text', text: '找到定义', parentId: 'sub1', at: T0 + 6500 },
        { type: 'tool', name: 'Agent', status: 'done', id: 'sub1', output: '找到定义', at: T0 + 7000 },
      ],
    },
  ];

  const buildDoc = () =>
    buildTraceDocument({
      scope: 'turn',
      title: '单轮',
      mainLaneName: 'Claude',
      mainBackend: 'claude',
      messages: sampleMsgs,
    });

  it('filterTraceDocument 支持多词、类型、失败与慢步骤过滤', () => {
    const doc = buildDoc();
    const errFilter = filterTraceDocument(doc, { query: '', kind: 'error', laneId: 'all' });
    expect(errFilter.orderedMatches.length).toBe(1);
    expect(doc.nodesById[errFilter.orderedMatches[0]!]?.title).toContain('typecheck');

    const slowFilter = filterTraceDocument(doc, { query: '', kind: 'slow', laneId: 'all' });
    expect(slowFilter.orderedMatches.length).toBeGreaterThanOrEqual(1);

    const textFilter = filterTraceDocument(doc, { query: 'lint', kind: 'tool', laneId: 'all' });
    expect(textFilter.orderedMatches.length).toBe(1);
  });

  it('extractThinkingChain 不重复遍历子代理且关联触发操作，formatThinkingMarkdown 可导出', () => {
    const doc = buildDoc();
    const chain = extractThinkingChain(doc);
    expect(chain.length).toBe(2); // 主思考 + 子代理思考，且无重复
    expect(chain[0]!.summary).toBe('第一步思考读取三个文件');
    expect(chain[0]!.triggeredActions.length).toBe(6); // r1, r2, r3, b1, b2, sub1
    expect(chain[1]!.lane.kind).toBe('nested');

    const md = formatThinkingMarkdown(chain, doc.from);
    expect(md).toContain('#1');
    expect(md).toContain('子代理内部思考');
  });

  it('computeTraceInsights 返回耗时拆分、Top 最慢、失败节点与工具频次', () => {
    const doc = buildDoc();
    const ins = computeTraceInsights(doc);
    expect(ins.failed.length).toBe(1);
    expect(ins.slowest[0]!.title).toContain('typecheck');
    expect(ins.toolDistribution[0]).toMatchObject({ name: 'Read', count: 3, errors: 0 });
  });

  it('buildGraphLayout：连续 >= 3 个同类无错工具智能聚簇、并行波次不重叠、展开/收起子代理连线完整', () => {
    const doc = buildDoc();
    // 1) 默认紧凑模式：3 个连续 Read 折叠成 1 个 cluster
    const compactLayout = buildGraphLayout(doc, {
      compactTools: true,
      collapsedTurns: new Set(),
      collapsedAgents: new Set(),
      expandedClusters: new Set(),
      showRequests: false,
    });
    const clusterNodes = compactLayout.nodes.filter((n) => n.kind === 'cluster');
    expect(clusterNodes.length).toBe(1);
    expect(clusterNodes[0]!.cluster!.nodeIds.length).toBe(3);

    // 验证并行两个 Bash 横向排列且不重叠
    const parallelNodes = compactLayout.nodes.filter(
      (n) => n.kind === 'node' && (n.node?.call?.id === 'b1' || n.node?.call?.id === 'b2'),
    );
    expect(parallelNodes.length).toBe(2);
    expect(parallelNodes[0]!.y).toBe(parallelNodes[1]!.y);
    expect(parallelNodes[1]!.x).toBeGreaterThanOrEqual(parallelNodes[0]!.x + parallelNodes[0]!.width);

    // 子代理展开时存在 spawn 边与 subagent 分组框
    expect(compactLayout.groups.some((g) => g.kind === 'subagent')).toBe(true);
    expect(compactLayout.edges.some((e) => e.kind === 'spawn')).toBe(true);
    for (const e of compactLayout.edges) {
      expect(Number.isFinite(e.x1) && Number.isFinite(e.y2)).toBe(true);
      expect(e.d.startsWith('M ')).toBe(true);
    }

    // 2) 展开单个聚簇 + 收起子代理分支
    const subNodeId = doc.orderedNodeIds.find((id) => doc.nodesById[id]?.kind === 'subagent')!;
    const expandedLayout = buildGraphLayout(doc, {
      compactTools: true,
      collapsedTurns: new Set(),
      collapsedAgents: new Set([subNodeId]),
      expandedClusters: new Set([clusterNodes[0]!.id]),
      showRequests: false,
    });
    expect(expandedLayout.nodes.some((n) => n.kind === 'cluster')).toBe(false);
    expect(expandedLayout.groups.some((g) => g.kind === 'subagent')).toBe(false);
  });
});
