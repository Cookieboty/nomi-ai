/**
 * 模型名 → 候选列表（docs/design/unified-gateway.md §6.2、§7.2）。
 */
import {
  builtinSlot,
  clientSpecOf,
  slotIsSet,
  slotModel,
  type ModelResolution,
} from '../clients/index';
import type {
  ClientId,
  ClientModels,
  GatewayConfig,
  LearnedState,
  RuntimeKey,
  RuntimeProvider,
} from '../config';
import type { Wire } from '../ir';
import { quirksOf } from '../providers/index';

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
  /** Responses 上游拒绝过 custom 工具：custom 改成函数发出，回程还原（§11.3 customToolsRefused） */
  customToolsAsFunctions?: boolean;
}

export type ResolveResult =
  | {
      ok: true;
      candidates: Candidate[];
      /** 模型是怎么解析出来的（§6.7）与要追加的请求备注 */
      resolution?: { how: ModelResolution; note?: string };
    }
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

/** 模型名映射的结果：映射到的 `供应商/模型` 与它是怎么来的（请求日志展示，§6.7） */
export interface MappedModel {
  ref: string;
  how: ModelResolution;
  /** 请求备注（未知模型名按主模型处理时） */
  note?: string;
}

/**
 * CLI 写死的模型名映射到客户端配置（§6.7 第 2～5 步），规则来自客户端规格（clients/）：
 * 内置档位名 → tiers（haiku 退到旧版 small），辅助模型名 → summary，子代理 → subagent，都退到 main；
 * 规格不认识的名字：有标签绑定时按主模型处理并记备注（不让拼写错误被静默丢弃，G6），
 * 没有绑定时按规格的 unknownToMain。
 */
export function mapModel(
  client: ClientId | string | null,
  models: ClientModels | undefined,
  requested: string,
  bound = false,
): MappedModel | null {
  if (!models) return null;
  const main = models.main;
  if (!requested) return main ? { ref: main, how: bound ? 'binding' : 'default' } : null;
  const spec = clientSpecOf(client);
  if (!spec) return null;
  const hit = builtinSlot(spec, requested);
  if (hit) {
    const ref = slotModel(models, hit.slot);
    if (!ref) return null;
    // 槽位没单独设、退到了主模型：按「主模型 / 绑定」记，不记成档位
    const fellBack = hit.slot !== 'main' && !slotIsSet(models, hit.slot);
    const how = hit.how === 'default' || fellBack ? (bound ? 'binding' : 'default') : hit.how;
    return { ref, how };
  }
  if (!main) return null;
  if (bound)
    return {
      ref: main,
      how: 'unknown',
      note: `未知模型名 ${requested}，已按标签主模型处理`,
    };
  return spec.unknownToMain ? { ref: main, how: 'default' } : null;
}

/** 兼容入口：只要映射到的模型名 */
export function mapBuiltinModel(
  client: ClientId | null,
  models: ClientModels | undefined,
  requested: string,
): string | null {
  return mapModel(client, models, requested)?.ref ?? null;
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
      ...(quirksOf(c.provider, c.wire).dropParams ?? []),
      ...(learned?.droppedParams?.[c.wire] ?? []),
    ]),
  ];
  const model = c.publicModel.slice(c.provider.id.length + 1);
  const customOff = c.wire === 'responses' && learned?.customToolsRefused?.includes(model);
  return drops.length || customOff
    ? {
        ...c,
        ...(drops.length ? { dropParams: drops } : {}),
        ...(customOff ? { customToolsAsFunctions: true } : {}),
      }
    : c;
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
  const { dropParams: _ignored, customToolsAsFunctions: _custom, ...rest } = c;
  return withDrops({ ...rest, wire }, learned);
}

/** 展开一个 (供应商, 模型) 的候选：每个可用 Key 一个，各自选 wire */
function expand(
  cfg: GatewayConfig,
  p: RuntimeProvider,
  model: string,
  ingress: Wire | null,
): Candidate[] {
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

/**
 * 模型名 → 候选。顺序（§6.7）：显式的 `供应商/模型`（或唯一命中的裸名）→ 规格的档位 / 辅助 / 子代理 →
 * 标签绑定的主模型（未知名记备注）→ 客户端级的默认（终端里手动启动、没有标签绑定的 CLI）。
 * binding：这个请求所属标签的模型（TabBinding.models），优先于客户端级配置。
 */
export function resolveCandidates(
  cfg: GatewayConfig,
  client: ClientId | string | null,
  requested: string,
  ingress: Wire | null,
  binding?: { models: ClientModels } | null,
): ResolveResult {
  const models = binding?.models ?? (client ? cfg.clients[client as ClientId]?.models : undefined);
  const home = models?.main ? splitRef(models.main).provider : null;
  let target = requested ? resolveRef(cfg, requested, home) : null;
  let resolution: { how: ModelResolution; note?: string } = { how: 'explicit' };
  if (!target) {
    const mapped = mapModel(client, models, requested, Boolean(binding));
    if (mapped) {
      target = resolveRef(cfg, mapped.ref, home);
      resolution = { how: mapped.how, ...(mapped.note ? { note: mapped.note } : {}) };
    }
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
  return { ok: true, candidates, resolution };
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
  // SDK 尚未选入口，不能触发同协议透传规则，否则会掩盖 Responses / 厂商协议偏好。
  const r = resolveCandidates(cfg, client, ref, null);
  if (!r.ok) return null;
  const c = r.candidates[0]!;
  // 入口确定后按实际请求重新展开回退，隐私判断必须覆盖真正可能接收请求的地址。
  const routed = resolveCandidates(cfg, client, ref, c.wire);
  if (!routed.ok) return null;
  const upstreams: Array<{ providerId: string; name: string; url: string }> = [];
  const add = (x: Candidate, url: string) => {
    if (!upstreams.some((u) => u.providerId === x.provider.id && u.url === url))
      upstreams.push({ providerId: x.provider.id, name: x.provider.name, url });
  };
  for (const x of routed.candidates) {
    add(x, x.provider.urls[x.wire] ?? '');
    // 运行时还可能换到同一个 Key 的其它协议（alternateWire / 学习重试），那些地址也可能收到请求：
    // 按 Key 限定能走的全部地址都算上，取严（#100）
    for (const w of Object.keys(x.provider.urls) as Wire[]) {
      const url = x.provider.urls[w];
      if (url && w !== x.wire && (!x.key.wire || x.key.wire === w)) add(x, url);
    }
  }
  return { wire: c.wire, publicModel: c.publicModel, upstreams };
}
