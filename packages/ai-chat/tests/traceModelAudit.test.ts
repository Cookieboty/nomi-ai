/** 模型切换追踪与指纹验真/质量对比单测 */
import { describe, expect, it } from 'vitest';

import {
  analyzeTraceModels,
  auditQualityRequest,
  buildTraceDocument,
  canonicalModelName,
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
