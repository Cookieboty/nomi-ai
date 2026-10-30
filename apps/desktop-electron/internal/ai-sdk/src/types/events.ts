/**
 * AIClient 事件枚举 + payload map。
 *
 * 与 [`PluginEvent`](file:///../../bundle-ig-base/src/types/plugin.ts) 不同：
 * - 事件名以 **业务视角** 命名（`message:delta` / `tool:confirm-required` ...）；
 * - payload 全部 **structuredClone-safe**。
 *
 * AIClient 内部把 插件事件桥接为本表；对外仅暴露 `AIClient.on(evt, fn)`。
 */

import type { Message, MessagePart } from './Message';
import type { ToolConfirmRequest } from './ToolSpec';
import type { UserProfile } from './UserProfile';

export type AIClientEvent =
  | 'message:delta'
  | 'message:complete'
  | 'agent:step'
  | 'agent:turn-end'
  | 'agent:stopped-by-user'
  | 'tool:confirm-required'
  | 'tool:executed'
  | 'tts:chunk'
  | 'tts:end'
  | 'userProfile:changed'
  | 'avatar:touched'
  | 'avatar:clicked'
  | 'avatar:scene';

export interface MessageDeltaPayload {
  sessionId: string;
  messageId: string;
  /** 增量文本片段（仅对 text part 有效） */
  deltaText?: string;
  /** 若增量本身是完整 part（例如 toolCall），走这个 */
  part?: MessagePart;
}

export interface MessageCompletePayload {
  message: Message;
}

export interface AgentStepPayload {
  sessionId: string;
  step: number;
  reason: 'llm-call' | 'tool-call' | 'reflect' | 'user-input';
}

export interface AgentTurnEndPayload {
  sessionId: string;
  turnId: string;
  ok: boolean;
  reason?: string;
}

export interface AgentStoppedByUserPayload {
  sessionId: string;
  reqId: string;
}

export interface ToolExecutedPayload {
  toolName: string;
  reqId: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
}

export interface TtsChunkPayload {
  reqId: string;
  seq: number;
  mime: string;
  data: Uint8Array;
  rms?: number;
  atMs?: number;
  isFinal?: boolean;
}

export interface TtsEndPayload {
  reqId: string;
  ok: boolean;
  durationMs?: number;
}

export interface UserProfileChangedPayload {
  profile: UserProfile;
}

/** 角色被摸（语义事件，§10.5） */
export interface AvatarTouchedPayload {
  hitbox: string;
  at: number;
}

/** 角色被点击 */
export interface AvatarClickedPayload {
  hitbox: string;
  double?: boolean;
  at: number;
}

/** 角色窗口报告的场景：角色与它能表现的语义名 */
export interface AvatarScenePayload {
  characterId: string;
  emotions: string[];
  activities: string[];
  gestures: string[];
  at: number;
}

export interface AIClientEventMap {
  'message:delta': MessageDeltaPayload;
  'message:complete': MessageCompletePayload;
  'agent:step': AgentStepPayload;
  'agent:turn-end': AgentTurnEndPayload;
  'agent:stopped-by-user': AgentStoppedByUserPayload;
  'tool:confirm-required': ToolConfirmRequest;
  'tool:executed': ToolExecutedPayload;
  'tts:chunk': TtsChunkPayload;
  'tts:end': TtsEndPayload;
  'userProfile:changed': UserProfileChangedPayload;
  'avatar:touched': AvatarTouchedPayload;
  'avatar:clicked': AvatarClickedPayload;
  'avatar:scene': AvatarScenePayload;
}

export type AIClientEventPayload<E extends AIClientEvent> = AIClientEventMap[E];
