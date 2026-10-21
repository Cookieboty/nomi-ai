/**
 * 会话归属表（docs/design/unified-gateway.md §11.4）：会话 → 上一次服务它的 (供应商, Key, 协议)。
 * 跨重启保留（网关进程自己读写 userData/gateway/sessions.json，0600），最多 5000 条，30 天未用淘汰。
 * 用途：只有上一轮是同一供应商、同一 Key、同一协议时才保留历史里的加密推理和签名（§9.3）；
 * 被拒重试过的会话标为「不再保留」。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Wire } from './ir';

export const SESSIONS_MAX = 5000;
export const SESSIONS_TTL_MS = 30 * 24 * 60 * 60_000;
const SAVE_DELAY_MS = 2_000;

export interface SessionOwner {
  providerId: string;
  keyId: string;
  wire: Wire;
  model?: string;
  /** 推理内容曾被上游拒绝：之后都剥掉 */
  noKeep?: boolean;
  at: number;
}

export class SessionTable {
  private map = new Map<string, SessionOwner>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get(session: string): SessionOwner | null {
    const e = this.map.get(session);
    if (!e) return null;
    if (this.now() - e.at > SESSIONS_TTL_MS) {
      this.map.delete(session);
      return null;
    }
    return e;
  }

  /** 这一轮能不能保留历史里的加密推理和签名：上一轮是同一 (供应商, Key, 协议) 且没被标为不再保留 */
  canKeep(session: string | null, t: { providerId: string; keyId: string; wire: Wire }): boolean {
    if (!session) return false;
    const e = this.get(session);
    return Boolean(
      e && !e.noKeep && e.providerId === t.providerId && e.keyId === t.keyId && e.wire === t.wire,
    );
  }

  record(session: string | null, t: Omit<SessionOwner, 'at' | 'noKeep'>): void {
    if (!session) return;
    const prev = this.map.get(session);
    this.map.delete(session);
    this.map.set(session, { ...t, ...(prev?.noKeep ? { noKeep: true } : {}), at: this.now() });
    while (this.map.size > SESSIONS_MAX) this.map.delete(this.map.keys().next().value!);
    this.scheduleSave();
  }

  markNoKeep(session: string | null): void {
    if (!session) return;
    const e = this.map.get(session);
    if (e) e.noKeep = true;
    else
      this.map.set(session, {
        providerId: '',
        keyId: '',
        wire: 'chat',
        noKeep: true,
        at: this.now(),
      });
    this.scheduleSave();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: [...this.map] }), {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } catch {
      /* 写不了就只在内存里用：最坏是多剥一次推理 */
    }
  }

  private scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  private load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        sessions?: Array<[string, SessionOwner]>;
      };
      const now = this.now();
      for (const [k, v] of raw.sessions ?? [])
        if (typeof k === 'string' && v && now - v.at <= SESSIONS_TTL_MS) this.map.set(k, v);
    } catch {
      /* 没有或坏了：从空表开始 */
    }
  }
}
