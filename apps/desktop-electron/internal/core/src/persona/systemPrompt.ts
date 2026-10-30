/**
 * 默认系统提示（对话窗口没有自定义时发给模型的那段，§10.4）：当前角色人设的身份段 + 与角色无关的对话要求。
 * 由内核拼装，视图经契约 `persona.systemPrompt` 取；身份段跟角色包与界面语言走，对话要求跟界面语言走。
 */
import type { Persona } from '@nomi-ai/types';

/** 默认系统提示里的对话要求（不含身份）：跟随界面语言 */
export const CHAT_GUIDANCE_KEY = 'ui.chat-settings.you-run-on-the-user-s-own-computer-be';

/** 身份段 + 对话要求；没有人设时只发对话要求，不冒充任何角色 */
export function defaultSystemPrompt(
  persona: Pick<Persona, 'systemPromptIdentity'> | undefined,
  translate: (key: string) => string,
): string {
  return [persona?.systemPromptIdentity, translate(CHAT_GUIDANCE_KEY)]
    .filter((s): s is string => !!s && !!s.trim())
    .map((s) => s.trim())
    .join('\n');
}
