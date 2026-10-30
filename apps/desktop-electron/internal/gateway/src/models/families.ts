/**
 * 模型族默认（§6.9.3 第 1 级）：只有这一级按名字 glob 匹配，只作回退——目录、供应商、学到的结论、
 * 用户设置都会覆盖它。只写这个族普遍成立、而且路由 / 渲染要用到的东西。
 */
import type { ModelFamily } from './types';

export const FAMILIES: readonly ModelFamily[] = [
  {
    family: 'claude',
    match: ['claude-*', 'claude*'],
    wires: { prefer: ['messages'], reason: '保住签名、缓存与思考控制' },
    reasoning: { control: 'budget', canDisable: true },
    params: { requireMaxTokens: true },
  },
  {
    family: 'gpt',
    match: ['gpt-5*', 'gpt-6*', 'o1*', 'o3*', 'o4*', 'codex*', 'gpt-*-codex*'],
    wires: { prefer: ['responses'], reason: '保住加密推理' },
    reasoning: { control: 'effort', efforts: ['minimal', 'low', 'medium', 'high'] },
    // 推理模型在 Chat 上要求 max_completion_tokens，并拒绝非默认温度
    params: { maxTokensField: 'max_completion_tokens' },
    sampling: { temperature: false, topP: false },
  },
  {
    family: 'gemini',
    match: ['gemini-*'],
    wires: { prefer: ['gemini'], reason: '思考签名与 thinkingConfig 只在原生协议上完整' },
    tools: { schema: 'gemini' },
  },
  {
    family: 'deepseek',
    match: ['deepseek-*'],
    reasoning: {
      control: 'toggle',
      canDisable: true,
      passback: 'required',
      passbackField: 'reasoning_content',
    },
    tools: { schema: 'deepseek' },
  },
  {
    family: 'kimi',
    match: ['kimi-*', 'moonshot-*'],
    reasoning: { control: 'toggle', passback: 'required', passbackField: 'reasoning_content' },
    tools: { schema: 'kimi' },
  },
  {
    family: 'glm',
    match: ['glm-*'],
    reasoning: { control: 'toggle', passback: 'required', passbackField: 'reasoning_content' },
  },
  {
    family: 'qwen',
    match: ['qwen*'],
    reasoning: { control: 'toggle', canDisable: true, toggleStyle: 'enable-thinking' },
  },
  {
    family: 'minimax',
    match: ['minimax-*'],
    reasoning: { control: 'none', passback: 'required', passbackField: 'reasoning_details' },
  },
  {
    family: 'grok',
    match: ['grok-*'],
    wires: { prefer: ['responses'], reason: 'xAI 的 Chat 接口标为 legacy' },
  },
];

/** glob → 正则（只支持 *） */
function globRe(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

const compiled = FAMILIES.map((f) => ({ f, res: f.match.map(globRe) }));

/** 按去掉前缀后的模型 id 找族默认 */
export function familyOf(bareId: string): ModelFamily | undefined {
  return compiled.find(({ res }) => res.some((r) => r.test(bareId)))?.f;
}
