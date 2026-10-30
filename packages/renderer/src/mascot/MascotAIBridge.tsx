import { useAgent, useAIEvents } from '@nomi-ai/ai-sdk-client/react';
import { useEffect } from 'react';
import type { FC } from 'react';

import { avatarEvents } from '../avatar/events';

import { extractAssistantText, type BubbleMessageComplete } from '@/ai/bubbleReducer';

function deltaText(p: unknown): string {
  const v = (p as { deltaText?: unknown } | undefined)?.deltaText;
  return typeof v === 'string' ? v : '';
}

/**
 * 聊天 / Agent / 工具事件（契约 AI 门面）→ avatar-runtime 的语义事件（活动、回复、语义时刻）。
 * 表情与动作怎么做（流式中途的情绪、结尾去重、保持姿态的释放）由运行时决定。
 * 仅在契约传输就绪（AIProvider 可用）时挂载。
 */
const MascotAIBridge: FC = () => {
  const { lastStep } = useAgent();

  useEffect(() => {
    if (lastStep) {
      // 工具调用步骤 → 活动「工具运行中」；其余（等待模型）→「思考中」
      const tool = /tool/i.test(lastStep.reason);
      avatarEvents.emit({ type: 'activity', name: tool ? 'toolRunning' : 'thinking' });
    }
  }, [lastStep]);

  useAIEvents('message:delta', (payload) => {
    avatarEvents.emit({ type: 'reply', phase: 'delta', text: deltaText(payload) });
  });

  useAIEvents('message:complete', (payload) => {
    const msg = (payload as BubbleMessageComplete | undefined)?.message;
    const text = msg?.parts ? extractAssistantText(msg.parts) : undefined;
    avatarEvents.emit({ type: 'reply', phase: 'complete', text });
  });

  useAIEvents('agent:stopped-by-user', () => {
    avatarEvents.emit({ type: 'reply', phase: 'stopped' });
  });

  useAIEvents('tool:confirm-required', () => {
    avatarEvents.emit({ type: 'cue', cue: { kind: 'confirm-required' } });
  });

  useAIEvents('tool:executed', (payload) => {
    const p = payload as { error?: unknown; ok?: boolean; success?: boolean } | undefined;
    const ok = p?.ok ?? p?.success ?? !p?.error;
    avatarEvents.emit({ type: 'cue', cue: { kind: 'tool:executed', ok } });
  });

  return null;
};

export default MascotAIBridge;
