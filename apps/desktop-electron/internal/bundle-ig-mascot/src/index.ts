/**
 * @nomi-ai/bundle-ig-mascot
 *
 * 插件包：陪伴角色能力（渲染后端无关，只有语义事件，契约见 seams/avatar.ts）
 *   - AvatarSeamPlugin：ctx.avatar 服务（AI → 角色的 emotion / gesture / activity / speaking，
 *     角色 → AI 的 touched / clicked / scene）
 *   - CompanionToolsPlugin：avatar_gesture / avatar_emotion（语义名，白名单自动确认）
 *   - CompanionAgentPresetPlugin：preset:companion，systemPrompt 取角色身份 + userProfile.preferences.tone
 *
 * 入口即执行渲染进程守卫；测试环境（VITEST）旁路。
 */
import { assertRendererProcess } from './env';

assertRendererProcess({ skipInTest: true });

export * from './env';
export * from './plugins';
export * from './seams';
