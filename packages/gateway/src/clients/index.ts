/**
 * 客户端规格注册表与适配器（§5.5、§6.6）。
 */
import type { ClientModels } from '../config';
import type { Wire } from '../ir';
import { MESSAGES_EVENTS } from '../spec/messages';
import { RESPONSES_EVENTS } from '../spec/responses';
import { SseSplitter } from '../stream/sse';

import { BUILTIN_CLIENT_SPECS, DEFAULT_SESSION_KEY } from './builtin';
import type { ClientAdapterHooks, ClientSpec, ConformContext, ModelSlot } from './types';

export * from './builtin';
export type * from './types';

const specs = new Map<string, ClientSpec>(BUILTIN_CLIENT_SPECS.map((s) => [s.id, s] as const));
const hooks = new Map<string, ClientAdapterHooks>();

/** 登记 / 覆盖一个客户端规格（宿主组装插件时调用） */
export function registerClientSpec(spec: ClientSpec, h?: ClientAdapterHooks): void {
  specs.set(spec.id, spec);
  if (h) hooks.set(spec.id, h);
  else hooks.delete(spec.id);
}

export function clientSpecOf(id: string | null | undefined): ClientSpec | undefined {
  return id ? specs.get(id) : undefined;
}

/** 已登记的客户端 id（内核自带 + 宿主组装的插件），按登记顺序 */
export function registeredClientIds(): string[] {
  return [...specs.keys()];
}

/** 协议规范表里的事件全集（acceptedEvents: 'spec'）；没有事件类型的协议（Chat / Gemini）不过滤 */
function specEvents(wire: Wire): ReadonlySet<string> | null {
  return wire === 'responses' ? RESPONSES_EVENTS : wire === 'messages' ? MESSAGES_EVENTS : null;
}

export function clientHooksOf(id: string | null | undefined): ClientAdapterHooks | undefined {
  return id ? hooks.get(id) : undefined;
}

/** 旧版共享令牌的客户端身份：按规格的 legacy 规则（入口协议 / User-Agent）推断，推断不了返回 null */
export function legacyClientOf(ingress: Wire | null, userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  for (const s of specs.values()) {
    const l = s.legacy;
    if (!l) continue;
    if (l.ingress && ingress === l.ingress) return s.id;
    if (l.userAgent && ua.includes(l.userAgent.toLowerCase())) return s.id;
  }
  return null;
}

/** 会话键规则：给了客户端时用它的规格，否则用默认（与原 affinity.ts 一致） */
export function sessionKeyRules(client: string | null | undefined) {
  return clientSpecOf(client)?.sessionKey ?? DEFAULT_SESSION_KEY;
}

/** 槽位 → 客户端配置里的模型；档位没设时 haiku 退到旧版的 small，其余退到主模型 */
export function slotModel(models: ClientModels, slot: ModelSlot): string | undefined {
  if (slot === 'main') return models.main;
  if (slot.startsWith('tiers.')) {
    const tier = slot.slice(6) as 'opus' | 'sonnet' | 'haiku' | 'fable';
    return models.tiers?.[tier] ?? (tier === 'haiku' ? models.small : undefined) ?? models.main;
  }
  const k = slot as 'summary' | 'subagent' | 'tools';
  return models[k] ?? models.main;
}

/** 这个槽位自己设了模型（没有退到主模型） */
export function slotIsSet(models: ClientModels, slot: ModelSlot): boolean {
  if (slot === 'main') return Boolean(models.main);
  if (slot.startsWith('tiers.')) {
    const tier = slot.slice(6) as 'opus' | 'sonnet' | 'haiku' | 'fable';
    return Boolean(models.tiers?.[tier] ?? (tier === 'haiku' ? models.small : undefined));
  }
  return Boolean(models[slot as 'summary' | 'subagent' | 'tools']);
}

const test = (patterns: string[] | undefined, name: string) =>
  patterns?.some((p) => new RegExp(p, 'i').test(name)) ?? false;

/** 模型名是怎么解析出来的（请求日志里展示，§6.7） */
export type ModelResolution =
  'explicit' | 'tier' | 'helper' | 'subagent' | 'binding' | 'unknown' | 'default';

/**
 * 按规格把 CLI 发来的、不是 `供应商/模型` 的名字映射到槽位（§6.7 第 2～4 步）。
 * 返回 null = 规格不认识这个名字（调用方按 unknownToMain / 绑定决定）。
 */
export function builtinSlot(
  spec: ClientSpec,
  requested: string,
): { slot: ModelSlot; how: ModelResolution } | null {
  for (const r of spec.builtinModels ?? [])
    if (new RegExp(r.pattern, 'i').test(requested))
      return { slot: r.slot, how: r.slot === 'main' ? 'default' : 'tier' };
  if (test(spec.helperModels, requested)) return { slot: 'summary', how: 'helper' };
  if (test(spec.subagentModels, requested)) return { slot: 'subagent', how: 'subagent' };
  return null;
}

/* ------------------------------- conform（§6.6） ------------------------------- */

type Obj = Record<string, unknown>;

const NOTE_DROPPED = (spec: string, type: string) => `已丢掉 ${spec} 不接受的事件 ${type}`;
const NOTE_FILLED = (spec: string, type: string) => `已按 ${spec} 的要求补齐 ${type} 的字段`;

/**
 * 客户端校验（§6.6）：输入是规范事件流，按规格再校验一次。严格客户端：规格之外的事件丢弃、
 * 额外必填补齐，并在备注里记下是哪一级遗漏的；宽松客户端什么都不做（零开销）。
 * 按完整 SSE 事件工作；没有改动的事件原样输出。
 */
export class ClientConformer {
  private readonly split = new SseSplitter();
  private readonly accepted: ReadonlySet<string> | null;

  constructor(private readonly ctx: ConformContext) {
    const a = ctx.spec.acceptedEvents;
    this.accepted = a === 'spec' ? specEvents(ctx.wire) : a ? new Set(a) : null;
  }

  /** 这个规格需要校验吗（宽松且没有钩子 → 不需要） */
  static needed(spec: ClientSpec, h?: ClientAdapterHooks): boolean {
    return spec.strictness === 'strict' || Boolean(spec.extraRequired) || Boolean(h?.conform);
  }

  push(text: string): string {
    let out = '';
    for (const b of this.split.push(text)) out += this.block(b.body + b.sep, b.sep);
    return out;
  }

  end(): string {
    const rest = this.split.take();
    return rest ? this.block(rest, '') : '';
  }

  private note(n: string) {
    if (!this.ctx.notes.includes(n)) this.ctx.notes.push(n);
  }

  private block(block: string, sep: string): string {
    const lines = block.split(/\r?\n/);
    const dataLines = lines.filter((l) => l.startsWith('data:'));
    if (dataLines.length !== 1) return block;
    const event = lines
      .find((l) => l.startsWith('event:'))
      ?.slice(6)
      .trim();
    const raw = dataLines[0]!.slice(5).trim();
    let j: Obj;
    try {
      const v: unknown = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return block;
      j = v as Obj;
    } catch {
      return block;
    }
    const type = typeof j.type === 'string' ? j.type : event;
    const { spec } = this.ctx;
    if (type && this.accepted && !this.accepted.has(type)) {
      this.note(NOTE_DROPPED(spec.id, type));
      return '';
    }
    let changed = false;
    const extra = type ? spec.extraRequired?.[type] : undefined;
    if (extra)
      for (const [k, v] of Object.entries(extra))
        if (j[k] === undefined || j[k] === null) {
          j = { ...j, [k]: v };
          changed = true;
        }
    if (changed && type) this.note(NOTE_FILLED(spec.id, type));
    let ev = { ...(event ? { event } : {}), data: changed ? JSON.stringify(j) : raw };
    const h = clientHooksOf(spec.id)?.conform;
    if (h) {
      const r = h(ev, this.ctx);
      if (!r) return '';
      if (r !== ev) {
        ev = r;
        changed = true;
      }
    }
    if (!changed) return block;
    return `${ev.event ? `event: ${ev.event}\n` : ''}data: ${ev.data}${sep || '\n\n'}`;
  }
}
