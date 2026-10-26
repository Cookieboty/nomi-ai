/**
 * 已知原文与已见值（docs/design/secret-privacy.md §5.2、§7.2），只在网关进程内存里。
 *
 * - 已知原文：配置快照里的第三方 Key、客户端令牌、主进程登记的其他密钥（每次换快照重新登记，不会被淘汰）；
 * - 已见值：遮过一次的值。回程还原后，值会出现在规则认不出的地方（「密码是 xxx」），
 *   下一轮作为历史发回来时按原文再认一次，换成同一个占位符；
 * - 两者共用一个匹配器：按值的前 8 个字符建索引，再用前 4 个字符的位图先筛，绝大多数位置不查表。
 */
import { placeholderOf, tagOf } from './placeholder';
import type { SecretSpan } from './rules';

/** 短于它的值不按原文认：普通文本里到处都是 */
export const MIN_KNOWN = 8;
/** 已见值上限；满了丢掉最旧的一半（下一个请求会把还在用的带回来） */
export const MAX_VALUES = 200_000;

interface Entry {
  value: string;
  kind: string;
}

const BITS = 1 << 16;

function hash4(s: string, i: number): number {
  return (
    (((s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) * 31 + s.charCodeAt(i + 2)) * 31 +
      s.charCodeAt(i + 3)) &
    (BITS - 1)
  );
}

export class SecretStore {
  private key = '';
  /** 原文 → 占位符 */
  private byValue = new Map<string, string>();
  /** 占位符 → 原文 */
  private byPlaceholder = new Map<string, string>();
  /** 已知原文（快照给的），淘汰时保留 */
  private pinned: Entry[] = [];
  private index = new Map<string, Entry[]>();
  private bits = new Uint32Array(BITS / 32);
  private maxValues: number;

  constructor(opts: { maxValues?: number } = {}) {
    this.maxValues = opts.maxValues ?? MAX_VALUES;
  }

  /** 换 HMAC 密钥：之前的占位符全部作废 */
  setKey(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.clear();
  }

  /** 清空已见值（关掉隐私模式、换密钥时）；已知原文保留 */
  clear(): void {
    this.byValue.clear();
    this.byPlaceholder.clear();
    this.reindex();
  }

  /** 换快照时重新登记已知原文 */
  setKnown(list: Entry[]): void {
    const seen = new Set<string>();
    this.pinned = list.filter((e) => {
      if (e.value.length < MIN_KNOWN || seen.has(e.value)) return false;
      seen.add(e.value);
      return true;
    });
    this.reindex();
  }

  get size(): number {
    return this.byValue.size;
  }

  /** 原文对应的占位符；第一次见到时登记（同名占位符被别的值占了就带序号） */
  assign(kind: string, value: string): string {
    const had = this.byValue.get(value);
    if (had) return had;
    if (this.byValue.size >= this.maxValues) this.evict();
    const tag = tagOf(this.key, kind, value);
    let n = 1;
    let p = placeholderOf(kind, tag);
    while (this.byPlaceholder.has(p) && this.byPlaceholder.get(p) !== value)
      p = placeholderOf(kind, tag, ++n);
    this.byValue.set(value, p);
    this.byPlaceholder.set(p, value);
    if (value.length >= MIN_KNOWN) this.add({ value, kind });
    return p;
  }

  /** 占位符对应的原文 */
  valueOf(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  /** 文本里出现的已知原文 / 已见值（不重叠，同一位置取最长的） */
  find(s: string): SecretSpan[] {
    const out: SecretSpan[] = [];
    if (!this.index.size || s.length < MIN_KNOWN) return out;
    const last = s.length - MIN_KNOWN;
    for (let i = 0; i <= last; i++) {
      const h = hash4(s, i);
      if (!(this.bits[h >>> 5]! & (1 << (h & 31)))) continue;
      const list = this.index.get(s.slice(i, i + MIN_KNOWN));
      if (!list) continue;
      let best: Entry | null = null;
      for (const e of list)
        if ((!best || e.value.length > best.value.length) && s.startsWith(e.value, i)) best = e;
      if (!best) continue;
      out.push({ start: i, end: i + best.value.length, kind: best.kind, by: 'known' });
      i += best.value.length - 1;
    }
    return out;
  }

  private add(e: Entry): void {
    const k = e.value.slice(0, MIN_KNOWN);
    const list = this.index.get(k);
    if (list) {
      if (!list.some((x) => x.value === e.value)) list.push(e);
    } else this.index.set(k, [e]);
    const h = hash4(e.value, 0);
    this.bits[h >>> 5]! |= 1 << (h & 31);
  }

  private reindex(): void {
    this.index.clear();
    this.bits.fill(0);
    for (const e of this.pinned) this.add(e);
    for (const [value, p] of this.byValue)
      if (value.length >= MIN_KNOWN) this.add({ value, kind: kindOf(p) });
  }

  private evict(): void {
    let n = 0;
    const half = Math.floor(this.maxValues / 2);
    for (const [value, p] of this.byValue) {
      this.byValue.delete(value);
      this.byPlaceholder.delete(p);
      if (++n >= half) break;
    }
    this.reindex();
  }
}

/** `{{API_KEY_xxxxxxxx}}` → `API_KEY` */
function kindOf(placeholder: string): string {
  const m = /^\{\{([A-Z][A-Z_]*?)_[a-z2-7]{8}(?:_\d+)?\}\}$/.exec(placeholder);
  return m?.[1] ?? 'CUSTOM';
}
