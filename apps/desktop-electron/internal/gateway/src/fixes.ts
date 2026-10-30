/**
 * 网关侧的请求修正（docs/design/unified-gateway.md §12.7.3）。
 * 作用在「真正发给上游的请求体」上：同协议透传与跨协议转换都要过一遍。
 * 本身只是入口：模型部分在模型适配器（models/rules/request，§6.9.6），供应商部分在 providers/（§6.3）。
 * 只做外科式改写（浅拷贝被改动的那一层），不经过 IR，不改调用方传进来的对象。
 */
import type { RuntimeModel } from './config';
import type { Wire } from './ir';
import { effectiveModel } from './models/effective';
import { modelRequest } from './models/rules/request/index';
import type { EffectiveModel } from './models/types';
import { nativeOf, providerRequest, quirksOf, serverToolError } from './providers/index';
import type { Candidate } from './route/resolve';

export { IMAGE_OMITTED_TEXT } from './models/rules/request/index';
export {
  cleanToolSchema,
  filterAnthropicBeta,
  SERVER_TOOL_UNSUPPORTED,
  serverToolError,
} from './providers/index';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** 上游是 Anthropic 官方接口（按供应商规格，§6.3） */
export function isAnthropicOfficial(c: Candidate): boolean {
  return nativeOf(c) === 'anthropic';
}

/** 上游是 OpenAI 官方接口 */
export function isOpenAIOfficial(c: Candidate): boolean {
  return nativeOf(c) === 'openai';
}

/** 候选对应的模型元数据（按对外模型名在供应商的模型列表里找） */
export function candidateModel(c: Candidate): RuntimeModel | undefined {
  const id = c.publicModel.slice(c.provider.id.length + 1);
  return c.provider.models.find((m) => m.id === id);
}

/* ------------------------------- 工具数量 ------------------------------- */

/** 请求体里的工具个数（Gemini 按 functionDeclarations 合计） */
export function toolCount(wire: Wire, body: unknown): number {
  const tools = isObj(body) ? body.tools : undefined;
  if (!Array.isArray(tools)) return 0;
  if (wire !== 'gemini') return tools.length;
  let n = 0;
  for (const t of tools) {
    const fns = isObj(t) ? t.functionDeclarations : undefined;
    n += Array.isArray(fns) ? fns.length : 1;
  }
  return n;
}

/** 工具数超过 quirks.maxTools（或上游不支持单独的服务端工具请求）时返回给用户的错误信息；否则 null */
export function toolLimitError(c: Candidate, body: unknown): string | null {
  // 同协议（Messages → Messages）时单独发起的服务端工具请求原样留在上游副本里，在这里拦下
  const server = serverToolError(c, c.wire, body);
  if (server) return server;
  const max = quirksOf(c.provider, c.wire).maxTools;
  if (!max || max <= 0) return null;
  const n = toolCount(c.wire, body);
  return n > max
    ? `当前供应商一次最多支持 ${max} 个工具，这次请求带了 ${n} 个，请减少 MCP 工具`
    : null;
}

/* ------------------------------- 入口 ------------------------------- */

/**
 * 对发给上游的请求体做 §12.7.3 的修正，返回浅拷贝（不改传进来的对象）。
 * notes 收集做了哪些修正（记进用量 / 日志）。
 */
export function applyRequestFixes(c: Candidate, body: unknown, notes: string[] = []): unknown {
  if (!isObj(body)) return body;
  const o: Obj = { ...body };
  // 模型部分（参数归一、推理、图片、工具 schema）在模型适配器里（§6.9.6）；
  // 严格模式下不支持的参数抛 UnsupportedParamError，调用方转成 400
  modelRequest(c.wire, o, candidateSpec(c), notes);
  // 供应商部分（工具 schema、非官方 Messages 的清理、Chat 工具名、extraBody）在供应商规格里（§6.3）
  providerRequest(c, o, notes);
  return o;
}

/** 候选的生效模型规格：展开候选时算好的，没有时（测试直接构造的候选）现算 */
export function candidateSpec(c: Candidate): EffectiveModel {
  return c.model ?? effectiveModel(c.provider, c.publicModel.slice(c.provider.id.length + 1));
}
