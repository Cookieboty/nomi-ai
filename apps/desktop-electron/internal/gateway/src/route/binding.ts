/**
 * 进程级路由令牌与标签绑定（docs/design/cli-plugin-architecture.md §6.7，审查意见 C4）。
 *
 * - 令牌：第三方会话的 CLI 进程每次启动由主进程签发，`nomi-tab-<随机>`（固定前缀，日志按格式脱敏）。
 *   令牌跟进程代次绑定：闲置回收、重启型换模型、崩溃重启都签新令牌并作废旧的。
 * - 网关只拿到令牌的哈希（快照里不放明文）；请求带来的令牌在这里算哈希再查。
 * - 先登记、后启动：主进程发 binding:add，网关回 binding:ok 之后才 spawn CLI。
 *   对格式正确但还没登记的令牌，网关在短窗口里等绑定到达，超时才拒绝（503 + retry-after，
 *   不用 401——Claude Code 会把 401 理解成「请重新登录」）。
 */
import { createHash } from 'node:crypto';

import type { ClientModels } from '../config';

export const TAB_TOKEN_PREFIX = 'nomi-tab-';
/** 前缀之后至少 32 个字符（32 字节随机的 base64url 是 43 个，十六进制是 64 个） */
const TAB_TOKEN_RE = /^nomi-tab-[A-Za-z0-9_-]{32,}$/;
/** 未知令牌等绑定的时长 */
export const BINDING_WAIT_MS = 2_000;
/** 等不到绑定时让 CLI 隔多久重试（秒） */
export const BINDING_RETRY_AFTER_S = 2;

export interface TabBinding {
  /** sha256(令牌) 的十六进制 */
  tokenHash: string;
  /** 客户端（插件 id：claude / codex / grok …） */
  client: string;
  tabId: string;
  /** 进程代次 */
  generation: number;
  /** main = 标签选的主模型；tiers / subagent / tools / summary = 档位与辅助槽位 */
  models: ClientModels;
  /** 标签选的思考深度（推理意图来源之一，§6.9.5） */
  effort?: string;
}

export function isTabToken(token: string): boolean {
  return TAB_TOKEN_RE.test(token);
}

export function hashTabToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 主进程 ↔ 网关的绑定消息（worker 消息循环里带 id，网关回应答） */
export type BindingMessage =
  | { type: 'binding:add'; id: string; binding: TabBinding }
  | { type: 'binding:update'; id: string; binding: TabBinding }
  | { type: 'binding:remove'; id: string; tokenHash: string };

export type BindingAck =
  { type: 'binding:ok'; id: string } | { type: 'binding:error'; id: string; message: string };

const valid = (b: TabBinding) =>
  /^[0-9a-f]{64}$/.test(b.tokenHash) &&
  typeof b.client === 'string' &&
  !!b.client &&
  typeof b.tabId === 'string' &&
  Number.isInteger(b.generation) &&
  !!b.models &&
  typeof b.models === 'object';

export class BindingTable {
  private readonly byHash = new Map<string, TabBinding>();
  private readonly waiters = new Map<string, Array<(b: TabBinding | null) => void>>();

  get size(): number {
    return this.byHash.size;
  }

  /** 登记（或替换同一令牌的旧绑定）；同一标签旧代次的绑定一并作废 */
  add(b: TabBinding): void {
    if (!valid(b)) throw new Error('invalid tab binding');
    for (const [h, x] of this.byHash)
      if (x.tabId === b.tabId && x.client === b.client && x.generation < b.generation)
        this.byHash.delete(h);
    this.byHash.set(b.tokenHash, b);
    const ws = this.waiters.get(b.tokenHash);
    if (ws) {
      this.waiters.delete(b.tokenHash);
      for (const w of ws) w(b);
    }
  }

  /** 更新已有绑定（gateway 型换模型：只改绑定，不重启，§6.7）；不存在时报错 */
  update(b: TabBinding): void {
    if (!this.byHash.has(b.tokenHash)) throw new Error('unknown tab binding');
    this.add(b);
  }

  remove(tokenHash: string): void {
    this.byHash.delete(tokenHash);
  }

  get(tokenHash: string): TabBinding | null {
    return this.byHash.get(tokenHash) ?? null;
  }

  /** 令牌 → 绑定；还没登记时最多等 waitMs（绑定先于 CLI 启动，正常情况下不会等） */
  async lookup(token: string, waitMs = BINDING_WAIT_MS): Promise<TabBinding | null> {
    if (!isTabToken(token)) return null;
    const h = hashTabToken(token);
    const hit = this.byHash.get(h);
    if (hit || waitMs <= 0) return hit ?? null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const ws = this.waiters.get(h)?.filter((w) => w !== done);
        if (ws?.length) this.waiters.set(h, ws);
        else this.waiters.delete(h);
        resolve(null);
      }, waitMs);
      (timer as { unref?: () => void }).unref?.();
      const done = (b: TabBinding | null) => {
        clearTimeout(timer);
        resolve(b);
      };
      this.waiters.set(h, [...(this.waiters.get(h) ?? []), done]);
    });
  }

  /** 处理一条主进程消息，返回应答 */
  handle(m: BindingMessage): BindingAck {
    try {
      if (m.type === 'binding:add') this.add(m.binding);
      else if (m.type === 'binding:update') this.update(m.binding);
      else this.remove(m.tokenHash);
      return { type: 'binding:ok', id: m.id };
    } catch (e) {
      return { type: 'binding:error', id: m.id, message: (e as Error).message };
    }
  }
}
