/**
 * 网关用量事件的字段声明、错误文本清洗，以及旧版「最近请求」条目（userData/gateway/requests.json）
 * 的结构与读回校验（只用于导入模型质量账本，docs/design/model-quality.md §4.2）。纯函数，不做 IO。
 *
 * 口径说明（避免重复计费）：网关事件**不写入用量账本**。Nomi 自己的对话由 ai-runtime 记账（client 'nomi'），
 * 各编程助手（claude / codex / gemini / grok / dsh）的用量以它们自己的会话日志为准（UsageLogScanner），
 * 经网关的请求同样会出现在这些日志里。网关事件只进模型质量。
 */
import { redactText } from '@nomi-ai/gateway';

/** 网关进程发来的用量事件（与 @nomi-ai/gateway 的 UsageEvent 对应；这里只声明用到的字段） */
export interface GatewayUsageEventLike {
  client: string;
  ingress: string;
  wire?: string;
  provider?: string;
  keyId?: string;
  model?: string;
  status: number;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  startedAt: number;
  ms: number;
  firstByteMs?: number;
  attempts: number;
  error?: string;
  notes?: string[];
  /** 诊断追踪 id（诊断日志开着时网关才给，§8.3） */
  traceId?: string;
  /** 请求来自哪个标签（带标签令牌的第三方会话，§6.7）与进程代次 */
  tabId?: string;
  generation?: number;
  /** 模型怎么解析出来的（explicit / tier / helper / subagent / binding / unknown / default） */
  resolved?: string;
}

/** 模型解析方式的取值（与网关 ModelResolution 一致） */
export const MODEL_RESOLUTIONS = [
  'explicit',
  'tier',
  'helper',
  'subagent',
  'binding',
  'unknown',
  'default',
] as const;

/** 请求日志的一条（只有元数据：不含提示词和回复内容，不含 Key） */
export interface GatewayRequestEntry {
  id: string;
  ts: number;
  client: string;
  /** 入口协议 */
  ingress: string;
  /** 上游协议（没走到上游的失败请求没有） */
  wire?: string;
  providerId?: string;
  /** 供应商显示名（记录时解析，供应商删掉后仍可读） */
  provider?: string;
  keyId?: string;
  /** Key 的名字（没有名字时是掩码），绝不是 Key 本身 */
  key?: string;
  model?: string;
  status: number;
  ms: number;
  firstByteMs?: number;
  /** 尝试次数；> 1 表示发生了回退 / 重试 */
  attempts: number;
  /** 未命中缓存的输入 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  notes?: string[];
  error?: string;
  /** 诊断追踪 id：对应 userData/gateway/trace 里的文件与响应头 x-nomi-trace-id */
  traceId?: string;
  tabId?: string;
  generation?: number;
  resolved?: (typeof MODEL_RESOLUTIONS)[number];
}

/** 最多保留的条数 */
const GATEWAY_REQUEST_CAP = 200;
/** 错误信息最多保留的字符数 */
export const GATEWAY_ERROR_MAX = 300;

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

/** 错误信息：脱敏 + 截断 */
export function cleanError(msg: string | undefined): string | undefined {
  if (!msg) return undefined;
  const r = redactText(msg).replace(/\s+/g, ' ').trim();
  return r.length > GATEWAY_ERROR_MAX ? `${r.slice(0, GATEWAY_ERROR_MAX)}…` : r;
}

/**
 * 网关事件 → 日志条目。token 口径统一成「input 不含缓存」：
 * Anthropic Messages 上游的 input 本来就不含缓存读写；OpenAI / Gemini 的输入数含缓存读，要减掉。
 */
export function toEntry(
  e: GatewayUsageEventLike,
  id: string,
  names?: { provider?: string; key?: string },
): GatewayRequestEntry {
  const u = e.usage ?? {};
  const cacheRead = n(u.cacheReadTokens);
  const cacheWrite = n(u.cacheWriteTokens);
  const rawInput = n(u.inputTokens);
  const input = e.wire === 'messages' ? rawInput : Math.max(0, rawInput - cacheRead);
  const notes = Array.isArray(e.notes)
    ? e.notes.filter((x) => typeof x === 'string' && x).map((x) => redactText(x).slice(0, 120))
    : [];
  const entry: GatewayRequestEntry = {
    id,
    ts: n(e.startedAt),
    client: str(e.client, 32) ?? 'unknown',
    ingress: str(e.ingress, 32) ?? 'unknown',
    status: Math.trunc(n(e.status)),
    ms: Math.round(n(e.ms)),
    attempts: Math.max(1, Math.trunc(n(e.attempts))),
    input,
    output: n(u.outputTokens),
    cacheRead,
    cacheWrite,
  };
  const wire = str(e.wire, 32);
  if (wire) entry.wire = wire;
  const providerId = str(e.provider);
  if (providerId) entry.providerId = providerId;
  const provider = str(names?.provider) ?? providerId;
  if (provider) entry.provider = provider;
  const keyId = str(e.keyId);
  if (keyId) entry.keyId = keyId;
  const key = str(names?.key);
  if (key) entry.key = key;
  const model = str(e.model);
  if (model) entry.model = model;
  if (typeof e.firstByteMs === 'number' && e.firstByteMs >= 0)
    entry.firstByteMs = Math.round(e.firstByteMs);
  if (n(u.reasoningTokens)) entry.reasoning = n(u.reasoningTokens);
  if (notes.length) entry.notes = notes.slice(0, 8);
  const error = cleanError(e.error);
  if (error) entry.error = error;
  if (typeof e.traceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.traceId))
    entry.traceId = e.traceId;
  if (typeof e.tabId === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(e.tabId)) entry.tabId = e.tabId;
  if (Number.isInteger(e.generation) && e.generation! > 0) entry.generation = e.generation;
  const resolved = MODEL_RESOLUTIONS.find((r) => r === e.resolved);
  if (resolved) entry.resolved = resolved;
  return entry;
}

/** 读回磁盘上的条目：字段逐个校验，坏条目丢弃 */
export function sanitizeEntries(raw: unknown): GatewayRequestEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: GatewayRequestEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.ts !== 'number') continue;
    out.push({
      ...toEntry(
        {
          client: String(o.client ?? ''),
          ingress: String(o.ingress ?? ''),
          wire: typeof o.wire === 'string' ? o.wire : undefined,
          provider: typeof o.providerId === 'string' ? o.providerId : undefined,
          keyId: typeof o.keyId === 'string' ? o.keyId : undefined,
          model: typeof o.model === 'string' ? o.model : undefined,
          status: Number(o.status),
          usage: {
            inputTokens: Number(o.input),
            outputTokens: Number(o.output),
            cacheReadTokens: Number(o.cacheRead),
            cacheWriteTokens: Number(o.cacheWrite),
            reasoningTokens: Number(o.reasoning),
          },
          startedAt: o.ts,
          ms: Number(o.ms),
          firstByteMs: typeof o.firstByteMs === 'number' ? o.firstByteMs : undefined,
          attempts: Number(o.attempts),
          error: typeof o.error === 'string' ? o.error : undefined,
          notes: Array.isArray(o.notes) ? (o.notes as string[]) : undefined,
          traceId: typeof o.traceId === 'string' ? o.traceId : undefined,
          tabId: typeof o.tabId === 'string' ? o.tabId : undefined,
          generation: typeof o.generation === 'number' ? o.generation : undefined,
          resolved: typeof o.resolved === 'string' ? o.resolved : undefined,
        },
        o.id,
        {
          provider: typeof o.provider === 'string' ? o.provider : undefined,
          key: typeof o.key === 'string' ? o.key : undefined,
        },
      ),
      // toEntry 按上游协议换算过 input；读回时保持原值
      input: n(o.input),
    });
  }
  return out.slice(-GATEWAY_REQUEST_CAP);
}
