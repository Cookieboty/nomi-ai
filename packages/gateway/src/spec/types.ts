/**
 * 规范表（docs/design/cli-plugin-architecture.md §6.2）：每种协议一份机器可读的事件流规范。
 * 同一份表用于规范化（补什么、丢什么）、校验器（测试与诊断）、编码器自检（编码器产出必须通过校验）。
 */
export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 一个已解析的 SSE 事件（data 已是 JSON；Chat 的 [DONE] 记为 done: true） */
export interface SpecEvent {
  event?: string;
  data: Obj | null;
  done?: boolean;
}

export interface Violation {
  /** 第几个事件（从 0 开始）；-1 = 整条流 */
  index: number;
  /** 规则：unknown-event / missing-field / order / after-terminal / no-terminal / invalid */
  rule: 'unknown-event' | 'missing-field' | 'order' | 'after-terminal' | 'no-terminal' | 'invalid';
  detail: string;
}

export interface WireSpec {
  wire: 'responses' | 'chat' | 'messages' | 'gemini';
  /** 校验一整条事件流 */
  validate(events: readonly SpecEvent[]): Violation[];
  /** 这个事件是否是结束标记（正常结束或错误） */
  isTerminal(ev: SpecEvent): boolean;
  /** 这个事件是否是「内容事件」（正文 / 推理 / 工具调用的增量，提交点 §6.11.2） */
  isContent(ev: SpecEvent): boolean;
  /** 这个事件是否是错误 / 失败（提交前出现可以换候选） */
  isError(ev: SpecEvent): boolean;
}

/** 必填字段检查：缺的（undefined / null）列出来 */
export function missing(o: Obj, fields: readonly string[]): string[] {
  return fields.filter((f) => o[f] === undefined || o[f] === null);
}
