/** 模型切换追踪与指纹验真/质量对比单测 */
import { describe, expect, it } from 'vitest';

import {
  analyzeTraceModels,
  auditQualityRequest,
  buildTraceDocument,
  canonicalModelName,
  classifyModelNameMatch,
  explicitModelId,
  filterTraceDocument,
  inferModelVendor,
  stripProviderPrefix,
} from '../src/components/TraceDrawer/model';
import type { QualityRequestItem } from '../src/services/qualityClient';
import type { ConvMessage } from '../src/types/conversation';

const T0 = 1_800_000_000_000;

function makeReq(overrides: Partial<QualityRequestItem>): QualityRequestItem {
  return {
    id: overrides.id ?? 'req-1',
    layer: overrides.layer ?? 'gateway',
    ts: overrides.ts ?? T0 + 100,
    client: overrides.client ?? 'nomi',
    source: overrides.source ?? 'thirdParty',
    stream: overrides.stream ?? true,
    outcome: overrides.outcome ?? 'ok',
    timing: overrides.timing ?? {
      firstContentMs: 400,
      lastContentMs: 2400,
      endMs: 2500,
    },
    tokens: overrides.tokens ?? {
      input: 1000,
      output: 200,
      cacheRead: 400,
    },
    ...overrides,
  };
}

describe('模型名称归一化与厂商识别', () => {
  it('正确剥离厂商前缀并归一化版本号与日期后缀', () => {
    expect(stripProviderPrefix('openai/gpt-6.2-sol')).toBe('gpt-6.2-sol');
    expect(canonicalModelName('openai/gpt-4o-2024-11-20')).toBe('gpt-4o');
    expect(canonicalModelName('anthropic/claude_sonnet_4_5@20250929')).toBe('claude-sonnet-4-5');
    expect(canonicalModelName('gpt-6.2-sol')).toBe('gpt-6-2-sol');

    expect(inferModelVendor('openai/gpt-6.2-sol')).toBe('OpenAI');
    expect(inferModelVendor('claude-sonnet-4-5')).toBe('Anthropic');
    expect(inferModelVendor('deepseek-chat')).toBe('DeepSeek');
    expect(inferModelVendor('gemini-2.5-pro')).toBe('Google');
    expect(inferModelVendor('qwen3-coder')).toBe('Qwen');
    expect(inferModelVendor('glm-4.6')).toBe('Z.ai');
  });
});

describe('auditQualityRequest 单条指纹核验', () => {
  it('同模型带日期别名且响应 ID 一致时判定为 verified', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'openai/gpt-4o',
        upstreamModel: 'gpt-4o',
        wire: 'chat',
        mode: 'passthrough',
        fingerprint: {
          responseModel: 'gpt-4o-2024-11-20',
          responseId: 'chatcmpl-9x1234',
          headers: { 'openai-version': '2020-10-01' },
        },
      }),
    );
    expect(res.verdict).toBe('verified');
    expect(res.tps).toBeCloseTo(100, 1);
    expect(res.evidences.some((e) => e.id === 'model-match' && e.status === 'pass')).toBe(true);
    expect(res.evidences.some((e) => e.id === 'rid-match' && e.status === 'pass')).toBe(true);
  });

  it('请求 gpt-6.2-sol 却实际返回 deepseek-chat 时判定为跨厂商 mismatch', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'openai/gpt-6.2-sol',
        upstreamModel: 'gpt-6.2-sol',
        responseModel: 'deepseek-chat',
        wire: 'chat',
        mode: 'passthrough',
        fingerprint: {
          responseModel: 'deepseek-chat',
          responseId: 'ds-chat-9988',
          systemFingerprint: 'fp_deepseek_prod_01',
          headers: { 'x-ds-trace-id': 'ds-trace-001' },
        },
      }),
    );
    expect(res.verdict).toBe('mismatch');
    expect(res.expectedVendor).toBe('OpenAI');
    expect(res.observedVendor).toBe('DeepSeek');
    expect(res.evidences.some((e) => e.id === 'model-cross-vendor' && e.status === 'fail')).toBe(
      true,
    );
    expect(res.evidences.some((e) => e.id === 'sysfp-conflict' && e.status === 'fail')).toBe(true);
    expect(
      res.evidences.some((e) => e.id === 'hdr-vendor-x-ds-trace-id' && e.status === 'fail'),
    ).toBe(true);
  });

  it('即使响应体伪装返回 gpt-6.2-sol，仅凭响应头或 system_fingerprint 异厂冲突也能抓出 mismatch', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'gpt-6.2-sol',
        upstreamModel: 'gpt-6.2-sol',
        wire: 'responses',
        mode: 'passthrough',
        fingerprint: {
          responseModel: 'gpt-6.2-sol',
          systemFingerprint: 'fp-vllm-backend-42',
          headers: { 'x-ds-trace-id': 'abc-123' },
        },
      }),
    );
    expect(res.verdict).toBe('mismatch');
    expect(res.evidences.some((e) => e.id === 'sysfp-conflict')).toBe(true);
    expect(res.evidences.some((e) => e.id === 'hdr-vendor-x-ds-trace-id')).toBe(true);
  });

  it('协议转换 mode=convert 时不因响应 ID 前缀差异误报，同时记录转换提示', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'claude-sonnet-4-5',
        upstreamModel: 'claude-sonnet-4-5',
        ingress: 'chat',
        wire: 'messages',
        mode: 'convert',
        fingerprint: {
          responseModel: 'claude-sonnet-4-5-20250929',
          responseId: 'chatcmpl-converted-id',
          hasThinkSig: true,
        },
      }),
    );
    expect(res.verdict).toBe('verified');
    expect(res.evidences.some((e) => e.id === 'mode-convert')).toBe(true);
    expect(res.evidences.some((e) => e.id === 'rid-suspect')).toBe(false);
  });

  it('普通超时或上游错误无指纹冲突时只标为 suspect，不误报为 mismatch', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'gpt-6.2-sol',
        upstreamModel: 'gpt-6.2-sol',
        outcome: 'upstream-5xx',
        burst: true,
        fingerprint: {
          responseModel: 'gpt-6.2-sol',
        },
      }),
    );
    expect(res.verdict).toBe('suspect');
    expect(res.evidences.some((e) => e.id === 'burst')).toBe(true);
    expect(res.evidences.some((e) => e.id === 'outcome-fail')).toBe(true);
  });
});

describe('会话内模型切换追踪与按模型/异常过滤', () => {
  const messages: ConvMessage[] = [
    { id: 'u1', role: 'user', text: '第一轮规划', at: T0 },
    {
      id: 'a1',
      role: 'assistant',
      text: '已用 Claude 完成架构梳理',
      at: T0 + 3000,
      durationMs: 3000,
      model: 'claude-sonnet-4-5',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 },
    },
    { id: 'u2', role: 'user', text: '切到 gpt-6.2-sol 写实现', at: T0 + 5000 },
    {
      id: 'a2',
      role: 'assistant',
      text: '代码实现已写完',
      at: T0 + 8000,
      durationMs: 3000,
      model: 'gpt-6.2-sol',
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0 },
    },
    { id: 'u3', role: 'user', text: '切回 Claude 复核', at: T0 + 10000 },
    {
      id: 'a3',
      role: 'assistant',
      text: '复核完毕',
      at: T0 + 13000,
      durationMs: 3000,
      model: 'claude-sonnet-4-5',
      usage: { inputTokens: 800, outputTokens: 100, cacheReadTokens: 600 },
    },
  ];

  const requests: QualityRequestItem[] = [
    makeReq({
      id: 'q1',
      ts: T0 + 100,
      model: 'claude-sonnet-4-5',
      upstreamModel: 'claude-sonnet-4-5',
      wire: 'messages',
      mode: 'passthrough',
      timing: { firstContentMs: 300, lastContentMs: 2300, endMs: 2500 },
      tokens: { input: 1000, output: 200, cacheRead: 800 },
      fingerprint: {
        responseModel: 'claude-sonnet-4-5-20250929',
        responseId: 'msg_01abc',
        hasThinkSig: true,
      },
    }),
    makeReq({
      id: 'q2',
      ts: T0 + 5100,
      model: 'gpt-6.2-sol',
      upstreamModel: 'gpt-6.2-sol',
      responseModel: 'deepseek-chat',
      wire: 'chat',
      mode: 'passthrough',
      timing: { firstContentMs: 900, lastContentMs: 2900, endMs: 2950 },
      tokens: { input: 1200, output: 300, cacheRead: 0 },
      fingerprint: {
        responseModel: 'deepseek-chat',
        systemFingerprint: 'fp_deepseek_v3',
        headers: { 'x-ds-trace-id': 'ds-999' },
      },
    }),
    makeReq({
      id: 'q3',
      ts: T0 + 10100,
      model: 'claude-sonnet-4-5',
      upstreamModel: 'claude-sonnet-4-5',
      wire: 'messages',
      mode: 'passthrough',
      timing: { firstContentMs: 350, lastContentMs: 2350, endMs: 2400 },
      tokens: { input: 800, output: 100, cacheRead: 600 },
      fingerprint: {
        responseModel: 'claude-sonnet-4-5',
        responseId: 'msg_02def',
      },
    }),
  ];

  it('识别跨轮两次切换、分段统计、Turn 级核验与分模型质量指标', () => {
    const doc = buildTraceDocument({
      scope: 'session',
      title: '多模型会话',
      messages,
      requests,
      mainLaneName: 'Nomi',
    });

    const { summary, switches, segments, byModel } = doc.modelAnalysis;
    expect(summary.switchCount).toBe(2);
    expect(summary.overallVerdict).toBe('mismatch');
    expect(summary.mismatchCount).toBe(1);
    expect(summary.verifiedCount).toBe(2);

    expect(switches).toHaveLength(2);
    expect(switches[0]).toMatchObject({
      fromModel: 'claude-sonnet-4-5',
      toModel: 'gpt-6.2-sol',
    });
    expect(switches[1]).toMatchObject({
      fromModel: 'gpt-6.2-sol',
      toModel: 'claude-sonnet-4-5',
    });

    expect(segments).toHaveLength(3);
    expect(segments[1]).toMatchObject({
      modelKey: 'gpt-6-2-sol',
      verdict: 'mismatch',
      observedModels: ['deepseek-chat'],
    });

    const t2 = doc.turns[1]!;
    expect(t2.switchedFromModel).toBe('claude-sonnet-4-5');
    expect(t2.responseModel).toBe('deepseek-chat');
    expect(t2.modelAudit?.verdict).toBe('mismatch');

    const claudeSummary = byModel.find((m) => m.modelKey === 'claude-sonnet-4-5');
    const gptSummary = byModel.find((m) => m.modelKey === 'gpt-6-2-sol');
    expect(claudeSummary?.turnCount).toBe(2);
    expect(claudeSummary?.requestCount).toBe(2);
    expect(claudeSummary?.verdict).toBe('verified');
    expect(gptSummary?.verdict).toBe('mismatch');
    expect(gptSummary?.observedModels).toEqual(['deepseek-chat']);

    expect(doc.stats.modelAnomalyCount).toBe(1);
  });

  it('filterTraceDocument 支持按模型与模型异常过滤', () => {
    const doc = buildTraceDocument({
      scope: 'session',
      title: '多模型过滤',
      messages,
      requests,
      mainLaneName: 'Nomi',
    });

    const secondTurnId = doc.turns[1]!.id;
    const onlyGpt = filterTraceDocument(doc, {
      query: '',
      kind: 'all',
      laneId: 'all',
      model: 'gpt-6-2-sol',
    });
    expect(onlyGpt.visibleTurnIds).toEqual(new Set([secondTurnId]));

    const onlyAnomaly = filterTraceDocument(doc, {
      query: '',
      kind: 'mismatch',
      laneId: 'all',
    });
    const matchedKinds = onlyAnomaly.orderedMatches.map((id) => doc.nodesById[id]!.kind);
    expect(matchedKinds).toContain('request');
    expect(matchedKinds).toContain('reply');
    expect(onlyAnomaly.visibleTurnIds).toEqual(new Set([secondTurnId]));

    const explicitAnalysis = analyzeTraceModels(doc.turns, doc.nodesById, doc.lanesById);
    expect(explicitAnalysis.summary.totalAuditedRequests).toBe(3);
  });
});

describe('Issue 416：区分精确匹配、供应商别名、同系列与未知', () => {
  const matchEvidence = (res: ReturnType<typeof auditQualityRequest>) =>
    res.evidences.find((e) => e.category === 'model' && e.id !== 'model-absent');

  it('分类：相同显式版本 / 合法别名 / 同系列 / 未知', () => {
    // 相同显式版本（前缀与大小写差异不影响）
    expect(classifyModelNameMatch('openai/gpt-4o-2024-11-20', 'gpt-4o-2024-11-20')).toBe('exact');
    expect(classifyModelNameMatch('GPT-4O-2024-11-20', 'gpt-4o-2024-11-20')).toBe('exact');
    // 合法供应商别名：无日期系列名 vs 该系列自己的日期快照 / latest
    expect(classifyModelNameMatch('gpt-4o', 'gpt-4o-2024-11-20')).toBe('alias');
    expect(classifyModelNameMatch('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929')).toBe('alias');
    expect(classifyModelNameMatch('claude-sonnet-4-5-latest', 'claude-sonnet-4-5-20250929')).toBe('alias');
    expect(classifyModelNameMatch('gpt-4o-2024-11-20', 'gpt-4o-latest')).toBe('alias');
    // 两个不同的显式日期版不是版本一致
    expect(classifyModelNameMatch('gpt-4o-2024-08-06', 'gpt-4o-2024-11-20')).toBe('family');
    expect(classifyModelNameMatch('claude-3-5-sonnet-20240620', 'claude-sonnet-4-5-20250929')).toBe('unknown');
    // 同系列（不同显式版本号 / 相邻代）
    expect(classifyModelNameMatch('gpt-4o', 'gpt-4o-mini')).toBe('family');
    expect(classifyModelNameMatch('claude-sonnet-4-5', 'claude-sonnet-4-6')).toBe('family');
    expect(classifyModelNameMatch('claude-3-7-sonnet-20250219', 'claude-3-7-sonnet-20241022')).toBe('family');
    expect(classifyModelNameMatch('gemini-2.5-pro', 'gemini-2.5-flash')).toBe('unknown');
    expect(classifyModelNameMatch('gemini-2.5-pro', 'gemini-2.5-pro-20250903')).toBe('alias');
    // 未知（同厂不同系列 / 无厂商信息）
    expect(classifyModelNameMatch('gpt-4o', 'gpt-4.1')).toBe('unknown');
    expect(classifyModelNameMatch('my-model-a', 'my-model-b')).toBe('unknown');
    expect(classifyModelNameMatch('', 'gpt-4o')).toBe('unknown');
    // 固定 ID 原样保留，不建立历史映射
    expect(explicitModelId('openai/GPT-4o-2024-11-20')).toBe('gpt-4o-2024-11-20');
    expect(explicitModelId('anthropic/claude_sonnet_4_5@20250929')).toBe('claude-sonnet-4-5@20250929');
  });

  it('请求路径：相同显式版本判定为 verified / model-match pass', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'openai/gpt-4o-2024-11-20',
        upstreamModel: 'gpt-4o-2024-11-20',
        wire: 'chat',
        mode: 'passthrough',
        fingerprint: { responseModel: 'gpt-4o-2024-11-20' },
      }),
    );
    expect(res.verdict).toBe('verified');
    expect(matchEvidence(res)).toMatchObject({ id: 'model-match', status: 'pass' });
  });

  it('请求路径：无日期固定 ID 与日期别名判定为 verified 并附别名说明', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'gpt-4o',
        upstreamModel: 'gpt-4o',
        wire: 'chat',
        mode: 'passthrough',
        fingerprint: { responseModel: 'gpt-4o-2024-11-20' },
      }),
    );
    expect(res.verdict).toBe('verified');
    expect(matchEvidence(res)).toMatchObject({ id: 'model-match', status: 'pass' });
    expect(res.evidences.some((e) => e.id === 'model-alias' && e.status === 'info')).toBe(true);
    expect(res.evidences.some((e) => e.id === 'model-family' || e.id === 'model-mismatch')).toBe(
      false,
    );
  });

  it('请求路径：两个不同的显式日期版判定为 mismatch / 同系列证据，而不是精确一致', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'openai/gpt-4o-2024-08-06',
        upstreamModel: 'gpt-4o-2024-08-06',
        wire: 'chat',
        mode: 'passthrough',
        fingerprint: { responseModel: 'gpt-4o-2024-11-20' },
      }),
    );
    expect(res.verdict).toBe('mismatch');
    expect(res.evidences.some((e) => e.id === 'model-match')).toBe(false);
    expect(matchEvidence(res)).toMatchObject({ id: 'model-family', status: 'fail' });
  });

  it('请求路径：未知模型名判定为 mismatch / model-mismatch', () => {
    const res = auditQualityRequest(
      makeReq({
        model: 'gpt-4o',
        upstreamModel: 'gpt-4o',
        wire: 'chat',
        mode: 'passthrough',
        fingerprint: { responseModel: 'gpt-4.1' },
      }),
    );
    expect(res.verdict).toBe('mismatch');
    expect(matchEvidence(res)).toMatchObject({ id: 'model-mismatch', status: 'fail' });
  });

  it('响应头证据：日期别名放行，不同显式日期版与未知声明都判 fail', () => {
    const alias = auditQualityRequest(
      makeReq({
        model: 'gpt-4o',
        upstreamModel: 'gpt-4o',
        wire: 'chat',
        mode: 'passthrough',
        fingerprint: {
          headers: { 'x-upstream-model': 'gpt-4o-2024-11-20', 'openai-version': '2020-10-01' },
        },
      }),
    );
    expect(alias.verdict).toBe('verified');
    expect(alias.evidences.some((e) => e.id === 'hdr-model-x-upstream-model')).toBe(false);

    const otherDate = auditQualityRequest(
      makeReq({
        model: 'gpt-4o-2024-08-06',
        upstreamModel: 'gpt-4o-2024-08-06',
        fingerprint: { headers: { 'x-upstream-model': 'gpt-4o-2024-11-20' } },
      }),
    );
    expect(otherDate.verdict).toBe('mismatch');
    expect(otherDate.evidences.some((e) => e.id === 'hdr-model-x-upstream-model' && e.status === 'fail')).toBe(
      true,
    );

    const unknown = auditQualityRequest(
      makeReq({
        model: 'gpt-4o',
        upstreamModel: 'gpt-4o',
        fingerprint: { headers: { 'x-upstream-model': 'gpt-4.1' } },
      }),
    );
    expect(unknown.verdict).toBe('mismatch');
    expect(unknown.evidences.some((e) => e.id === 'hdr-model-x-upstream-model' && e.status === 'fail')).toBe(
      true,
    );

    const fixedId = auditQualityRequest(
      makeReq({
        model: 'gpt-4o-2024-08-06',
        upstreamModel: 'gpt-4o-2024-08-06',
        fingerprint: { headers: { 'x-upstream-model': 'gpt-4o-2024-08-06' } },
      }),
    );
    expect(fixedId.verdict).toBe('unverified');
    expect(fixedId.evidences.some((e) => e.id === 'hdr-model-x-upstream-model')).toBe(false);
  });
});

describe('Issue 417：总览纳入未被请求覆盖的历史回合', () => {
  const h = T0 + 10_000;

  function msgs(replies: Array<{ model: string; responseModel?: string }>): ConvMessage[] {
    return replies.flatMap((r, i) => [
      { id: `u${i}`, role: 'user' as const, text: `第 ${i + 1} 轮`, at: T0 + i * h },
      {
        id: `a${i}`,
        role: 'assistant' as const,
        text: `回复 ${i + 1}`,
        at: T0 + i * h + 1000,
        durationMs: 1000,
        model: r.model,
        ...(r.responseModel ? { responseModel: r.responseModel } : {}),
      },
    ]);
  }

  function build(
    replies: Array<{ model: string; responseModel?: string }>,
    requests: QualityRequestItem[] = [],
  ) {
    return buildTraceDocument({
      scope: 'session',
      title: '历史回合',
      messages: msgs(replies),
      requests,
      mainLaneName: 'Nomi',
    }).modelAnalysis;
  }

  function okRequest(id: string, ts: number, model: string, observed: string): QualityRequestItem {
    return makeReq({
      id,
      ts,
      model,
      upstreamModel: model,
      wire: 'chat',
      mode: 'passthrough',
      fingerprint: { responseModel: observed },
    });
  }

  it('纯请求：只按请求计，没有历史回退回合', () => {
    const a = build(
      [{ model: 'gpt-4o' }, { model: 'gpt-4o' }],
      [
        okRequest('r1', T0 + 500, 'gpt-4o', 'gpt-4o-2024-11-20'),
        okRequest('r2', T0 + h + 500, 'gpt-4o', 'gpt-4o'),
      ],
    );
    expect(a.summary.totalAuditedRequests).toBe(2);
    expect(a.summary.totalAuditedTurns).toBe(2);
    expect(a.summary.verifiedCount).toBe(2);
    expect(a.summary.mismatchCount).toBe(0);
    expect(a.summary.historicalModelDiffTurns).toBe(0);
    expect(a.summary.overallVerdict).toBe('verified');
  });

  it('纯历史：没有请求记录时按回复证据计回合', () => {
    const a = build([
      { model: 'gpt-4o', responseModel: 'claude-sonnet-4-5' },
      { model: 'gpt-4o', responseModel: 'gpt-4o-2024-11-20' },
    ]);
    expect(a.summary.totalAuditedRequests).toBe(0);
    expect(a.summary.totalAuditedTurns).toBe(2);
    expect(a.summary.mismatchCount).toBe(1);
    expect(a.summary.verifiedCount).toBe(1);
    expect(a.summary.historicalModelDiffTurns).toBe(1);
    expect(a.summary.overallVerdict).toBe('mismatch');
  });

  it('混合：新请求不能掩盖旧的历史差异，已被请求覆盖的回合不双计', () => {
    const a = build(
      [
        { model: 'gpt-4o', responseModel: 'claude-sonnet-4-5' },
        { model: 'gpt-4o', responseModel: 'gpt-4o' },
      ],
      [okRequest('r2', T0 + h + 500, 'gpt-4o', 'gpt-4o-2024-11-20')],
    );
    expect(a.summary.totalAuditedRequests).toBe(1);
    expect(a.summary.totalAuditedTurns).toBe(2);
    expect(a.summary.verifiedCount).toBe(1);
    expect(a.summary.mismatchCount).toBe(1);
    expect(a.summary.historicalModelDiffTurns).toBe(1);
    expect(a.summary.overallVerdict).toBe('mismatch');
    // 被请求覆盖的回合只按请求计一次
    expect(
      Object.values(a.turnAuditsByTurnId).filter((tItem) => tItem.requestCount > 0),
    ).toHaveLength(1);
  });

  it('历史未知：同系列不同版本只按回复证据判为疑点，不升级为 mismatch', () => {
    const a = build([
      { model: 'gpt-4o-2024-08-06', responseModel: 'gpt-4o-2024-11-20' },
      { model: 'gpt-4o', responseModel: 'gpt-4o-mini' },
    ]);
    expect(a.summary.totalAuditedRequests).toBe(0);
    expect(a.summary.suspectCount).toBe(2);
    expect(a.summary.mismatchCount).toBe(0);
    expect(a.summary.historicalModelDiffTurns).toBe(2);
    expect(a.summary.overallVerdict).toBe('suspect');
    const firstTurn = Object.values(a.turnAuditsByTurnId).find(
      (tItem) => tItem.requestedModel === 'gpt-4o-2024-08-06',
    );
    expect(firstTurn?.verdict).toBe('suspect');
    expect(firstTurn?.evidences.some((e) => e.id === 'msg-model-diff' && e.status === 'warn')).toBe(
      true,
    );
  });

  it('无证据：请求与回复都没有模型名时只记 unknown，不误报', () => {
    const a = build([{ model: '' }, { model: 'gpt-4o' }]);
    expect(a.summary.totalAuditedRequests).toBe(0);
    expect(a.summary.mismatchCount).toBe(0);
    expect(a.summary.suspectCount).toBe(0);
    expect(a.summary.overallVerdict).toBe('unverified');
  });

  it('一回合多请求：请求逐个计、回合只计一次', () => {
    const a = build(
      [{ model: 'gpt-4o', responseModel: 'claude-sonnet-4-5' }, { model: 'gpt-4o' }],
      [
        okRequest('r2a', T0 + h + 300, 'gpt-4o', 'gpt-4o'),
        okRequest('r2b', T0 + h + 600, 'gpt-4o', 'gpt-4o-2024-08-06'),
      ],
    );
    expect(a.summary.totalAuditedRequests).toBe(2);
    expect(a.summary.totalAuditedTurns).toBe(2);
    expect(a.summary.verifiedCount).toBe(2);
    // 未被请求覆盖的历史差异仍在
    expect(a.summary.mismatchCount).toBe(1);
    expect(a.summary.overallVerdict).toBe('mismatch');
  });

  it('请求证据未定论或已失败时，回复记录里的跨厂商冲突不重复加码并计入总览', () => {
    const a = build(
      [{ model: 'gpt-4o', responseModel: 'claude-sonnet-4-5' }],
      [
        makeReq({
          id: 'r1',
          ts: T0 + 500,
          model: 'gpt-4o',
          upstreamModel: 'gpt-4o',
          // 与期望模型不一致的声明头：请求侧抓到的失败证据，回复记录不重复加码
          fingerprint: { headers: { 'x-upstream-model': 'deepseek-chat' } },
        }),
      ],
    );
    const turn = Object.values(a.turnAuditsByTurnId)[0]!;
    // 请求侧已有响应头异厂冲突，回复记录不重复加码
    expect(a.requestAudits[0]!.verdict).toBe('mismatch');
    expect(turn.verdict).toBe('mismatch');
    expect(turn.historyVerdict).toBe('unverified');
    expect(a.summary.totalAuditedRequests).toBe(1);
    expect(a.summary.mismatchCount).toBe(1);
    expect(a.summary.overallVerdict).toBe('mismatch');

    // 请求证据本身无冲突（未定论）时，回复记录里的跨厂商冲突仍按较低证据强度计入总览
    const b = build(
      [{ model: 'gpt-4o', responseModel: 'claude-sonnet-4-5' }],
      [
        makeReq({
          id: 'r1',
          ts: T0 + 500,
          model: 'gpt-4o',
          upstreamModel: 'gpt-4o',
          fingerprint: {},
        }),
      ],
    );
    expect(b.requestAudits[0]!.verdict).toBe('unverified');
    const bTurn = Object.values(b.turnAuditsByTurnId).find((tItem) => tItem.turnId === b.requestAudits[0]!.turnId)!;
    expect(bTurn.verdict).toBe('unverified');
    expect(bTurn.historyVerdict).toBe('mismatch');
    expect(b.summary.mismatchCount).toBe(1);
    expect(b.summary.overallVerdict).toBe('mismatch');
  });
});
