/**
 * 供应商规格与适配器（docs/design/cli-plugin-architecture.md §6.3）。
 * 规格是数据（匹配条件、请求方向的 quirks、响应方向的保活特征与私有事件）；
 * 适配器钩子是代码（请求体改写、上游事件预处理），没有自己钩子的规格用 generic。
 */
import type { ProviderQuirks, RuntimeProvider } from '../config';
import type { Wire } from '../ir';
import type { ModelSpecData } from '../models/types';
import type { Candidate } from '../route/resolve';
import type { SseEvent } from '../stream/sse';

export interface ProviderSpec {
  /** 'generic' | 'amux' | 'anthropic' | 'deepseek' … */
  id: string;
  /** 匹配：预设 id、域名（精确或以 `.域名` 结尾）；用户在配置里指定 spec 时以它为准 */
  match: { presets?: string[]; hosts?: string[] };
  /**
   * 官方接口：这家就是协议的制定者，不做第三方兼容改写（工具 schema 清理、去掉 Anthropic 专有字段等）。
   */
  native?: 'anthropic' | 'openai';
  /** 请求方向（原 ProviderQuirks，字段不变）；配置里的 quirks（预设 + 用户）覆盖这里 */
  request?: ProviderQuirks;
  /** 响应方向的声明式规则 */
  response?: {
    /** 保活事件的特征（data 的顶层字段等于某值）：命中即从上游流里去掉，转成给客户端的心跳（§6.6） */
    keepAlive?: Array<{ field: string; equals: unknown }>;
    /** 私有事件：按事件类型（data.type 或 SSE event 名）丢弃或改名 */
    events?: Record<string, 'drop' | { rename: string }>;
  };
  hooks?: ProviderAdapterHooks;
  /** 供应商对模型规格的覆盖（§6.9.3 第 3 级）：「这家的这个模型只走 Chat」「这家把思考参数叫什么」 */
  models?: Array<{ match: string[]; spec: ModelSpecData }>;
}

export interface ProviderContext {
  candidate: Candidate;
  spec: ProviderSpec;
  /** 这次请求确实发往官方接口（规格声明 native 且地址是官方域名） */
  native?: ProviderSpec['native'];
  /** 合并后的 quirks（规格 → 配置） */
  quirks: ProviderQuirks;
  /** 做了的修正（请求备注） */
  notes: string[];
}

/** 上游的一个原始 SSE 事件 */
export type RawEvent = SseEvent;

export interface ProviderAdapterHooks {
  /** 请求体改写：作用在发给上游的请求体上（已是浅拷贝，可以就地改） */
  request?(wire: Wire, body: Record<string, unknown>, ctx: ProviderContext): void;
  /** 上游事件预处理：返回 null 丢弃；返回 'alive' 表示这是保活（丢弃并给客户端发心跳） */
  preEvent?(wire: Wire, ev: RawEvent, ctx: { spec: ProviderSpec }): RawEvent | null | 'alive';
}

export type { RuntimeProvider };
