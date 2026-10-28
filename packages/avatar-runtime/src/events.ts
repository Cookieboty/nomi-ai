/**
 * 输入：语义事件流（docs/design/core-host-decoupling.md §10.5、§10.6）。
 *
 * avatar-runtime 不认识契约、IPC 或 AI SDK：宿主把它那边的事件（契约事件、TTS 口型、语音状态、
 * 主进程推来的光标与物理事件……）翻译成下面的 `AvatarEvent`，经一个 `AvatarEventSource` 注入。
 * 事件里只有语义（情绪、活动、手势名、口型包络），具体播哪个表情 / 动作由运行时决定。
 */
import type { MascotEvent } from './expressionDirector';

export type AvatarEvent =
  /** 口型包络 0..1（TTS 音量）：驱动嘴型与说话姿态 */
  | { type: 'speaking'; level: number }
  /** 一个语义时刻（工具运行、任务完成、文件拖入、语音打断……）：由表情导演决定表情与动作 */
  | { type: 'cue'; cue: MascotEvent }
  /** 流式回复的增量文本：中途出现强烈情绪就提前反应 */
  | { type: 'reply'; phase: 'delta'; text: string }
  /** 回复结束（全文） */
  | { type: 'reply'; phase: 'complete'; text?: string }
  /** 用户停止生成 */
  | { type: 'reply'; phase: 'stopped' }
  /** 显式情绪（AI 工具 / 托盘）；不在表情表里的忽略 */
  | { type: 'emotion'; name: string }
  /** 显式手势 / 动作（AI 工具 / 托盘 / 工具栏）；'random' = 随机手势，不受自动动作冷却限制 */
  | { type: 'gesture'; name: string }
  /** 语音输入状态变化（录音、识别、唤醒……），prev 是上一个状态 */
  | { type: 'voice'; phase: string; prev: string }
  /** 全局光标（窗口坐标），窗口外也会推送 */
  | { type: 'cursor'; x: number; y: number; inside: boolean }
  /** 宿主窗口的物理事件（被抓起、落地、撞墙） */
  | { type: 'physics'; kind: string; speed: number };

export type AvatarEventListener = (event: AvatarEvent) => void;

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
