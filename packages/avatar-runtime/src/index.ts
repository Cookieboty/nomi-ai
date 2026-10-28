/**
 * @nomi-ai/avatar-runtime — 角色引擎（docs/design/core-host-decoupling.md §10.6）。
 *
 * 纯浏览器包：不依赖 contract / electron / ai-sdk-client，也不读宿主全局。宿主给它
 * 角色（manifest + mapping）、`resolveAsset` 与一个语义事件源，收它的互动事件。
 *
 * 入口：React 宿主用 `<AvatarStage …/>`，其它宿主用 `mountAvatar(el, options)`。
 * 渲染画布（Rive / sprite / static）在 AvatarStage 里按需懒加载，不从这里导出。
 */

// 运行时入口与宿主接口
export { AvatarStage, type AvatarStageProps } from './AvatarStage';
export { mountAvatar, type AvatarHandle } from './mount';
export { AvatarCanvas, type AvatarCanvasProps } from './canvas/AvatarCanvas';
export {
  assetUrl,
  avatarCharacterFromPack,
  hitboxesOf,
  isResolvedUrl,
  type AvatarCharacter,
  type AvatarInteractionEvent,
  type AvatarRuntimeOptions,
  type AvatarWindowHost,
  type DragPoint,
} from './host';
export {
  createAvatarEventHub,
  type AvatarEvent,
  type AvatarEventHub,
  type AvatarEventListener,
  type AvatarEventSource,
  type AvatarHitbox,
  type AvatarOutputEvent,
} from './events';
export { applyActivity, applyEmotion, driveAvatar, TALK_RELEASE_MS, TALK_RMS } from './driver';
export {
  activityTarget,
  currentAvatarMapping,
  DEFAULT_AVATAR_MAPPING,
  emotionTarget,
  gestureTarget,
  mappedSemantics,
  setAvatarMapping,
  type AvatarSemanticCapabilities,
} from './mapping';

// 后端抽象与注册表
export * from './MascotBackend';
export { createStaticBackend } from './backends/static';
export * from './backends/rive';
export {
  createSpriteBackend,
  loadSpriteManifest,
  type SpriteBackend,
  type SpriteFrame,
  type SpriteManifest,
} from './backends/sprite';
export { isRiveExperimentEnabled, RIVE_FLAG_KEY } from './riveFlag';

// 表情 / 情绪 / 动作
export * from './emotion';
export * from './expressionDirector';
export {
  applyDirective,
  AUTO_MOTION_COOLDOWN_MS,
  playGesture,
  playMotionNow,
  resetMoodForTests,
} from './mood';
export { voiceDirective } from './voiceMood';
export { MOTION_LABELS } from './motion/labels';
export { ACTION_LABELS, ACTIONS } from './rig/actions';
export * from './layeredRig';

// 互动（命中区、手势、反应、设置）与布局
export * from './interaction/gestures';
export * from './interaction/pointerPolicy';
export { react, SPEAK_KINDS } from './interaction/reactions';
export type { BodyRegion } from './interaction/regions';
export {
  DEFAULT_INTERACTION,
  interactionSettings,
  setInteractionConfigBackend,
  type InteractionConfigBackend,
  type MascotInteractionConfig,
} from './interaction/settings';
export { alphaSpans, rectsKey, type Rect } from './interaction/shape';
export * from './spriteInteraction';
export { characterBox, MASCOT_PAD } from './spriteLayout';
export { layoutStore, type Box, type LayoutSnapshot } from './layoutStore';
export { onWindowResized } from './windowResize';
