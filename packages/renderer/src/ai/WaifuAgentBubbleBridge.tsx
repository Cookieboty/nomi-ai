import { useAgent, useAIEvents } from '@nomi-ai/ai-sdk-client/react';
import { useCallback, useEffect, useRef } from 'react';
import type { FC } from 'react';

import {
  deriveBubble,
  shouldSuppress,
  type BubbleDirective,
  type BubbleMascotTouch,
  type BubbleMessageComplete,
  type BubbleToolExecuted,
  type DedupeState,
} from './bubbleReducer';

import { useWaifuMessage } from '@/hooks/useWaifuMessage';
import { interactionSettings } from '@/mascot/interaction/settings';

const WaifuAgentBubbleBridge: FC = () => {
  const { lastStep } = useAgent();
  const { showMessage } = useWaifuMessage();
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

  useAIEvents('avatar:touch', (payload) => {
    emit(
      deriveBubble({
        kind: 'avatar:touch',
        payload: payload as BubbleMascotTouch,
      }),
    );
  });

  return null;
};

export default WaifuAgentBubbleBridge;
