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
export const REASONING_REJECTION =
  /invalid_encrypted_content|(?:invalid|missing|mismatch|not valid|failed|cannot|unable|expected|required)[\s\S]{0,100}(?:signature|encrypted_content|redacted_thinking)|(?:signature|encrypted_content|redacted_thinking)[\s\S]{0,100}(?:invalid|missing|mismatch|not valid|failed|cannot|unable|required)|item(?:\s+with\s+id)?\s+['"]?rs_[^\s'"]+['"]?\s+(?:was\s+)?not found/i;

/** 只在请求校验失败时降级；鉴权、限流和服务器错误不能靠删历史推理修复。 */
export function isReasoningRejection(status: number, text: string): boolean {
  return [400, 404, 422].includes(status) && REASONING_REJECTION.test(text);
}

/** 请求体里有没有会被剥掉的推理内容 */
export function hasSealedReasoning(wire: Wire, body: unknown): boolean {
  return stripSealedReasoning(wire, body) !== body;
}

/**
 * 剥掉历史 assistant 消息里的加密推理与签名；没有可剥的返回原对象（调用方据此判断是否改过）。
 * - Messages：去掉 redacted_thinking 块和 thinking 块（签名不能跨厂商认，不带签名的 thinking
 *   发给 Anthropic 官方又会被拒，所以整块去掉）；
 * - Responses：去掉 input 里的 reasoning item（加密内容只有原厂商能解）；
 * - Chat / Gemini：去掉历史模型消息中的 thought signature，保留正文、工具调用和普通推理文本。
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
    const input = (body.input as unknown[]).filter(
      (it) =>
        !(
          isObj(it) &&
          (it.type === 'reasoning' ||
            (it.type === 'item_reference' && typeof it.id === 'string' && it.id.startsWith('rs_')))
        ),
    );
    return input.length === (body.input as unknown[]).length ? body : { ...body, input };
  }
  const field = wire === 'chat' ? 'messages' : wire === 'gemini' ? 'contents' : null;
  if (field && Array.isArray(body[field])) {
    let changed = false;
    const messages = (body[field] as unknown[]).map((m) => {
      if (!isObj(m) || m.role !== (wire === 'chat' ? 'assistant' : 'model')) return m;
      const stripped = stripSignatures(m);
      if (stripped !== m) changed = true;
      return stripped;
    });
    return changed ? { ...body, [field]: messages } : body;
  }
  return body;
}

/** 只处理已知签名字段；不用泛化的 signature 删除，避免误改工具的业务参数。 */
function stripSignatures(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out = value.map(stripSignatures);
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!isObj(value)) return value;
  let changed = false;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'thought_signature' || k === 'thoughtSignature') {
      changed = true;
      continue;
    }
    // 工具参数、schema、用户正文是业务数据，不能递归删其中的同名键。
    const next = ['arguments', 'args', 'parameters', 'functionCall'].includes(k)
      ? v
      : stripSignatures(v);
    if (next !== v) changed = true;
    out[k] = next;
  }
  return changed ? out : value;
}
