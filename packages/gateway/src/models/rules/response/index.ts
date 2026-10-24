/**
 * 响应方向的模型规则（§6.9.7）：结构修复只有一份实现（rules.ts）——正文里的工具调用、工具名还原、
 * 复读检测、finish_reason 校正、确定性的工具调用 id 与跨协议 id 映射（callIds.ts）。
 * fixer.ts 把它们套在 NormEvent 上（转换路径）；同协议 Chat 透传的 chatPatch.ts 调用同一份规则。
 * 规范化层（canonical/）只管协议有效性。
 */
export * from './callIds';
export * from './fixer';
export { extractTextCalls, ResponseRules, restoreToolName, type FoundCall } from './rules';
export { REPETITION_MESSAGE, RepetitionGuard } from './repetition';
export { TextToolExtractor } from './textTools';
