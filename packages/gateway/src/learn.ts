/**
 * 运行时学习（docs/design/unified-gateway.md §7.4）。
 * - 上游失败按错误体分类：接口路径不存在 / 模型不支持这个接口 / 某个可选字段不被接受；
 * - 接口不存在：本次换一个 wire 重试，并对 (供应商, Key, wire) 记 10 分钟短期压制（只影响排序）；
 *   同一 (供应商, wire) 1 小时内对 ≥2 个模型连续 3 次出现，报给主进程「疑似不可用」，
 *   主进程用单协议探测确认后才写 wireDown；
 * - 模型不支持这个接口：报 modelWire（这个模型能走的协议），换 wire 重试；
 * - 可选字段被拒：报 droppedParams，去掉该字段重试。
 * 中转站的错误体最不规范，所以判断偏保守：认不出来的一律不学。
 */
import type { Wire } from './ir';
import type { Candidate } from './route/resolve';

export type LearnEvent =
  | { type: 'model-wire'; providerId: string; model: string; exclude: Wire }
  | { type: 'dropped-param'; providerId: string; wire: Wire; param: string }
  | { type: 'wire-suspect'; providerId: string; wire: Wire; reason: string };

export type Failure =
  | { kind: 'wire-missing' }
  | { kind: 'model-wire' }
  | { kind: 'param'; param: string }
  | { kind: 'other' };

/** 去掉也不影响语义的可选字段（必需字段永远不学，如 model / messages / tools） */
const OPTIONAL_PARAMS = [
  'service_tier',
  'metadata',
  'parallel_tool_calls',
  'store',
  'prompt_cache_key',
  'safety_identifier',
  'user',
  'seed',
  'logprobs',
  'top_logprobs',
  'stream_options',
  'reasoning_effort',
  'include',
  'prediction',
  'modalities',
  'verbosity',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'response_format',
  'truncation',
  'background',
] as const;

const UNSUPPORTED = /not\s+supported|unsupported|does\s+not\s+support|not\s+support|不支持/i;
const UNKNOWN_FIELD =
  /unrecognized|unknown\s+(parameter|field|argument)|extra\s+(inputs|fields)|not\s+permitted|unexpected\s+(field|parameter|keyword)/i;
const MODEL_MISSING =
  /model[^.]{0,60}(not\s+found|does\s+not\s+exist|not\s+exist|unknown|invalid|no\s+such|不存在)|(no\s+such|unknown|invalid)\s+model|模型[^。]{0,20}不存在/i;
const ENDPOINT_WORDS =
  /endpoint|interface|\bapi\b|chat\/completions|\/responses|\/messages|generatecontent|接口/i;

const word = (p: string) => new RegExp(`(^|[^a-z_])${p}([^a-z_]|$)`, 'i');

/** 按状态码与错误体分类；sent 是发给上游的请求体（只在它确实带了那个字段时才认定字段被拒） */
export function classifyFailure(status: number, text: string, sent: unknown): Failure {
  const keys =
    sent && typeof sent === 'object' && !Array.isArray(sent)
      ? Object.keys(sent as Record<string, unknown>)
      : [];
  if (status === 404 || status === 405) {
    // 「模型不存在」也常用 404：那是模型的问题，不是接口的
    return MODEL_MISSING.test(text) ? { kind: 'other' } : { kind: 'wire-missing' };
  }
  if (status === 400 || status === 422) {
    if (UNSUPPORTED.test(text) || UNKNOWN_FIELD.test(text)) {
      const param = OPTIONAL_PARAMS.find((p) => keys.includes(p) && word(p).test(text));
      if (param) return { kind: 'param', param };
      if (UNSUPPORTED.test(text) && /model/i.test(text) && ENDPOINT_WORDS.test(text))
        return { kind: 'model-wire' };
    }
    if (/not\s+found|no\s+route|unknown\s+(url|path)/i.test(text) && ENDPOINT_WORDS.test(text))
      return { kind: 'wire-missing' };
  }
  return { kind: 'other' };
}

export const SUPPRESS_MS = 10 * 60_000;
const STREAK_WINDOW_MS = 60 * 60_000;
const STREAK_HITS = 3;
const STREAK_MODELS = 2;

/** 按 Candidate 记账用的模型名（去掉供应商前缀） */
export const modelOf = (c: Candidate) => c.publicModel.slice(c.provider.id.length + 1);

export class Learner {
  /** (供应商|Key|wire) → 压制到期时间 */
  private readonly suppressedUntil = new Map<string, number>();
  /** (供应商|wire) → 连续失败记录 */
  private readonly streaks = new Map<string, Array<{ at: number; model: string }>>();
  /** 已经报过疑似不可用、还没被成功打断的 (供应商|wire) */
  private readonly reported = new Set<string>();

  constructor(
    private readonly onLearn: (e: LearnEvent) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  isSuppressed(c: Candidate): boolean {
    const until = this.suppressedUntil.get(`${c.provider.id}|${c.key.id}|${c.wire}`);
    return until !== undefined && until > this.now();
  }

  success(c: Candidate): void {
    const k = `${c.provider.id}|${c.wire}`;
    this.streaks.delete(k);
    this.reported.delete(k);
    this.suppressedUntil.delete(`${c.provider.id}|${c.key.id}|${c.wire}`);
  }

  /** 记一次失败，返回这次请求该怎么重试（null = 不按学习重试） */
  failure(c: Candidate, f: Failure): { excludeWire: Wire } | { dropParam: string } | null {
    const now = this.now();
    const pid = c.provider.id;
    if (f.kind === 'param') {
      this.onLearn({ type: 'dropped-param', providerId: pid, wire: c.wire, param: f.param });
      return { dropParam: f.param };
    }
    if (f.kind === 'model-wire') {
      this.onLearn({ type: 'model-wire', providerId: pid, model: modelOf(c), exclude: c.wire });
      return { excludeWire: c.wire };
    }
    if (f.kind !== 'wire-missing') return null;
    this.suppressedUntil.set(`${pid}|${c.key.id}|${c.wire}`, now + SUPPRESS_MS);
    const k = `${pid}|${c.wire}`;
    const hits = [...(this.streaks.get(k) ?? []), { at: now, model: modelOf(c) }].filter(
      (h) => now - h.at < STREAK_WINDOW_MS,
    );
    this.streaks.set(k, hits);
    if (
      !this.reported.has(k) &&
      hits.length >= STREAK_HITS &&
      new Set(hits.map((h) => h.model)).size >= STREAK_MODELS
    ) {
      this.reported.add(k);
      this.onLearn({
        type: 'wire-suspect',
        providerId: pid,
        wire: c.wire,
        reason: `${hits.length} 次接口不存在（${[...new Set(hits.map((h) => h.model))].join('、')}）`,
      });
    }
    return { excludeWire: c.wire };
  }
}
