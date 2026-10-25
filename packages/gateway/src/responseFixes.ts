/**
 * 响应方向修正（§11.3、§12.7.3「工具名」）的选项：按候选的上游协议、供应商开关和入口请求体算出来。
 * 工具调用 id 的种子按入口请求的对话历史派生（§6.9.7）：重试 / 回退得到同样的 id。
 */
import type { Wire } from './ir';
import { CallIds, callIdSeed } from './models/rules/response/callIds';
import { quirksOf } from './providers/index';
import type { Candidate } from './route/resolve';
import type { ChatPatchOptions } from './stream/chatPatch';
import { chatToolNameReverse, ingressToolNames } from './toolNames';

export function responseFixOptions(
  ingress: Wire,
  cand: Candidate,
  body: unknown,
  notes?: string[],
): ChatPatchOptions {
  const sw = quirksOf(cand.provider, cand.wire).fixes ?? {};
  const fromChat = cand.wire === 'chat';
  const names = fromChat ? ingressToolNames(ingress, body) : [];
  return {
    chatStream: sw.chatStream !== false,
    toolNames: fromChat && sw.toolNames !== false ? chatToolNameReverse(names) : null,
    textTools: fromChat && sw.textToolCalls !== false && names.length ? new Set(names) : null,
    repetition: sw.repetition !== false,
    callIds: new CallIds(callIdSeed(body)),
    ...(notes ? { notes } : {}),
  };
}
