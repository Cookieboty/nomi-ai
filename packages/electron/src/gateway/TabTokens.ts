/**
 * 第三方标签的进程级路由令牌（docs/design/cli-plugin-architecture.md §6.7）。
 *
 * - 每个第三方 CLI 进程（标签 × 进程代次）签一个 `nomi-tab-<32 字节 base64url>`，只交给调用方放进
 *   子进程环境；这里只留哈希与绑定，不落盘。
 * - 先登记、后启动：register() 发 binding:add，等网关回 binding:ok 才返回，调用方之后再 spawn。
 * - 同一标签再登记（闲置回收、重启型换模型、崩溃重启）就是新代次：网关作废旧代次的绑定。
 * - 网关进程重启后绑定表是空的：replay() 把还活着的绑定重新登记一遍，等 binding:ok（超时/失败记日志，不抛到 spawn）。
 */
import { randomBytes } from 'node:crypto';

import {
  hashTabToken,
  TAB_TOKEN_PREFIX,
  type BindingAck,
  type BindingMessage,
  type ClientModels,
  type TabBinding,
} from '@nomi-ai/gateway';

import { t as tr } from '../i18n';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export const BINDING_ACK_TIMEOUT_MS = 3_000;

export interface TabTokensDeps {
  /** 发给网关进程；网关没在运行时返回 false */
  send: (m: BindingMessage) => boolean;
  logger: Logger;
  timeoutMs?: number;
  /** 测试注入 */
  random?: (n: number) => Buffer;
}

export interface TabRegistration {
  /** 令牌明文：只放进这个子进程的环境，调用方不要记录 */
  token: string;
  tokenHash: string;
  generation: number;
}

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const keyOf = (client: string, tabId: string) => `${client}\u0000${tabId}`;

export class TabTokens {
  private readonly active = new Map<string, TabBinding>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly d: TabTokensDeps) {}

  /** 给一个将要启动的 CLI 进程签令牌并登记绑定；网关确认后才返回 */
  async register(o: {
    client: string;
    tabId: string;
    models: ClientModels;
    effort?: string;
  }): Promise<TabRegistration> {
    const key = keyOf(o.client, o.tabId);
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const token = `${TAB_TOKEN_PREFIX}${(this.d.random ?? randomBytes)(32).toString('base64url')}`;
    const binding: TabBinding = {
      tokenHash: hashTabToken(token),
      client: o.client,
      tabId: o.tabId,
      generation,
      models: o.models,
      ...(o.effort ? { effort: o.effort } : {}),
    };
    const old = this.active.get(key);
    this.active.set(key, binding);
    try {
      await this.request({ type: 'binding:add', id: this.nextId(), binding });
    } catch (e) {
      // 没登记上：这个令牌作废，旧代次（如果还在）也不再有效——调用方会报错而不是带着无效令牌启动
      if (this.active.get(key) === binding) this.active.delete(key);
      throw e;
    }
    if (old && old.tokenHash !== binding.tokenHash)
      this.d.send({ type: 'binding:remove', id: this.nextId(), tokenHash: old.tokenHash });
    return { token, tokenHash: binding.tokenHash, generation };
  }

  /** gateway 型换模型 / 换思考深度：只改绑定，不重启进程（§6.7）。没有活着的绑定返回 false */
  async update(o: {
    client: string;
    tabId: string;
    models?: ClientModels;
    effort?: string | null;
  }): Promise<boolean> {
    const key = keyOf(o.client, o.tabId);
    const cur = this.active.get(key);
    if (!cur) return false;
    const next: TabBinding = { ...cur, ...(o.models ? { models: o.models } : {}) };
    if (o.effort === null) delete next.effort;
    else if (o.effort) next.effort = o.effort;
    this.active.set(key, next);
    await this.request({ type: 'binding:update', id: this.nextId(), binding: next });
    return true;
  }

  /**
   * 进程退出 / 标签关闭：作废这个标签的令牌。给了 generation（进程退出）时只作废那一代：
   * 旧进程的退出事件可能晚于新代次的登记（回收后马上发下一条），不能把新进程的令牌一起作废。
   */
  remove(client: string, tabId: string, generation?: number): void {
    const key = keyOf(client, tabId);
    const cur = this.active.get(key);
    if (!cur) return;
    if (generation !== undefined && cur.generation !== generation) return;
    this.active.delete(key);
    this.d.send({ type: 'binding:remove', id: this.nextId(), tokenHash: cur.tokenHash });
  }

  has(client: string, tabId: string): boolean {
    return this.active.has(keyOf(client, tabId));
  }

  /** 网关的应答 */
  onAck(m: BindingAck): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.type === 'binding:ok') p.resolve();
    else p.reject(new Error(tr('electron.common.the-gateway-rejected-the-tab-binding', m.message)));
  }

  /**
   * 网关进程重新拉起后：把还活着的绑定重新登记并等待 binding:ok。
   * 任一失败只记日志（spawn 钩子不应被单条绑定拖垮）；调用方在 await 完成前不应假定令牌已生效。
   */
  async replay(): Promise<void> {
    const bindings = [...this.active.values()];
    if (!bindings.length) return;
    const results = await Promise.allSettled(
      bindings.map((binding) => this.request({ type: 'binding:add', id: this.nextId(), binding })),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed)
      this.d.logger.warn('gateway tab bindings replay partial failure', {
        total: bindings.length,
        failed,
      });
    else this.d.logger.info('gateway tab bindings replayed', bindings.length);
  }

  private nextId(): string {
    return `b${++this.seq}`;
  }

  private request(m: BindingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.d.send(m)) {
        reject(new Error(tr('electron.common.the-gateway-isn-t-running-so-the-third')));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(m.id);
        reject(new Error(tr('electron.common.the-gateway-didn-t-confirm-the-tab-binding')));
      }, this.d.timeoutMs ?? BINDING_ACK_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(m.id, { resolve, reject, timer });
    });
  }
}
