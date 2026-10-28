/**
 * 输入与输出：语义事件（docs/design/core-host-decoupling.md §10.5、§10.6）。
 *
 * avatar-runtime 不认识契约、IPC 或 AI SDK：宿主把它那边的事件（契约事件、TTS 口型、语音状态、
 * 主进程推来的光标与物理事件……）翻译成下面的 `AvatarEvent`，经一个 `AvatarEventSource` 注入。
 * 事件里只有语义（情绪、活动、手势名、口型包络，词表在 `@nomi-ai/character-contract`），
 * 具体播哪个表情 / 动作由角色包的 mapping.json 决定（mapping.ts），没有映射的忽略。
 *
 * 反方向（角色 → AI）是 `AvatarOutputEvent`：被摸、被点、当前场景。
 */
import type {
  SemanticActivity,
  SemanticEmotion,
  SemanticGesture,
} from '@nomi-ai/character-contract';

import type { MascotEvent } from './expressionDirector';

export type AvatarEvent =
  /**
   * 说话的口型包络 0..1（TTS 音量）：驱动嘴型与说话姿态。超过阈值即开始说话，安静一阵后停止
   * （`speaking(start / stop, envelope)` 由包络本身表达，0 = 静音）。
   */
  | { type: 'speaking'; level: number }
  /** 一个语义时刻（工具运行、任务完成、文件拖入、语音打断……）：由表情导演决定表情与动作 */
  | { type: 'cue'; cue: MascotEvent }
  /** 流式回复的增量文本：中途出现强烈情绪就提前反应 */
  | { type: 'reply'; phase: 'delta'; text: string }
  /** 回复结束（全文） */
  | { type: 'reply'; phase: 'complete'; text?: string }
  /** 用户停止生成 */
  | { type: 'reply'; phase: 'stopped' }
  /** 对话窗口正在等回复（还没有流式文本）/ 等待结束：保持思考的神态 */
  | { type: 'reply'; phase: 'waiting' | 'settled' }
  /** 语义情绪（AI 工具 / 内核服务），weight 0..1；不在词表或没有映射的忽略 */
  | { type: 'emotion'; name: SemanticEmotion | (string & {}); weight?: number }
  /** 语义手势（AI 工具 / 托盘 / 内核服务）；'random' = 随机手势，不受自动动作冷却限制 */
  | { type: 'gesture'; name: SemanticGesture | (string & {}) }
  /** 语义活动：思考中 / 工具运行中（保持姿态），idle 结束保持的姿态 */
  | { type: 'activity'; name: SemanticActivity | (string & {}) }
  /** 语音输入状态变化（录音、识别、唤醒……），prev 是上一个状态 */
  | { type: 'voice'; phase: string; prev: string }
  /** 全局光标（窗口坐标），窗口外也会推送 */
  | { type: 'cursor'; x: number; y: number; inside: boolean }
  /** 宿主窗口的物理事件（被抓起、落地、撞墙） */
  | { type: 'physics'; kind: string; speed: number };

export type AvatarEventListener = (event: AvatarEvent) => void;

/** 角色身上的命中区（契约命中区名，`any` = 没有落在具体区域） */
export type AvatarHitbox = 'head' | 'face' | 'body' | 'hand' | 'hem' | 'legs' | 'any';

/** 角色 → AI 的语义事件（运行时输出，宿主经契约转给内核）。 */
export type AvatarOutputEvent =
  /** 被摸（摸头、抚摸等持续接触） */
  | { type: 'touched'; hitbox: AvatarHitbox }
  /** 被点击；double = 双击 */
  | { type: 'clicked'; hitbox: AvatarHitbox; double?: boolean }
  /** 当前场景：哪个角色、它能表现哪些语义名（有映射的） */
  | {
      type: 'scene';
      characterId: string;
      emotions: SemanticEmotion[];
      activities: SemanticActivity[];
      gestures: SemanticGesture[];
    };

/** 语义事件源：运行时订阅它；返回值取消订阅。 */
export interface AvatarEventSource {
  subscribe(listener: AvatarEventListener): () => void;
}

/** 简单的事件中枢：宿主各处 `emit`，运行时 `subscribe`。 */
export interface AvatarEventHub extends AvatarEventSource {
  emit(event: AvatarEvent): void;
}

export function createAvatarEventHub(): AvatarEventHub {
  const listeners = new Set<AvatarEventListener>();
  return {
    emit(event) {
      for (const l of [...listeners]) {
        try {
          l(event);
        } catch {
          /* isolate listener error */
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
