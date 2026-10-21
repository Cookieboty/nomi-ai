/**
 * 历史推理内容的去留（docs/design/unified-gateway.md §9.3）。
 * 加密推理（Anthropic redacted_thinking、Responses 带 encrypted_content 的 reasoning item）和
 * thinking 签名与厂商甚至 Key 绑定：默认在转发前剥掉；只有会话归属表确认上一轮是同一供应商、
 * 同一 Key、同一协议时才原样发回。这里只处理同协议透传的请求体（转换路径由编码器决定）。
 */
import type { Wire } from './ir';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 推理校验失败的错误特征（随实测补充） */
export const REASONING_REJECTION = /signature|thinking|encrypted_content|reasoning|decrypt|verif/i;

/** 请求体里有没有会被剥掉的推理内容 */
export function hasSealedReasoning(wire: Wire, body: unknown): boolean {
  return stripSealedReasoning(wire, body) !== body;
}

/**
 * 剥掉历史 assistant 消息里的加密推理与签名；没有可剥的返回原对象（调用方据此判断是否改过）。
 * - Messages：去掉 redacted_thinking 块和 thinking 块（签名不能跨厂商认，不带签名的 thinking
 *   发给 Anthropic 官方又会被拒，所以整块去掉）；
 * - Responses：去掉 input 里的 reasoning item（加密内容只有原厂商能解）；
 * - Chat / Gemini：没有加密推理，不处理。
 */
export function stripSealedReasoning(wire: Wire, body: unknown): unknown {
  if (!isObj(body)) return body;
  if (wire === 'messages' && Array.isArray(body.messages)) {
    let changed = false;
    const messages = (body.messages as unknown[]).map((m) => {
      if (!isObj(m) || m.role !== 'assistant' || !Array.isArray(m.content)) return m;
      const content = (m.content as unknown[]).filter(
        (b) => !(isObj(b) && (b.type === 'thinking' || b.type === 'redacted_thinking')),
      );
      if (content.length === (m.content as unknown[]).length) return m;
      changed = true;
      // 只剩推理的 assistant 消息：留一句占位（Anthropic 不接受空文本块），保持 user / assistant 交替
      return {
        ...m,
        content: content.length ? content : [{ type: 'text', text: '(thinking omitted)' }],
      };
    });
    return changed ? { ...body, messages } : body;
  }
  if (wire === 'responses' && Array.isArray(body.input)) {
    const input = (body.input as unknown[]).filter((it) => !(isObj(it) && it.type === 'reasoning'));
    return input.length === (body.input as unknown[]).length ? body : { ...body, input };
  }
  return body;
}
