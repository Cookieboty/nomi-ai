import type { AvatarInteractionEvent, AvatarOutputEvent } from '@nomi-ai/avatar-runtime';
import { createLogger } from '@nomi-ai/ui';

import { speakForActiveCharacter } from '../mascot/characterVoice';
import { api, hasTransport } from '../services/api';

const log = createLogger('avatar');

/**
 * avatar-runtime 的互动输出：反应台词进气泡（`mascot:say`），点击类再朗读。
 * 表情与动作已经在运行时里做过。
 */
export function handleAvatarInteraction(e: AvatarInteractionEvent): void {
  if (!e.line) return;
  window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: e.line } }));
  if (e.speak) speakForActiveCharacter(e.line);
}

/**
 * 角色 → AI 的语义事件（被摸 / 被点 / 场景，§10.5）：经契约 `ai.avatar.report` 交给主进程的
 * AI 插件宿主（ctx.avatar 的订阅者）。没有契约传输（浏览器预览）时不报。
 */
export function reportAvatarEvent(e: AvatarOutputEvent): void {
  if (!hasTransport()) return;
  void api.ai.avatar.report(e).catch((error: unknown) => log.debug('avatar report failed', error));
}
