import { t } from '@nomi-ai/ui';

import { shortReply } from '@/mascot/bubblePlacement';

export interface BubbleAgentStep {
  sessionId?: string;
  step?: number;
  reason?: 'llm-call' | 'tool-call' | 'reflect' | 'user-input' | string;
}

export interface BubbleMessagePart {
  type: 'text' | 'image' | 'audio' | 'toolCall' | 'toolResult' | 'sensory' | string;
  text?: string;
}

export interface BubbleMessage {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  parts?: readonly BubbleMessagePart[];
}

export interface BubbleMessageComplete {
  message: BubbleMessage;
}

export interface BubbleToolExecuted {
  toolName: string;
  reqId?: string;
  ok: boolean;
  error?: string;
}

export interface BubbleMascotTouch {
  hitArea: string;
  at?: number;
}

export interface BubbleDirective {
  text: string;
  priority: number;
  timeout: number;
  /** AI 回复被截短：气泡显示「查看全文」打开对话窗口 */
  more?: boolean;
  /** 来源：AI 回复（受「气泡显示 AI 回复」设置控制） */
  reply?: boolean;
}

export type BubbleEvent =
  | { kind: 'agent:step'; payload: BubbleAgentStep }
  | { kind: 'message:complete'; payload: BubbleMessageComplete }
  | { kind: 'tool:executed'; payload: BubbleToolExecuted }
  | { kind: 'avatar:touch'; payload: BubbleMascotTouch };

export const BUBBLE_PRIORITY = {
  agentStep: 6,
  toolExecuted: 7,
  touch: 6,
  messageComplete: 9,
} as const;

export const BUBBLE_TIMEOUT = {
  agentStep: 2500,
  toolExecuted: 3000,
  touch: 3000,
  messageComplete: 6000,
} as const;

export const AGENT_STEP_LABEL: Record<string, string> = {
  'llm-call': 'ui.chat-settings.thinking',
  'tool-call': 'ui.chat-settings.working-on-it',
  reflect: 'ui.chat-settings.reviewing-my-work',
  'user-input': 'ui.chat-settings.listening',
};

export function extractAssistantText(parts: readonly BubbleMessagePart[]): string {
  const buf: string[] = [];
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0) {
      buf.push(p.text);
    }
  }
  return buf.join('\n').trim();
}

export function truncateForBubble(text: string, max = 120): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function deriveBubble(evt: BubbleEvent): BubbleDirective | null {
  switch (evt.kind) {
    case 'agent:step': {
      const reason = evt.payload.reason ?? 'llm-call';
      const label = t(AGENT_STEP_LABEL[reason] ?? 'ui.chat-settings.processing');
      const step = typeof evt.payload.step === 'number' ? evt.payload.step : 0;
      return {
        text: step > 0 ? `${label} (step ${step})` : label,
        priority: BUBBLE_PRIORITY.agentStep,
        timeout: BUBBLE_TIMEOUT.agentStep,
      };
    }
    case 'message:complete': {
      const msg = evt.payload.message;
      if (!msg || msg.role !== 'assistant') return null;
      const text = extractAssistantText(msg.parts ?? []);
      if (!text) return null;
      const short = shortReply(text);
      return {
        text: short.text,
        more: short.truncated,
        reply: true,
        priority: BUBBLE_PRIORITY.messageComplete,
        // 长一点的摘要多停留一会（约 18 字 / 秒，4~12s）
        // 有「查看全文」时多留一会儿，方便去点
        timeout: Math.max(
          BUBBLE_TIMEOUT.messageComplete,
          Math.min(12000, 4000 + Array.from(short.text).length * 55),
          short.truncated ? 12000 : 0,
        ),
      };
    }
    case 'tool:executed': {
      const name = evt.payload.toolName || 'tool';
      const text = evt.payload.ok
        ? t('ui.chat-settings.done', name)
        : t('ui.chat-settings.failed', name, evt.payload.error ? `：${evt.payload.error}` : '');
      return {
        text: truncateForBubble(text),
        priority: BUBBLE_PRIORITY.toolExecuted,
        timeout: BUBBLE_TIMEOUT.toolExecuted,
      };
    }
    case 'avatar:touch': {
      const hit = evt.payload.hitArea || 'body';
      return {
        text: t('ui.chat-settings.touched', hit),
        priority: BUBBLE_PRIORITY.touch,
        timeout: BUBBLE_TIMEOUT.touch,
      };
    }
    default:
      return null;
  }
}

export interface DedupeState {
  lastText?: string;
  lastAt?: number;
}

export function shouldSuppress(
  directive: BubbleDirective,
  state: DedupeState,
  now: number,
  windowMs = 1000,
): boolean {
  if (!state.lastText || state.lastAt === undefined) return false;
  if (directive.text !== state.lastText) return false;
  return now - state.lastAt < windowMs;
}
