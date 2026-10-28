import { useCallback } from 'react';

import { useMascot } from '@/contexts/MascotContext';
import { availableLines, bubbleText } from '@/mascot/characterCopy';
import { getActiveModelName } from '@/mascot/characterVoice';
import { playPromptClip } from '@/mascot/voice/promptClips';
import { toBubbleText } from '@/security/bubbleText';
import { mascotCueService } from '@/services/cues/MascotCueService';

/**
 * 气泡同时尝试播放诺米预录片段（仅清单里有的固定台词，或 opts.clip 指定的片段）；
 * 这里从不调用实时朗读，没有片段就只显示文字。
 */
export function playBubbleClip(keyOrText: string, clip: string | null | undefined): void {
  if (clip === null || !mascotCueService.canSpeak()) return;
  void playPromptClip(keyOrText, {
    modelName: getActiveModelName(),
    clip,
    volume: mascotCueService.getGate().voiceVolume,
  }).catch(() => undefined);
}

/** 在看板娘气泡中显示消息（带优先级与自动消失）。 */
export function useCompanionMessage() {
  const { state, dispatch } = useMascot();

  const showMessage = useCallback(
    (
      text: string | string[],
      timeout = 3000,
      priority = 8,
      clearPrevious = false,
      opts: { more?: boolean; clip?: string | null } = {},
    ) => {
      if (!text || (Array.isArray(text) && text.length === 0)) return;
      if (!clearPrevious && state.currentMessage && state.messagePriority > priority) return;
      // 台词常量（提示 / 互动反应 / 整点报时 / mascot:say）存的是 key，显示前晚翻译；普通文本原样返回。
      // 角色台词从当前角色包取，包里没有的那句不显示。
      const pool = availableLines(Array.isArray(text) ? text : [text]);
      if (pool.length === 0) return;
      const raw = pool[Math.floor(Math.random() * pool.length)]!;
      const selected = toBubbleText(bubbleText(raw));
      if (!selected) return;
      playBubbleClip(raw, opts.clip);
      if (clearPrevious) dispatch({ type: 'CLEAR_MESSAGE' });
      dispatch({
        type: 'SET_MESSAGE',
        payload: { text: selected, priority, timeout, more: opts.more },
      });
    },
    [state.currentMessage, state.messagePriority, dispatch],
  );

  return { showMessage };
}
