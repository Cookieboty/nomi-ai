/**
 * ai-runtime · 事件 → metrics / tracing 埋点桥（P9-2/P9-3 · Polish C）
 *
 * 目标：给 [EventBroadcaster](file:///./EventBroadcaster.ts) 一个可插拔的**副作用回调**，
 * 把 AIClient 12 个业务事件翻译成 [AI_METRICS](file:///./observability/metrics.ts) 与
 * [Tracer](file:///./observability/tracing.ts) 的调用，实现 P9 计划 §P9-2 表格。
 *
 * 设计要点：
 * - **零成本**：`configureObservabilityBridge()` 不主动订阅 client；调用方（Broadcaster）
 *   在每次广播前后 `notify(evt, payload)`；未开启 tracer / metrics 时全为 no-op；
 * - **turn 生命周期跟踪**：`agent:step` 累加、`agent:turn-end` 触发
 *   `ai.agent.steps.per_turn` histogram + span 结束；
 * - **tool 耗时**：`tool:confirm-required` / `tools/pre-execute` 事件不在此路径 fire，
 *   我们退化到只统计 `tool:executed { ok, durationMs, error }`，`durationMs` 由 插件宿主
 *   Waterfall hook 已经写入 payload；
 * - **tts first-chunk**：`tts:chunk` 第一次 seq=0 落一次 first-chunk histogram；
 * - **可测试**：本模块**不使用**全局 tracer 单例，业务方注入或走
 *   [getTracer](file:///./observability/tracing.ts) 兜底。
 *
 * 未来接线：
 * - `ai.chat.tokens.*` 需要 AIClient 侧在 `message:complete` 里回填 usage；本 sprint
 *   已经在 payload 检测到 `usage.prompt_tokens` / `completion_tokens` 时才 inc，
 *   payload 里没有就跳过，向后兼容；
 * - `ai.asr.latency.final` 目前没有独立事件源，留待 ASR provider 集成时接线。
 */

import type { AIClientEvent, AIClientEventMap } from '@nomi-ai/ai-sdk';

import { AI_METRICS } from './observability/metrics';
import { getTracer, type Tracer, type Span } from './observability/tracing';

export interface ObservabilityBridgeOptions {
  /** 覆盖默认全局 tracer；未提供使用 [getTracer](file:///./observability/tracing.ts)。 */
  tracer?: Tracer;
  /** 关闭 metrics；默认开启（zero-cost：`AI_METRICS.*.inc` 都是本地 map）。 */
  metricsEnabled?: boolean;
  /** 关闭 tracing 桥接；默认开启（zero-cost：no-op tracer 不分配对象）。 */
  tracingEnabled?: boolean;
}

interface TurnState {
  sessionId: string;
  turnId?: string;
  steps: number;
  span: Span;
  ttsFirstChunkStart?: number;
  ttsFirstChunkSeen: boolean;
}

export interface ObservabilityBridge {
  /** 收到一条 AIClient 事件时调用；返回值仅用于测试。 */
  notify<E extends AIClientEvent>(evt: E, data: AIClientEventMap[E]): void;
  /** 用于 `EventBroadcaster.stop()` 主动清理未 end 的 span。 */
  dispose(): void;
}

/**
 * 构建 observability bridge。业务方一般在 `EventBroadcaster` 构造时挂上。
 */
export function createObservabilityBridge(
  opts: ObservabilityBridgeOptions = {},
): ObservabilityBridge {
  const metricsOn = opts.metricsEnabled ?? true;
  const tracingOn = opts.tracingEnabled ?? true;
  const tracer = opts.tracer ?? getTracer();
  const turns = new Map<string, TurnState>();

  const now = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const ensureTurn = (sessionId: string): TurnState => {
    let state = turns.get(sessionId);
    if (!state) {
      const span = tracingOn
        ? tracer.startSpan('chat.turn', {
            kind: 'internal',
            attributes: { 'chat.session_id': sessionId },
          })
        : ({
            name: 'chat.turn',
            isRecording: () => false,
            setAttribute: () => {},
            setAttributes: () => {},
            addEvent: () => {},
            setStatus: () => {},
            recordException: () => {},
            end: () => {},
            kind: 'internal',
            context: { traceId: '0'.repeat(32), spanId: '0'.repeat(16) },
          } as Span);
      state = {
        sessionId,
        steps: 0,
        span,
        ttsFirstChunkSeen: false,
      };
      turns.set(sessionId, state);
    }
    return state;
  };

  const closeTurn = (state: TurnState, ok: boolean, reason?: string): void => {
    if (metricsOn) {
      AI_METRICS.agentStepsPerTurn.observe(state.steps);
    }
    if (tracingOn && state.span.isRecording()) {
      state.span.setAttribute('chat.agent.steps', state.steps);
      if (state.turnId) state.span.setAttribute('chat.turn.id', state.turnId);
      state.span.setStatus({ code: ok ? 'ok' : 'error', message: reason });
      state.span.end();
    }
    turns.delete(state.sessionId);
  };

  const bridge: ObservabilityBridge = {
    notify<E extends AIClientEvent>(evt: E, data: AIClientEventMap[E]): void {
      try {
        handle(evt, data);
      } catch {
        // 桥接层不能阻塞广播；忽略内部异常
      }
    },
    dispose(): void {
      for (const state of turns.values()) {
        if (tracingOn && state.span.isRecording()) {
          state.span.setStatus({ code: 'error', message: 'disposed before turn-end' });
          state.span.end();
        }
      }
      turns.clear();
    },
  };

  function handle<E extends AIClientEvent>(evt: E, data: AIClientEventMap[E]): void {
    switch (evt) {
      case 'agent:step': {
        const p = data as AIClientEventMap['agent:step'];
        const state = ensureTurn(p.sessionId);
        state.steps += 1;
        if (tracingOn && state.span.isRecording()) {
          state.span.addEvent('agent.step', { step: state.steps, reason: p.reason });
        }
        break;
      }
      case 'agent:turn-end': {
        const p = data as AIClientEventMap['agent:turn-end'];
        const state = turns.get(p.sessionId) ?? ensureTurn(p.sessionId);
        state.turnId = p.turnId;
        closeTurn(state, p.ok, p.reason);
        break;
      }
      case 'agent:stopped-by-user': {
        const p = data as AIClientEventMap['agent:stopped-by-user'];
        const state = turns.get(p.sessionId) ?? ensureTurn(p.sessionId);
        closeTurn(state, false, 'stopped-by-user');
        break;
      }
      case 'message:complete': {
        const p = data as AIClientEventMap['message:complete'];
        const usage = extractUsage(p);
        if (metricsOn && usage) {
          if (typeof usage.promptTokens === 'number') {
            AI_METRICS.chatTokensPrompt.inc(
              {
                provider: usage.provider ?? 'unknown',
                model: usage.model ?? 'unknown',
              },
              usage.promptTokens,
            );
          }
          if (typeof usage.completionTokens === 'number') {
            AI_METRICS.chatTokensCompletion.inc(
              {
                provider: usage.provider ?? 'unknown',
                model: usage.model ?? 'unknown',
              },
              usage.completionTokens,
            );
          }
        }
        if (metricsOn && typeof usage?.ttfbMs === 'number') {
          AI_METRICS.chatLatencyTtfb.observe(usage.ttfbMs, {
            provider: usage.provider ?? 'unknown',
            model: usage.model ?? 'unknown',
          });
        }
        break;
      }
      case 'tool:executed': {
        const p = data as AIClientEventMap['tool:executed'];
        if (metricsOn) {
          if (typeof p.durationMs === 'number') {
            AI_METRICS.toolExecDuration.observe(p.durationMs, { tool: p.toolName });
          }
          if (p.ok === false) {
            AI_METRICS.toolErrorCount.inc({
              tool: p.toolName,
              code: parseErrorCode(p.error) ?? 'E_UNKNOWN',
            });
          }
        }
        break;
      }
      case 'tts:chunk': {
        const p = data as AIClientEventMap['tts:chunk'];
        const state = findTurnByReqId(p.reqId);
        if (!state) {
          if (!p.seq && metricsOn) {
            // 无 turn 上下文（TTS 独立触发）；仍尝试记录一次 first-chunk
            AI_METRICS.ttsLatencyFirstChunk.observe(0, { provider: 'unknown' });
          }
          break;
        }
        if (!state.ttsFirstChunkSeen && state.ttsFirstChunkStart !== undefined) {
          state.ttsFirstChunkSeen = true;
          const elapsed = now() - state.ttsFirstChunkStart;
          if (metricsOn) {
            AI_METRICS.ttsLatencyFirstChunk.observe(elapsed, { provider: 'unknown' });
          }
          if (tracingOn && state.span.isRecording()) {
            state.span.addEvent('tts.first_chunk', { reqId: p.reqId, elapsedMs: elapsed });
          }
        }
        break;
      }
      case 'tool:confirm-required': {
        // 桥接语义：把等待用户确认的时刻记录为 span event，不 inc metrics
        const state = findTurnByReqId((data as { reqId?: string }).reqId);
        if (tracingOn && state?.span.isRecording()) {
          state.span.addEvent('tool.confirm-required', {
            tool: (data as { toolName?: string }).toolName ?? 'unknown',
          });
        }
        break;
      }
      default:
        // 其它事件（userProfile:changed / live2d:*）当前不需要 metrics/trace
        break;
    }
  }

  function findTurnByReqId(reqId?: string): TurnState | undefined {
    if (!reqId) return undefined;
    for (const state of turns.values()) {
      if (state.turnId === reqId) return state;
    }
    return undefined;
  }

  return bridge;
}

interface UsageMeta {
  promptTokens?: number;
  completionTokens?: number;
  ttfbMs?: number;
  provider?: string;
  model?: string;
}

/**
 * 从 `message:complete` payload 里尝试挖 usage 信息。目前只识别几种常见形状：
 * - `message.meta.usage = { promptTokens, completionTokens, provider, model, ttfbMs }`
 * - `message.meta.tokens = { prompt, completion }`（Anthropic 风格）
 *
 * 找不到就返回 undefined，metrics 不 inc。
 */
function extractUsage(payload: AIClientEventMap['message:complete']): UsageMeta | undefined {
  const meta = (payload.message as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const usage = (m.usage ?? m.tokens) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    promptTokens: num(usage.promptTokens) ?? num(usage.prompt) ?? num(usage.prompt_tokens),
    completionTokens:
      num(usage.completionTokens) ?? num(usage.completion) ?? num(usage.completion_tokens),
    ttfbMs: num(m.ttfbMs) ?? num(m.ttfb_ms),
    provider: str(m.provider),
    model: str(m.model),
  };
}

function parseErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'string') return undefined;
  // 兼容 P9-4 的 IPC 编码 `[CODE|R|hint:...] message`
  const match = err.match(/^\[([A-Z0-9_]+)\|/);
  return match?.[1];
}
