/**
 * 供应商规格注册表（docs/design/cli-plugin-architecture.md §6.3）：
 * - 匹配：配置里显式指定的规格（`provider.spec`）→ 预设 id（`provider.preset`）→ 域名 → generic；
 * - quirks：规格自带的（低）+ 配置里的（预设 + 用户设置，高）合并；dropParams 取并集；
 * - 请求方向：generic 改写，再跑规格自己的钩子；
 * - 响应方向：ProviderStage 在规范化之前按规格去掉保活（转成心跳）、丢弃或改名私有事件。
 */
import type { ProviderQuirks, RuntimeProvider } from '../config';
import type { Wire } from '../ir';
import type { Candidate } from '../route/resolve';

import { BUILTIN_SPECS } from './builtin';
import { generic, genericRequest, serverToolErrorFor } from './generic';
import type { ProviderContext, ProviderSpec, RawEvent } from './types';

export * from './builtin';
export {
  cleanToolSchema,
  filterAnthropicBeta,
  generic,
  mapToolSchemas,
  SERVER_TOOL_UNSUPPORTED,
} from './generic';
export type { ProviderAdapterHooks, ProviderContext, ProviderSpec, RawEvent } from './types';

const registry = new Map<string, ProviderSpec>(
  [generic, ...BUILTIN_SPECS].map((s) => [s.id, s] as const),
);

/** 登记一个规格（插件 / 测试用）；同 id 覆盖 */
export function registerProviderSpec(spec: ProviderSpec): void {
  registry.set(spec.id, spec);
  specCache = new WeakMap();
}

export function providerSpecById(id: string): ProviderSpec | undefined {
  return registry.get(id);
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname.toLowerCase();
  } catch {
    return '';
  }
}

const hostMatches = (host: string, pattern: string) =>
  host === pattern || host.endsWith(`.${pattern}`);

let specCache = new WeakMap<RuntimeProvider, Map<string, ProviderSpec>>();

/**
 * 供应商（某个协议的地址）对应的规格。按协议区分：同一家的不同协议地址可能是不同的服务
 * （例如自建中转只把 Messages 指向 Anthropic 官方）。
 */
export function specOf(p: RuntimeProvider, wire?: Wire): ProviderSpec {
  let byWire = specCache.get(p);
  if (!byWire) specCache.set(p, (byWire = new Map()));
  const k = wire ?? '';
  const hit = byWire.get(k);
  if (hit) return hit;
  const found = resolveSpec(p, wire);
  byWire.set(k, found);
  return found;
}

function resolveSpec(p: RuntimeProvider, wire?: Wire): ProviderSpec {
  if (p.spec) {
    const s = registry.get(p.spec);
    if (s) return s;
  }
  const specs = [...registry.values()];
  if (p.preset) {
    const s = specs.find((x) => x.match.presets?.includes(p.preset!));
    if (s) return s;
  }
  const hosts = wire ? [hostOf(p.urls[wire])] : Object.values(p.urls).map((u) => hostOf(u));
  for (const host of hosts.filter(Boolean)) {
    const s = specs.find((x) => x.match.hosts?.some((h) => hostMatches(host, h)));
    if (s) return s;
  }
  return generic;
}

const defined = <T extends object>(o: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** 规格的 quirks（低）与配置里的 quirks（高）合并 */
export function mergeQuirks(base?: ProviderQuirks, over?: ProviderQuirks): ProviderQuirks {
  const out: ProviderQuirks = { ...defined(base), ...defined(over) };
  const drops = [...new Set([...(base?.dropParams ?? []), ...(over?.dropParams ?? [])])];
  if (drops.length) out.dropParams = drops;
  if (base?.fixes || over?.fixes) out.fixes = { ...defined(base?.fixes), ...defined(over?.fixes) };
  if (base?.extraBody || over?.extraBody) {
    const wires = new Set([
      ...Object.keys(base?.extraBody ?? {}),
      ...Object.keys(over?.extraBody ?? {}),
    ]) as Set<Wire>;
    out.extraBody = {};
    for (const w of wires)
      out.extraBody[w] = { ...(base?.extraBody?.[w] ?? {}), ...(over?.extraBody?.[w] ?? {}) };
  }
  return out;
}

let quirksCache = new WeakMap<RuntimeProvider, Map<string, ProviderQuirks>>();

/** 生效的 quirks（规格 → 配置）；wire 给出时按该协议地址匹配规格 */
export function quirksOf(p: RuntimeProvider, wire?: Wire): ProviderQuirks {
  let byWire = quirksCache.get(p);
  if (!byWire) quirksCache.set(p, (byWire = new Map()));
  const k = wire ?? '';
  const hit = byWire.get(k);
  if (hit) return hit;
  const q = mergeQuirks(specOf(p, wire).request, p.quirks);
  byWire.set(k, q);
  return q;
}

/** 测试用：清掉匹配缓存 */
export function resetProviderCaches(): void {
  specCache = new WeakMap();
  quirksCache = new WeakMap();
}

/**
 * 候选的上游是某家官方接口：规格声明了 native，**且**这个协议的地址确实是官方域名
 * （用了官方预设、却把地址改成中转服务的，仍按第三方处理）。
 */
export function nativeOf(c: Candidate): ProviderSpec['native'] {
  const spec = specOf(c.provider, c.wire);
  if (!spec.native) return undefined;
  const host = hostOf(c.provider.urls[c.wire]);
  return spec.match.hosts?.some((h) => hostMatches(host, h)) ? spec.native : undefined;
}

/** 请求方向：对发给上游的请求体（浅拷贝）做供应商改写 */
export function providerRequest(c: Candidate, o: Record<string, unknown>, notes: string[]): void {
  const spec = specOf(c.provider, c.wire);
  const ctx: ProviderContext = {
    candidate: c,
    spec,
    native: nativeOf(c),
    quirks: quirksOf(c.provider, c.wire),
    notes,
  };
  genericRequest(c.wire, o, ctx);
  spec.hooks?.request?.(c.wire, o, ctx);
}

/** 单独发起的服务端工具请求的预检（见 generic.ts） */
export function serverToolError(c: Candidate, ingress: Wire, body: unknown): string | null {
  return serverToolErrorFor(c, nativeOf(c), ingress, body);
}

/* ------------------------------- 响应方向 ------------------------------- */

type Obj = Record<string, unknown>;

/** 一个事件的结尾：空行（LF 或 CRLF，可混用） */
const EVENT_END = /\r?\n\r?\n/;

function dataOf(block: string): { data: string; event?: string } | null {
  let data = '';
  let event: string | undefined;
  let any = false;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      data += (any ? '\n' : '') + line.slice(5).replace(/^ /, '');
      any = true;
    } else if (line.startsWith('event:')) event = line.slice(6).trim();
  }
  return any ? { data, ...(event ? { event } : {}) } : null;
}

/**
 * 默认的事件预处理：按规格的声明式规则判定保活、丢弃 / 改名私有事件。
 * 返回 'alive' = 保活（丢弃并给客户端发心跳）；null = 丢弃；否则（可能改过的）事件。
 */
export function declarativePreEvent(spec: ProviderSpec, ev: RawEvent): RawEvent | null | 'alive' {
  const r = spec.response;
  if (!r) return ev;
  let j: Obj | null = null;
  try {
    const v: unknown = JSON.parse(ev.data);
    j = v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    j = null;
  }
  if (j && r.keepAlive?.some((k) => j![k.field] === k.equals)) return 'alive';
  const type = (j && typeof j.type === 'string' ? j.type : undefined) ?? ev.event;
  const rule = type ? r.events?.[type] : undefined;
  if (rule === 'drop') return null;
  if (rule && j) {
    const data = JSON.stringify({ ...j, type: rule.rename });
    return { event: ev.event ? rule.rename : undefined, data };
  }
  return ev;
}

/**
 * 上游流的供应商预处理（§6.1 ProviderAdapter.preEvent）：在规范化之前按完整 SSE 事件处理。
 * 没有命中任何规则的事件原样输出（字节不变）；保活计数，由调用方转成给客户端的心跳。
 */
export class ProviderStage {
  private buf = '';
  /** 这一段里丢掉的保活个数（调用方读完清零） */
  alive = 0;
  /** 丢弃 / 改名的事件个数（诊断用） */
  changed = 0;

  constructor(
    private readonly spec: ProviderSpec,
    private readonly wire: Wire,
  ) {}

  /** 这个规格需要预处理吗（不需要时调用方直接跳过，零开销） */
  static needed(spec: ProviderSpec): boolean {
    return Boolean(spec.response || spec.hooks?.preEvent);
  }

  push(text: string): string {
    this.buf += text;
    let out = '';
    for (let m = EVENT_END.exec(this.buf); m; m = EVENT_END.exec(this.buf)) {
      const end = m.index + m[0].length;
      out += this.block(this.buf.slice(0, end), m[0]);
      this.buf = this.buf.slice(end);
    }
    return out;
  }

  end(): string {
    const rest = this.buf;
    this.buf = '';
    return rest ? this.block(rest, '') : '';
  }

  private block(block: string, sep: string): string {
    const ev = dataOf(block);
    if (!ev) return block;
    const r = this.spec.hooks?.preEvent
      ? this.spec.hooks.preEvent(this.wire, ev, { spec: this.spec })
      : declarativePreEvent(this.spec, ev);
    if (r === ev) return block;
    if (r === 'alive') {
      this.alive++;
      return '';
    }
    this.changed++;
    if (r === null) return '';
    return `${r.event ? `event: ${r.event}\n` : ''}data: ${r.data}${sep || '\n\n'}`;
  }
}
