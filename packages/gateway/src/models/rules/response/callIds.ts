/**
 * 工具调用 id（docs/design/cli-plugin-architecture.md §6.9.7）：
 * - **确定性生成**：上游没给 id（Gemini 没有调用 id、正文里写出的工具调用、Chat 缺 id）时，按
 *   「这一轮的种子 + 序号」派生。种子来自请求里的对话历史（同一段历史总是同一个种子），所以重试、回退
 *   得到同样的 id，CLI 下一轮带回的历史逐字节一致，上游的提示缓存不失效；不同的轮次历史不同，id 不会撞。
 * - **跨协议映射**：各协议对 id 的格式要求不同。Messages 的 `tool_use.id` 只接受 `[A-Za-z0-9_-]`
 *   （Kimi 之类的 Chat 上游会给 `functions.bash:0`），OpenAI Chat 的 `tool_calls[].id` 最长 40 个字符。
 *   发给有限制的协议时按协议改写：Messages 用可逆的转义（`nomi_` + base64url），回程解码时还原；
 *   Chat 超长的用摘要（同一个 id 总是同一个摘要，调用与结果仍然对得上）。
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Wire } from '../../../ir';

/** Messages 接受的 id 字符集（Anthropic 官方接口的校验） */
const MESSAGES_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** OpenAI Chat 的 tool_calls[].id 长度上限 */
const CHAT_ID_MAX = 40;
const ESCAPE_PREFIX = 'nomi_';

/**
 * 同一条响应里的 id 序列：按出现顺序编号，前缀是这一轮的种子。
 * 同一个种子总是给出同一组 id，便于对照诊断记录与跨协议回传时还原。
 */
export class CallIds {
  private n = 0;
  constructor(readonly seed: string = randomBytes(8).toString('hex')) {}
  next(): string {
    return `call_${this.seed}_${this.n++}`;
  }
}

/** 请求体里的对话历史 */
function historyOf(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = body as Record<string, unknown>;
  return [b.system, b.instructions, b.messages ?? b.input ?? b.contents];
}

/** 这一轮的 id 种子：对话历史的摘要（12 位十六进制） */
export function callIdSeed(body: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(historyOf(body)) ?? '';
  } catch {
    text = '';
  }
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** 不满足 Messages 字符集的 id → `nomi_<base64url>`（可逆）；满足的原样返回 */
export function escapeCallId(id: string): string {
  if (!id || MESSAGES_ID.test(id)) return id;
  return ESCAPE_PREFIX + Buffer.from(id, 'utf8').toString('base64url');
}

/** escapeCallId 的逆：不是转义出来的 id 原样返回 */
export function unescapeCallId(id: string): string {
  if (!id.startsWith(ESCAPE_PREFIX)) return id;
  const raw = id.slice(ESCAPE_PREFIX.length);
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return id;
  const orig = Buffer.from(raw, 'base64url').toString('utf8');
  // 只认真正由 escapeCallId 产出的（否则用户自己起的 nomi_xxx 会被误解码）
  return escapeCallId(orig) === id ? orig : id;
}

/** 发给某个协议时的 id（请求方向：历史里的调用与结果按同一规则改写，仍然对得上） */
export function callIdForWire(wire: Wire, id: string): string {
  if (!id) return id;
  if (wire === 'messages') return escapeCallId(id);
  if (wire === 'chat' && id.length > CHAT_ID_MAX)
    return `call_${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
  return id;
}
