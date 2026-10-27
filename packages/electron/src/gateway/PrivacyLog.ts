/**
 * 最近隐藏的密钥（docs/design/secret-privacy.md §11、§12）：网关用量事件里的 redactions 按占位符汇总，
 * 设置 → 隐私与权限里列出来，可以从这里把误判的值加进「从不脱敏」。
 *
 * 只有元数据：类型、长度、开头几个字符、占位符、例外标记（HMAC），没有原文。
 * 同一个值每一轮都会随历史再遮一次，所以按占位符合并计数，而不是一次请求一条。
 * userData/gateway/privacy-log.json，0600，攒一会儿再写盘。
 */
import fs from 'fs';

import type { UsageEvent } from '@nomi-ai/gateway';

import { writePrivateFileAtomicAsync } from '../utils/privateFile';

export interface PrivacyLogEntry {
  placeholder: string;
  kind: string;
  len: number;
  head: string;
  allowTag: string;
  /** 最近一次的动作（mask / warn / block） */
  action: string;
  firstAt: number;
  lastAt: number;
  /** 出现在几个请求里 / 遮了几处 / 回程还原了几处（累计） */
  requests: number;
  masked: number;
  restored: number;
  /** 哪些客户端的请求里出现过（nomi / claude / codex …） */
  clients: string[];
}

/** 最多记多少个值 */
const CAP = 200;
/** 攒多久写一次盘 */
const FLUSH_MS = 2000;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export class PrivacyLog {
  private entries = new Map<string, PrivacyLogEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 网关用量事件：有 redactions 才记 */
  note(e: Pick<UsageEvent, 'client' | 'redactions'>): void {
    if (!e.redactions?.length) return;
    this.load();
    const at = this.now();
    for (const h of e.redactions) {
      const p = str(h.placeholder, 64);
      if (!p) continue;
      const had = this.entries.get(p);
      const client = str(e.client, 32);
      const entry: PrivacyLogEntry = had ?? {
        placeholder: p,
        kind: str(h.kind, 32),
        len: num(h.len),
        head: str(h.head, 4),
        allowTag: str(h.allowTag, 16),
        action: str(h.action, 8),
        firstAt: at,
        lastAt: at,
        requests: 0,
        masked: 0,
        restored: 0,
        clients: [],
      };
      entry.lastAt = at;
      entry.action = str(h.action, 8) || entry.action;
      entry.requests++;
      entry.masked += num(h.masked);
      entry.restored += num(h.restored);
      if (client && !entry.clients.includes(client)) entry.clients = [...entry.clients, client];
      // 重新插入：Map 的顺序就是最近出现的顺序
      this.entries.delete(p);
      this.entries.set(p, entry);
    }
    while (this.entries.size > CAP) this.entries.delete(this.entries.keys().next().value!);
    this.schedule();
  }

  /** 最近出现的在前 */
  list(): PrivacyLogEntry[] {
    this.load();
    return [...this.entries.values()].reverse();
  }

  /**
   * 清空内存并异步落盘空列表。与 schedule / flush 共用同一写队列，
   * 在途的旧快照不会盖回磁盘（#164）。
   */
  clear(): Promise<void> {
    this.loaded = true;
    this.entries.clear();
    return this.flushAsync();
  }

  /** 退出时调用：取消定时器并把当前快照排进异步写队列（Application 退出会等 whenPrivateWritesIdle） */
  flush(): void {
    void this.flushAsync();
  }

  private flushAsync(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return writePrivateFileAtomicAsync(this.file, JSON.stringify([...this.entries.values()])).catch(
      () => undefined,
    );
  }

  private schedule(): void {
    if (this.timer) return;
    // 定时落盘与 clear/flush 共用异步写队列（#154 / #164）
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushAsync();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const r of raw.slice(-CAP)) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const p = str(o.placeholder, 64);
      if (!p) continue;
      this.entries.set(p, {
        placeholder: p,
        kind: str(o.kind, 32),
        len: num(o.len),
        head: str(o.head, 4),
        allowTag: str(o.allowTag, 16),
        action: str(o.action, 8),
        firstAt: num(o.firstAt),
        lastAt: num(o.lastAt),
        requests: num(o.requests),
        masked: num(o.masked),
        restored: num(o.restored),
        clients: Array.isArray(o.clients)
          ? o.clients.filter((c): c is string => typeof c === 'string').slice(0, 16)
          : [],
      });
    }
  }
}
