/**
 * 路由计划（docs/design/cli-plugin-architecture.md §6.9.4，P7.4）：每个候选一份，可记录、可回放。
 * 选协议从 if 链改成「先过滤、再排序」：过滤沿用 wiresFor（地址、探测、学到的、用户限定、Key 限定），
 * 排序是数据化的规则表，第一条命中的胜出：
 *
 * | 规则            | 条件                                         | 理由 |
 * | --------------- | -------------------------------------------- | ---- |
 * | model-native    | 规格 wires.prefer（Claude → Messages、GPT → Responses、Gemini → Gemini） | 保住签名、加密推理、缓存与思考控制 |
 * | passthrough     | 上游支持入口协议                              | 零转换 |
 * | cache-visible   | 供应商 quirks.responsesTellsCache             | Chat 接口不报缓存用量 |
 * | provider-prefer | 供应商 quirks.preferWire                      | 中转服务的已知最佳入口 |
 * | default-order   | chat → responses → messages → gemini          | 兼容面最广 |
 *
 * 损失（加密推理、签名、缓存控制、自由文本工具、图片…）不参与排序，只记录；quality 由损失推出。
 * 上线方式：影子模式（默认）只算计划、与 pickWire 比对写日志；配置 routePlan: 'active' 后按计划选协议。
 */
import type { RuntimeProvider } from '../config';
import type { Wire } from '../ir';
import type { EffectiveModel } from '../models/types';
import { quirksOf } from '../providers/index';

export type Loss =
  | 'sealed-reasoning'
  | 'signature'
  | 'thought-signature'
  | 'cache-control'
  | 'freeform-tools'
  | 'images'
  | 'passthrough'
  | 'reasoning-control';

export interface RoutePlan {
  ingress: Wire | null;
  upstream: Wire;
  /** 为什么选这个协议（规则 id，按顺序） */
  why: string[];
  /** 预期损失：转换会丢掉什么 */
  losses: Loss[];
  quality: 'lossless' | 'good' | 'degraded';
  /** 影子模式下现有规则（pickWire）选的协议；与 upstream 不同时写日志 */
  legacy?: Wire;
}

const DEFAULT_ORDER: readonly Wire[] = ['chat', 'responses', 'messages', 'gemini'];

/** 排序：第一条命中的规则胜出 */
export function rankWire(
  p: RuntimeProvider,
  m: EffectiveModel | undefined,
  ingress: Wire | null,
  usable: readonly Wire[],
): { wire: Wire; why: string[] } | null {
  if (!usable.length) return null;
  const native = m?.wires?.prefer.find((w) => usable.includes(w));
  if (native)
    return {
      wire: native,
      why: [`model-native:${native}${m?.wires?.reason ? `（${m.wires.reason}）` : ''}`],
    };
  if (ingress && usable.includes(ingress)) return { wire: ingress, why: ['passthrough'] };
  const q = quirksOf(p);
  if (q.responsesTellsCache && usable.includes('responses'))
    return { wire: 'responses', why: ['cache-visible'] };
  if (q.preferWire && usable.includes(q.preferWire))
    return { wire: q.preferWire, why: ['provider-prefer'] };
  const d = DEFAULT_ORDER.find((w) => usable.includes(w));
  return d ? { wire: d, why: ['default-order'] } : null;
}

/** 入口协议 → 上游协议的预期损失 */
export function lossesOf(ingress: Wire | null, upstream: Wire, m?: EffectiveModel): Loss[] {
  const out: Loss[] = [];
  if (!ingress || ingress === upstream) return out;
  if (ingress === 'messages') out.push('signature', 'cache-control');
  if (ingress === 'responses') {
    out.push('sealed-reasoning');
    if (m?.tools?.freeform === false || upstream !== 'responses') out.push('freeform-tools');
  }
  if (ingress === 'gemini') out.push('thought-signature');
  if (m?.input?.images === false) out.push('images');
  if (m?.reasoning?.control === 'none') out.push('reasoning-control');
  return out;
}

export function qualityOf(losses: readonly Loss[]): RoutePlan['quality'] {
  if (!losses.length) return 'lossless';
  return losses.every((l) => l === 'cache-control' || l === 'signature' || l === 'passthrough')
    ? 'good'
    : 'degraded';
}

export function makePlan(
  p: RuntimeProvider,
  m: EffectiveModel | undefined,
  ingress: Wire | null,
  usable: readonly Wire[],
): RoutePlan | null {
  const r = rankWire(p, m, ingress, usable);
  if (!r) return null;
  const losses = lossesOf(ingress, r.wire, m);
  return { ingress, upstream: r.wire, why: r.why, losses, quality: qualityOf(losses) };
}
