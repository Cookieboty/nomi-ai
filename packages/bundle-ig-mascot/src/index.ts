/**
 * @nomi-ai/bundle-ig-mascot
 *
 * 插件包：看板娘渲染进程能力（渲染后端无关，契约见 seams/avatar.ts）
 *   - AvatarSeamPlugin：ctx.avatar 服务与事件桥
 *   - TouchInjectPlugin：hitArea 触摸 → agent/sensory-inject（5s/area 冷却）
 *   - TtsLipSyncPlugin：tts/chunk → driveLipSync（20fps 节流）+ tts/end 归零
 *   - WaifuToolsPlugin：avatar_gesture / avatar_emotion（白名单自动确认）
 *   - WaifuAgentPresetPlugin：preset:waifu，systemPrompt 取 userProfile.preferences.tone
 *
 * 入口即执行渲染进程守卫；测试环境（VITEST）旁路。
 */
import { assertRendererProcess } from './env';

assertRendererProcess({ skipInTest: true });

export * from './env';
export * from './plugins';
export * from './seams';
