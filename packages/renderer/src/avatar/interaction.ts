import type { AvatarInteractionEvent } from '@nomi-ai/avatar-runtime';

import { speakForActiveCharacter } from '../mascot/characterVoice';

/**
 * avatar-runtime 的互动输出：反应台词进气泡（`mascot:say`），点击类再朗读。
 * 表情与动作已经在运行时里做过。
 */
export function handleAvatarInteraction(e: AvatarInteractionEvent): void {
  if (!e.line) return;
  window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: e.line } }));
  if (e.speak) speakForActiveCharacter(e.line);
}
