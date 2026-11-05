/**
 * 桌面角色窗口的语义事件中枢（avatar-runtime 的 `AvatarEventSource`，见
 * docs/character-pack/CONTRACT.md）。
 *
 * 契约事件、TTS 口型、语音状态、拖入文件等在各自的桥里翻译成 `AvatarEvent` 后 `emit` 到这里；
 * `AvatarStage` 订阅它驱动角色。
 */
import { createAvatarEventHub } from '@nomi-ai/avatar-runtime';

export const avatarEvents = createAvatarEventHub();
