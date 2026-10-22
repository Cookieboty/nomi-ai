/**
 * 入口协议只看请求路径（docs/design/unified-gateway.md §7.1）：
 *   /v1/messages、/v1/messages/count_tokens        → Messages
 *   /v1/responses                                  → Responses
 *   /v1/chat/completions                           → Chat
 *   /v1beta/models/{model}:generateContent 等      → Gemini（模型名与是否流式都在路径里）
 * 路径前缀（/v1、/v1beta、网关挂载点）不影响判断；查询串忽略。
 */
import type { Wire } from './ir';

export interface Ingress {
  wire: Wire;
  /** Gemini：路径里的模型名（已解码，可能含 provider/ 前缀） */
  model?: string;
  /** Gemini：streamGenerateContent */
  stream?: boolean;
  /** Messages /count_tokens、Gemini :countTokens */
  countTokens?: boolean;
}

const GEMINI_RE = /\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;

export function ingressFromPath(url: string): Ingress | null {
  const path = (url.split('?')[0] ?? '').replace(/\/+$/, '');
  const g = GEMINI_RE.exec(path);
  if (g) {
    let model = g[1]!;
    try {
      model = decodeURIComponent(model);
    } catch {
      /* 不合法的转义按原样当模型名 */
    }
    return {
      wire: 'gemini',
      model,
      ...(g[2] === 'streamGenerateContent' ? { stream: true } : {}),
      ...(g[2] === 'countTokens' ? { countTokens: true } : {}),
    };
  }
  if (path.endsWith('/messages/count_tokens')) return { wire: 'messages', countTokens: true };
  if (path.endsWith('/messages')) return { wire: 'messages' };
  if (path.endsWith('/responses')) return { wire: 'responses' };
  if (path.endsWith('/chat/completions')) return { wire: 'chat' };
  return null;
}

/**
 * Gemini 上游路径里的模型段：去掉 models/ 前缀，逐段转义但保留 `/`
 * （聚合网关的模型名形如 google/gemini-3-flash，整体转义成 %2F 会被拒，M0 实测）。
 */
export function geminiModelPath(model: string): string {
  return model
    .replace(/^models\//, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}
