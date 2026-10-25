/**
 * 协议探测（docs/design/unified-gateway.md §8）：
 * 地址规范化 → 拉模型列表（顺带判断鉴权方式）→ 四种协议并行发最小请求 → 按 Key 记录结果。
 * 探测会消耗极少量 token（每种协议最多输出 1～16 个 token）。
 */
import type { AuthStyle, ProbeState } from '../config';
import type { Wire } from '../ir';
import { WIRES } from '../ir';
import { createUpstreamFetch } from '../net/upstreamFetch';
import { checkUpstream, type LookupAll } from '../net/upstreamGuard';
import { upstreamUrl } from '../upstream';

/* ------------------------------ 地址规范化（§8.1） ------------------------------ */

const ENDPOINT_SUFFIX =
  /\/(?:v1\/)?(?:chat\/completions|responses|messages(?:\/count_tokens)?|completions|models\/[^/]+:(?:stream)?generateContent(?:\?.*)?|models)$/i;

/** 用户贴的任意形式 → 每种协议的候选 base */
export function normalizeBases(raw: string): Partial<Record<Wire, string>> {
  let s = raw.trim().replace(/\/+$/, '');
  if (!s) return {};
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(ENDPOINT_SUFFIX, '').replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return {};
  }
  const origin = `${u.protocol}//${u.host}`;
  const path = u.pathname.replace(/\/+$/, '');
  const openai = path ? `${origin}${path}` : `${origin}/v1`;
  const messages = `${origin}${path.replace(/\/v1$/, '')}`;
  const gemini = !path || path === '/v1' ? `${origin}/v1beta` : `${origin}${path}`;
  return { chat: openai, responses: openai, messages, gemini };
}

/* ------------------------------ 探测（§8.2） ------------------------------ */

export interface ProbeKey {
  id: string;
  value: string;
}

export interface ProbeLine extends ProbeState {
  wire: Wire;
  url: string;
  status?: number;
  model?: string;
  error?: string;
  ms: number;
}

export interface DetectResult {
  /** 任一 Key 可用即 ok */
  wires: Partial<Record<Wire, ProbeLine>>;
  byKey: Record<string, Partial<Record<Wire, ProbeLine>>>;
  /** 拉到的模型列表（可能为空） */
  models: string[];
  /** 模型列表接口顺带返回的上下文 / 输出上限（§12.7.2 第 3 级；没返回的模型不在里面） */
  limits?: Record<string, ListedLimits>;
  /** 可用的协议地址 */
  urls: Partial<Record<Wire, string>>;
}

export interface DetectOptions {
  /** 每种协议的 base（预设写明的地址优先；没写的用 normalizeBases 推导） */
  bases: Partial<Record<Wire, string>>;
  keys: ProbeKey[];
  /** 没有模型列表时用的测试模型 */
  fallbackModel?: string;
  timeoutMs?: number;
  /** 同时探测的 Key 数上限 */
  concurrency?: number;
  fetchImpl?: typeof fetch;
  allowedPrivateHosts?: string[];
  selfPort?: number;
  lookupAll?: LookupAll;
}

const TIMEOUT_MS = 15_000;

/** 不能用来测对话接口的模型（图像、向量、语音、视频等） */
const NON_CHAT = /image|embed|tts|whisper|dall-e|audio|speech|video|seedance|rerank|moderation/i;

function pickModel(wire: Wire, all: string[], fallback?: string): string | undefined {
  const models = all.filter((m) => !NON_CHAT.test(m));
  const by = (re: RegExp) => models.find((m) => re.test(m.split('/').pop() ?? m));
  if (wire === 'messages') return by(/^claude/i) ?? models[0] ?? fallback;
  if (wire === 'responses') return by(/^(gpt-|codex|o[0-9])/i) ?? models[0] ?? fallback;
  if (wire === 'gemini') return by(/^gemini/i) ?? models[0] ?? fallback;
  return models[0] ?? fallback;
}

function probeBody(wire: Wire, model: string): unknown {
  const messages = [{ role: 'user', content: 'hi' }];
  switch (wire) {
    case 'messages':
      return { model, max_tokens: 1, messages };
    case 'responses':
      // 部分 Responses 实现拒绝小于 16 的输出上限
      return { model, max_output_tokens: 16, input: 'hi' };
    case 'chat':
      return { model, max_tokens: 1, messages };
    case 'gemini':
      return { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } };
  }
}

function authHeaders(wire: Wire, auth: AuthStyle, key: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  // 本地服务没有 Key：不发鉴权头
  if (key) {
    if (auth === 'x-api-key') h['x-api-key'] = key;
    else if (auth === 'x-goog-api-key') h['x-goog-api-key'] = key;
    else h.Authorization = `Bearer ${key}`;
  }
  if (wire === 'messages') h['anthropic-version'] = '2023-06-01';
  return h;
}

/** 400 且错误体是协议格式、针对参数：接口存在 */
function looksLikeParamError(text: string): boolean {
  try {
    const j = JSON.parse(text) as { error?: unknown; type?: unknown };
    return Boolean(j.error || j.type === 'error');
  } catch {
    return false;
  }
}

function outboundFetch(o: DetectOptions): typeof fetch {
  if (o.fetchImpl) return o.fetchImpl;
  return createUpstreamFetch({
    getGuard: () => ({
      allowedPrivateHosts: o.allowedPrivateHosts,
      selfPort: o.selfPort,
      lookupAll: o.lookupAll,
    }),
  }) as unknown as typeof fetch;
}

async function guarded(url: string, o: DetectOptions): Promise<string | null> {
  try {
    await checkUpstream(url, {
      allowedPrivateHosts: o.allowedPrivateHosts,
      selfPort: o.selfPort,
      lookupAll: o.lookupAll,
    });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export interface ListedLimits {
  ctx?: number;
  maxOutput?: number;
}

const posInt = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * 模型列表里一项带的上限。各家字段名不同：OpenRouter `context_length` /
 * `top_provider.max_completion_tokens`、vLLM `max_model_len`、Gemini `inputTokenLimit` /
 * `outputTokenLimit`、其它中转的 `context_window` / `max_output_tokens` 等。
 */
export function listedLimits(item: unknown): ListedLimits | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const o = item as Record<string, unknown>;
  const top = (o.top_provider ?? {}) as Record<string, unknown>;
  const first = (...vs: unknown[]) => vs.map(posInt).find((n) => n !== undefined);
  const ctx = first(
    o.context_length,
    o.context_window,
    o.max_context_length,
    o.max_model_len,
    o.max_input_tokens,
    o.inputTokenLimit,
    o.input_token_limit,
    top.context_length,
  );
  const maxOutput = first(
    o.max_output_tokens,
    o.max_completion_tokens,
    o.outputTokenLimit,
    o.output_token_limit,
    top.max_completion_tokens,
  );
  return ctx || maxOutput
    ? { ...(ctx ? { ctx } : {}), ...(maxOutput ? { maxOutput } : {}) }
    : undefined;
}

/** GET {chat base}/models：分别用 Bearer 和 x-api-key 试，得到模型列表、上限与鉴权方式 */
async function listModels(
  o: DetectOptions,
  key: string,
): Promise<{ models: string[]; limits?: Record<string, ListedLimits>; auth?: AuthStyle }> {
  const base = o.bases.chat ?? o.bases.responses;
  if (!base) return { models: [] };
  const url = `${base.replace(/\/+$/, '')}/models`;
  if (await guarded(url, o)) return { models: [] };
  for (const auth of ['bearer', 'x-api-key'] as AuthStyle[]) {
    try {
      const res = await outboundFetch(o)(url, {
        headers: authHeaders('chat', auth, key),
        redirect: 'manual',
        signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as {
        data?: Array<{ id?: unknown }>;
        models?: Array<{ name?: unknown; id?: unknown }>;
      };
      const models: string[] = [];
      const limits: Record<string, ListedLimits> = {};
      for (const m of j.data ?? j.models ?? []) {
        const id =
          typeof m.id === 'string'
            ? m.id
            : typeof (m as { name?: unknown }).name === 'string'
              ? String((m as { name: string }).name).replace(/^models\//, '')
              : '';
        if (!id) continue;
        models.push(id);
        const l = listedLimits(m);
        if (l) limits[id] = l;
      }
      return { models, ...(Object.keys(limits).length ? { limits } : {}), auth };
    } catch {
      /* 换一种鉴权再试 */
    }
  }
  return { models: [] };
}

async function probeWire(
  wire: Wire,
  base: string,
  key: ProbeKey,
  model: string | undefined,
  auth: AuthStyle,
  o: DetectOptions,
): Promise<ProbeLine> {
  const t0 = Date.now();
  if (!model)
    return { wire, url: base, ok: false, error: '没有可用来测试的模型名，请手动填写一个', ms: 0 };
  const url = upstreamUrl(wire, base, model);
  const blocked = await guarded(url, o);
  if (blocked) return { wire, url: base, ok: false, error: blocked, ms: 0 };
  const attempt = async (style: AuthStyle) => {
    const res = await outboundFetch(o)(url, {
      method: 'POST',
      headers: authHeaders(wire, style, key.value),
      body: JSON.stringify(probeBody(wire, model)),
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
    });
    return { res, text: await res.text().catch(() => '') };
  };
  try {
    let { res, text } = await attempt(auth);
    let used = auth;
    // Messages / Chat 接口有的只认另一种鉴权（§8.3）
    if ((res.status === 401 || res.status === 403) && (wire === 'messages' || wire === 'chat')) {
      const alt: AuthStyle = auth === 'bearer' ? 'x-api-key' : 'bearer';
      const second = await attempt(alt);
      if (second.res.ok || second.res.status === 400) {
        res = second.res;
        text = second.text;
        used = alt;
      }
    }
    const ms = Date.now() - t0;
    if (res.ok) return { wire, url: base, ok: true, status: res.status, model, auth: used, ms };
    if (res.status === 401 || res.status === 403)
      return {
        wire,
        url: base,
        ok: false,
        status: res.status,
        model,
        error: 'Key 无效或没有权限（鉴权失败）',
        ms,
      };
    if (res.status === 400 && looksLikeParamError(text))
      return { wire, url: base, ok: true, status: 400, model, auth: used, ms };
    return {
      wire,
      url: base,
      ok: false,
      status: res.status,
      model,
      error: `HTTP ${res.status}`,
      ms,
    };
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = (e as Error).name === 'TimeoutError';
    return {
      wire,
      url: base,
      ok: false,
      model,
      error: timedOut ? '超时' : `连接失败：${(e as Error).message}`,
      ms,
    };
  }
}

const DEFAULT_AUTH: Record<Wire, AuthStyle> = {
  messages: 'x-api-key',
  responses: 'bearer',
  chat: 'bearer',
  gemini: 'x-goog-api-key',
};

export async function detect(o: DetectOptions): Promise<DetectResult> {
  const keys = o.keys.length ? o.keys : [{ id: 'none', value: '' }];
  const listed = await listModels(o, keys[0]!.value);
  const byKey: DetectResult['byKey'] = {};
  const queue = [...keys];
  const workers = Array.from({ length: Math.min(o.concurrency ?? 4, queue.length) }, async () => {
    for (let k = queue.shift(); k; k = queue.shift()) {
      const key = k;
      const lines = await Promise.all(
        WIRES.filter((w) => o.bases[w]).map((w) => {
          const auth = w === 'chat' && listed.auth ? listed.auth : DEFAULT_AUTH[w];
          return probeWire(
            w,
            o.bases[w]!,
            key,
            pickModel(w, listed.models, o.fallbackModel),
            auth,
            o,
          );
        }),
      );
      // 聚合网关常按模型返回 401 / 403 或长时间不响应：同一个 Key 在别的协议上已经成功时，换那个模型再测一次
      const okModel = lines.find((l) => l.ok)?.model;
      if (okModel) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i]!;
          const modelSpecific = l.status === 401 || l.status === 403 || l.error === '超时';
          if (l.ok || !modelSpecific || l.model === okModel) continue;
          lines[i] = await probeWire(
            l.wire,
            o.bases[l.wire]!,
            key,
            okModel,
            DEFAULT_AUTH[l.wire],
            o,
          );
        }
      }
      byKey[key.id] = Object.fromEntries(lines.map((l) => [l.wire, l]));
    }
  });
  await Promise.all(workers);
  const wires: DetectResult['wires'] = {};
  for (const w of WIRES) {
    const lines = Object.values(byKey)
      .map((x) => x[w])
      .filter((x): x is ProbeLine => Boolean(x));
    if (!lines.length) continue;
    wires[w] = lines.find((l) => l.ok) ?? lines[0];
  }
  const urls = Object.fromEntries(
    (Object.entries(wires) as Array<[Wire, ProbeLine]>)
      .filter(([, l]) => l.ok)
      .map(([w]) => [w, o.bases[w]!]),
  ) as Partial<Record<Wire, string>>;
  return {
    wires,
    byKey,
    models: listed.models,
    ...(listed.limits ? { limits: listed.limits } : {}),
    urls,
  };
}
