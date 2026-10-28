import type {
  SemanticActivity,
  SemanticEmotion,
  SemanticGesture,
} from '@nomi-ai/character-contract';

import type { AppEvents } from '../core/appEvents';
import type { ReplySpeechCommand } from '../tts/replySpeech';

/**
 * 主进程 → 看板娘渲染进程的指令（channel: `mascot:command`，契约事件 `mascot.command`）：
 * 打开面板、说一句（可带语义手势）、朗读回复。角色的情绪 / 手势 / 活动不是指令，走下面的语义事件。
 */
export type MascotCommand =
  | { type: 'open-panel'; panel: 'interaction' | 'credits' | 'motions' }
  | { type: 'say'; text: string; gesture?: SemanticGesture }
  | ReplySpeechCommand;

export const MASCOT_COMMAND_CHANNEL = 'mascot:command';

/**
 * 内核 → 角色的语义事件（channel: `avatar:event`，契约事件 `avatar.event`，
 * docs/design/core-host-decoupling.md §10.5）。只有词表里的语义名（`@nomi-ai/character-contract`），
 * 角色包的 mapping.json 把它们翻译成自己的表情与动作；内核不认识任何片段 / 动作 / 表情资源名。
 */
export type AvatarCue =
  | { type: 'emotion'; name: SemanticEmotion; weight?: number }
  | { type: 'gesture'; name: SemanticGesture }
  | { type: 'activity'; name: SemanticActivity }
  /** 对话窗口正在等回复 / 等待结束（看板娘保持 / 放下思考的神态） */
  | { type: 'reply'; phase: 'waiting' | 'settled' };

export const AVATAR_EVENT_CHANNEL = 'avatar:event';

/** 服务手里的事件总线（只用发布）；没有时（启动早期、单测）指令直接丢弃 */
type Publisher = Pick<AppEvents, 'publish'> | null | undefined;

/**
 * 经服务自己的应用事件总线发布（事件桥转成契约事件 `mascot.command`，订阅了的窗口都收到）。
 * 每个内核实例有自己的事件总线（docs/design/core-host-decoupling.md §7.1），所以这里不用模块级的出口；
 * 契约 router 建好之前（启动早期）没有订阅者，指令直接丢弃。
 */
export function sendMascotCommand(events: Publisher, cmd: MascotCommand): void {
  events?.publish(MASCOT_COMMAND_CHANNEL, cmd);
}

/** 经服务自己的事件总线发一个语义事件给角色窗口（契约事件 `avatar.event`） */
export function publishAvatarCue(events: Publisher, cue: AvatarCue): void {
  events?.publish(AVATAR_EVENT_CHANNEL, cue);
}

/** 让角色做一个语义手势（没有映射的角色忽略） */
export function avatarGesture(events: Publisher, name: SemanticGesture): void {
  publishAvatarCue(events, { type: 'gesture', name });
}

/** 让角色表现一种语义情绪，weight 0..1（没有映射的角色忽略） */
export function avatarEmotion(events: Publisher, name: SemanticEmotion, weight?: number): void {
  publishAvatarCue(
    events,
    weight === undefined ? { type: 'emotion', name } : { type: 'emotion', name, weight },
  );
}
