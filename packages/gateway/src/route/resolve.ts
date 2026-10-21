/**
 * 模型名 → 候选列表（docs/design/unified-gateway.md §6.2、§7.2）。
 */
import type {
  ClientId,
  ClientModels,
  GatewayConfig,
  LearnedState,
  RuntimeKey,
  RuntimeProvider,
} from '../config';
import type { Wire } from '../ir';

import { pickWire, wiresFor } from './native';

export interface Candidate {
  provider: RuntimeProvider;
  key: RuntimeKey;
  /** 对外名 provider/model（用于用量、回写响应里的 model） */
  publicModel: string;
  /** 发给上游的真实模型名（经 modelMap） */
  upstreamModel: string;
  wire: Wire;
  /** 发给上游前去掉的顶层字段（厂商 quirks + 运行时学到的 + 本次重试要去掉的，§7.4） */
  dropParams?: string[];
}

export type ResolveResult =
  | { ok: true; candidates: Candidate[] }
  | { ok: false; status: 404 | 400; message: string; suggestions?: string[] };

/** 按第一个 `/` 切分；没有 `/` 时 provider 为 null（裸模型名） */
export function splitRef(ref: string): { provider: string | null; model: string } {
  const i = ref.indexOf('/');
  return i > 0
    ? { provider: ref.slice(0, i), model: ref.slice(i + 1) }
    : { provider: null, model: ref };
}

export function findProvider(cfg: GatewayConfig, id: string): RuntimeProvider | undefined {
  const enabled = cfg.providers.filter((p) => p.enabled);
  return enabled.find((p) => p.id === id) ?? enabled.find((p) => p.aliases?.includes(id));
}

/**
 * CLI 写死的模型名映射到客户端配置（§7.2 第 1 步）：
 * Claude Code 的 claude-*（haiku → small，opus / sonnet / fable 按档位，其余 → main），Codex 的内部名 → main。
 */
export function mapBuiltinModel(
  client: ClientId | null,
  models: ClientModels | undefined,
  requested: string,
): string | null {
  if (!models) return null;
  if (!requested) return models.main ?? null;
  if (client === 'claude' && /claude|^(opus|sonnet|haiku|fable|default)$/i.test(requested)) {
    const r = requested.toLowerCase();
    for (const tier of ['opus', 'sonnet', 'haiku', 'fable'] as const) {
      if (r.includes(tier))
        return (
          models.tiers?.[tier] ??
          (tier === 'haiku' ? models.small : undefined) ??
          models.main ??
          null
        );
    }
    return models.main ?? null;
  }
  if (client === 'codex' || client === 'grok' || client === 'dsh' || client === 'gemini')
    return models.main ?? null;
  return null;
}

/** 解析 provider/model（§6.2 第 1～3 步）；找不到返回 null */
function resolveRef(
  cfg: GatewayConfig,
  ref: string,
  homeProvider: string | null,
): { provider: RuntimeProvider; model: string } | null {
  const { provider: pid, model } = splitRef(ref);
  if (pid) {
    const p = findProvider(cfg, pid);
    if (p) return { provider: p, model };
  }
  // 裸模型名（或前缀不是供应商 id 的带 / 模型名）：先在客户端主模型所属的供应商里找，再找唯一命中
  const name = ref;
  if (homeProvider) {
    const home = findProvider(cfg, homeProvider);
    if (home?.models.some((m) => m.id === name)) return { provider: home, model: name };
  }
  const hits = cfg.providers.filter((p) => p.enabled && p.models.some((m) => m.id === name));
  return hits.length === 1 ? { provider: hits[0]!, model: name } : null;
}

function upstreamName(p: RuntimeProvider, model: string): string {
  return p.modelMap?.find((m) => m.from === model)?.to ?? model;
}

/** 最接近的候选（404 时提示用户） */
function suggest(cfg: GatewayConfig, requested: string): string[] {
  const q = splitRef(requested).model.toLowerCase();
  const all = cfg.providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.filter((m) => m.enabled).map((m) => `${p.id}/${m.id}`));
  const head = q.split(/[-_.]/)[0] ?? q;
  return all
    .filter(
      (r) => r.toLowerCase().includes(q) || (head.length >= 3 && r.toLowerCase().includes(head)),
    )
    .slice(0, 3);
}

function withDrops(c: Candidate, learned: LearnedState | undefined): Candidate {
  const drops = [
    ...new Set([
      ...(c.provider.quirks?.dropParams ?? []),
      ...(learned?.droppedParams?.[c.wire] ?? []),
    ]),
  ];
  return drops.length ? { ...c, dropParams: drops } : c;
}

/**
 * 同一个 (供应商, Key, 模型) 换一个协议（§7.4：接口不存在 / 模型不支持这个接口时本次重试用）；
 * 没有别的协议可走时返回 null。
 */
export function alternateWire(
  cfg: GatewayConfig,
  c: Candidate,
  ingress: Wire,
  exclude: readonly Wire[],
): Candidate | null {
  const model = c.publicModel.slice(c.provider.id.length + 1);
  const learned = cfg.learned?.[c.provider.id];
  const usable = wiresFor(c.provider, model, c.key, learned).filter((w) => !exclude.includes(w));
  const wire = pickWire(c.provider, model, ingress, usable);
  if (!wire) return null;
  const { dropParams: _ignored, ...rest } = c;
  return withDrops({ ...rest, wire }, learned);
}

/** 展开一个 (供应商, 模型) 的候选：每个可用 Key 一个，各自选 wire */
function expand(cfg: GatewayConfig, p: RuntimeProvider, model: string, ingress: Wire): Candidate[] {
  const out: Candidate[] = [];
  const learned = cfg.learned?.[p.id];
  const upstreamModel = upstreamName(p, model);
  for (const key of p.keys.filter((k) => k.enabled)) {
    const wire = pickWire(p, model, ingress, wiresFor(p, model, key, learned));
    if (wire)
      out.push(
        withDrops(
          { provider: p, key, publicModel: `${p.id}/${model}`, upstreamModel, wire },
          learned,
        ),
      );
  }
  return out;
}

export function resolveCandidates(
  cfg: GatewayConfig,
  client: ClientId | null,
  requested: string,
  ingress: Wire,
): ResolveResult {
  const models = client ? cfg.clients[client]?.models : undefined;
  const home = models?.main ? splitRef(models.main).provider : null;
  let target = requested ? resolveRef(cfg, requested, home) : null;
  if (!target) {
    const mapped = mapBuiltinModel(client, models, requested);
    if (mapped) target = resolveRef(cfg, mapped, home);
  }
  if (!target) {
    const suggestions = suggest(cfg, requested);
    return {
      ok: false,
      status: 404,
      message: requested
        ? `Nomi 网关：模型 \`${requested}\` 不存在${suggestions.length ? `，最接近的是 ${suggestions.map((s) => `\`${s}\``).join('、')}` : ''}`
        : 'Nomi 网关：请求里没有模型名，这个客户端也没有设置默认模型',
      suggestions,
    };
  }
  const candidates = expand(cfg, target.provider, target.model, ingress);
  for (const ref of target.provider.fallback ?? []) {
    const fb = resolveRef(cfg, ref, null);
    if (fb) candidates.push(...expand(cfg, fb.provider, fb.model, ingress));
  }
  if (!candidates.length) {
    return {
      ok: false,
      status: 400,
      message: `Nomi 网关：供应商「${target.provider.name}」没有可用的 Key 或协议地址`,
    };
  }
  return { ok: true, candidates };
}

/**
 * 给自带 SDK 的客户端（Nomi 对话）选入口协议（§12.5）：用候选列表第一项「自己会选的协议」，
 * 这样网关那一侧是同协议透传，没有转换损失。解析不到返回 null。
 */
export function preferredWire(
  cfg: GatewayConfig,
  client: ClientId,
  ref: string,
): {
  wire: Wire;
  publicModel: string;
  /** 可能收到这次请求的上游（首选在前，之后是回退），去重；隐私判断要看全部 */
  upstreams: Array<{ providerId: string; name: string; url: string }>;
} | null {
  // 以 Chat 为入口算一遍：规则 2 / 3 / 4.5 / 5 都与入口无关，Chat 可用时就用 Chat（实现最完整）
  const r = resolveCandidates(cfg, client, ref, 'chat');
  if (!r.ok) return null;
  const c = r.candidates[0]!;
  const upstreams: Array<{ providerId: string; name: string; url: string }> = [];
  for (const x of r.candidates) {
    const url = x.provider.urls[x.wire] ?? '';
    if (!upstreams.some((u) => u.providerId === x.provider.id && u.url === url))
      upstreams.push({ providerId: x.provider.id, name: x.provider.name, url });
  }
  return { wire: c.wire, publicModel: c.publicModel, upstreams };
}
