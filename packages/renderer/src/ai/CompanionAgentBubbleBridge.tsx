import { useAgent, useAIEvents } from '@nomi-ai/ai-sdk-client/react';
import { interactionSettings } from '@nomi-ai/avatar-runtime';
import { useCallback, useEffect, useRef } from 'react';
import type { FC } from 'react';

import {
  deriveBubble,
  shouldSuppress,
  type BubbleDirective,
  type BubbleMessageComplete,
  type BubbleToolExecuted,
  type DedupeState,
} from './bubbleReducer';

import { useCompanionMessage } from '@/hooks/useCompanionMessage';

/**
 * AI 门面事件（Agent 步骤、回复完成、工具结果）→ 桌面角色气泡。被摸 / 被点的气泡由角色运行时的
 * 互动反应给出（avatar/interaction.ts），这里不再重复。
 */
const CompanionAgentBubbleBridge: FC = () => {
  const { lastStep } = useAgent();
  const { showMessage } = useCompanionMessage();
  const lastAgentAtRef = useRef<number>(0);
  const dedupeRef = useRef<DedupeState>({});

  const emit = useCallback(
    (directive: BubbleDirective | null) => {
      if (!directive) return;
      if (directive.reply && !interactionSettings.get().bubbleReplies) return;
      const now = Date.now();
      if (shouldSuppress(directive, dedupeRef.current, now)) return;
      dedupeRef.current = { lastText: directive.text, lastAt: now };
      showMessage(directive.text, directive.timeout, directive.priority, false, {
        more: directive.more,
      });
    },
    [showMessage],
  );

  useEffect(() => {
    if (!lastStep) return;
    if (lastStep.at <= lastAgentAtRef.current) return;
    lastAgentAtRef.current = lastStep.at;
    emit(
      deriveBubble({
        kind: 'agent:step',
        payload: {
          sessionId: lastStep.sessionId,
          step: lastStep.step,
          reason: lastStep.reason,
        },
      }),
    );
  }, [lastStep, emit]);

  useAIEvents('message:complete', (payload) => {
    emit(
      deriveBubble({
        kind: 'message:complete',
        payload: payload as BubbleMessageComplete,
      }),
    );
  });

  useAIEvents('tool:executed', (payload) => {
    emit(
      deriveBubble({
        kind: 'tool:executed',
        payload: payload as BubbleToolExecuted,
      }),
    );
  });

  return null;
};

export default CompanionAgentBubbleBridge;
