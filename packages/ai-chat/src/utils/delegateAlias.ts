/**
 * 为 Nomi 调度的每一个独立 CLI 分配稳定、唯一且随界面语言切换的短名，
 * 避免多个同类型 CLI（例如多个 Claude Code）显示完全相同的名字难以区分。
 * 中文严格不超过 4 个字符，英文严格不超过 8 个字符；词库托管在统一 i18n 词典。
 */
import { getLocale, tIn, type Locale } from '@nomi-ai/ui';

export const MAX_ZH_ALIAS_LEN = 4;
export const MAX_EN_ALIAS_LEN = 8;

const POOL_KEY = 'ui.session-workspace.delegate-alias-pool';
const FALLBACK_EN = ['Atlas', 'Nova', 'Orion', 'Lyra', 'Echo', 'Sage', 'Vega', 'Koda'];

const poolCache: Partial<Record<Locale, readonly string[]>> = {};

/** 当前语言对应的委派 CLI 短名词库 */
export function delegateAliasPool(locale: Locale = getLocale()): readonly string[] {
  const cached = poolCache[locale];
  if (cached) return cached;
  const raw = tIn(locale, POOL_KEY);
  const parsed =
    raw && raw !== POOL_KEY
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const pool = parsed.length ? parsed : FALLBACK_EN;
  poolCache[locale] = pool;
  return pool;
}

const poolSize = (): number => Math.max(1, delegateAliasPool('zh-CN').length);

const MAX_STICKY = 512;

export interface DelegateAliasPeer {
  id: string;
  createdAt?: number;
  delegation?: { by?: string } | undefined;
}

const stickySlots = new Map<string, number>();

function fnv1a(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function formatAliasSlot(slot: number, locale: Locale): string {
  const isEn = locale === 'en';
  const pool = delegateAliasPool(locale);
  const size = Math.max(1, pool.length);
  const maxLen = isEn ? MAX_EN_ALIAS_LEN : MAX_ZH_ALIAS_LEN;
  const base = pool[slot % size]!;
  const round = Math.floor(slot / size);
  if (round === 0) return base;
  const suffix = String(round + 1);
  if (isEn) {
    const keep = Math.max(1, maxLen - suffix.length);
    return `${base.slice(0, keep)}${suffix}`;
  }
  const chars = [...base];
  const keep = Math.max(1, maxLen - suffix.length);
  return `${chars.slice(0, keep).join('')}${suffix}`;
}

function sortedDelegatedPeers(tabs: readonly DelegateAliasPeer[] | undefined): DelegateAliasPeer[] {
  if (!tabs?.length) return [];
  const dedup = new Map<string, DelegateAliasPeer>();
  for (const item of tabs) {
    if (!item.id || item.delegation?.by !== 'nomi') continue;
    if (!dedup.has(item.id)) dedup.set(item.id, item);
  }
  return [...dedup.values()].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );
}

function probeSlot(id: string, used: Set<number>): number {
  const size = poolSize();
  const base = fnv1a(id) % size;
  for (let round = 0; ; round++) {
    const roundBase = round * size;
    for (let step = 0; step < size; step++) {
      const candidate = roundBase + ((base + step) % size);
      if (!used.has(candidate)) return candidate;
    }
  }
}

/**
 * 同步当前所有委派 CLI 的槽位，保证同屏绝不重名且关闭某个标签后其余标签名字保持稳定。
 * 在 HarnessTabsContext 收到主进程标签状态时调用，不在 render 中变更模块状态。
 */
export function syncDelegateAliases(tabs: readonly DelegateAliasPeer[] | undefined): void {
  const peers = sortedDelegatedPeers(tabs);
  if (!peers.length) return;
  const used = new Set<number>();
  const pending: DelegateAliasPeer[] = [];

  for (const p of peers) {
    const existing = stickySlots.get(p.id);
    if (existing !== undefined && !used.has(existing)) {
      used.add(existing);
      // 刷新 LRU 顺序
      stickySlots.delete(p.id);
      stickySlots.set(p.id, existing);
    } else {
      pending.push(p);
    }
  }

  for (const p of pending) {
    const slot = probeSlot(p.id, used);
    used.add(slot);
    stickySlots.delete(p.id);
    stickySlots.set(p.id, slot);
  }

  if (stickySlots.size > MAX_STICKY) {
    const activeIds = new Set(peers.map((p) => p.id));
    for (const k of stickySlots.keys()) {
      if (stickySlots.size <= MAX_STICKY) break;
      if (!activeIds.has(k)) stickySlots.delete(k);
    }
    while (stickySlots.size > MAX_STICKY) {
      const oldest = stickySlots.keys().next().value;
      if (oldest === undefined) break;
      stickySlots.delete(oldest);
    }
  }
}

/**
 * 读取指定委派 CLI 实例在当前语言下的短名（纯函数，无副作用）。
 * - 已同步进活跃映射的直接返回其稳定槽位对应名字；
 * - 未同步但传入了 peers 时，结合已占槽位作局部防碰撞计算；
 * - 均未传入时基于 id 哈希给出确定性名字。
 */
export function delegateAlias(
  id: string,
  opts?: { peers?: readonly DelegateAliasPeer[]; locale?: Locale },
): string {
  const locale = opts?.locale ?? getLocale();
  if (!id) return formatAliasSlot(0, locale);
  const hit = stickySlots.get(id);
  if (hit !== undefined) return formatAliasSlot(hit, locale);

  if (opts?.peers?.length) {
    const localUsed = new Set<number>();
    const localSlots = new Map<string, number>();
    const combined: DelegateAliasPeer[] = [];
    let hasSelf = false;
    for (const p of opts.peers) {
      if (!p.id) continue;
      if (p.id === id) {
        hasSelf = true;
        combined.push({ ...p, delegation: { by: 'nomi' } });
      } else if (p.delegation?.by === 'nomi') {
        combined.push(p);
      }
    }
    if (!hasSelf) combined.push({ id, delegation: { by: 'nomi' } });
    const sorted = sortedDelegatedPeers(combined);
    const pending: DelegateAliasPeer[] = [];
    for (const p of sorted) {
      const known = stickySlots.get(p.id);
      if (known !== undefined && !localUsed.has(known)) {
        localUsed.add(known);
        localSlots.set(p.id, known);
      } else {
        pending.push(p);
      }
    }
    for (const p of pending) {
      const slot = probeSlot(p.id, localUsed);
      localUsed.add(slot);
      localSlots.set(p.id, slot);
    }
    const resolved = localSlots.get(id);
    if (resolved !== undefined) return formatAliasSlot(resolved, locale);
  }

  return formatAliasSlot(fnv1a(id) % poolSize(), locale);
}

/** 单测用：重置全局槽位映射 */
export function resetDelegateAliases(): void {
  stickySlots.clear();
}

export interface FleetAliasCandidate {
  scope: string;
  kind: string;
  origin: string;
  tabId?: string;
  taskId?: string;
}

/** Agents 看板条目是否为 Nomi 委派出来的独立 CLI */
export function fleetAgentAliasId(a: FleetAliasCandidate): string | undefined {
  if (a.scope !== 'managed' || a.kind !== 'cli') return undefined;
  if (a.origin !== 'conversation' && a.origin !== 'task') return undefined;
  return a.tabId ?? a.taskId;
}

/** Agents 看板中全部委派 CLI 构造出的同行 peers，用于未先经标签上下文加载时防碰撞 */
export function fleetDelegatedPeers(agents: readonly FleetAliasCandidate[]): DelegateAliasPeer[] {
  const peers: DelegateAliasPeer[] = [];
  for (const a of agents) {
    const id = fleetAgentAliasId(a);
    if (id) peers.push({ id, delegation: { by: 'nomi' } });
  }
  return peers;
}
