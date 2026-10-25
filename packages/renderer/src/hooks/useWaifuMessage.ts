import { t } from '@nomi-ai/ui';
import { useCallback } from 'react';

import { useMascot } from '@/contexts/MascotContext';
import { toBubbleText } from '@/security/bubbleText';

/** 在看板娘气泡中显示消息（带优先级与自动消失）。 */
export function useWaifuMessage() {
  const { state, dispatch } = useMascot();

  const showMessage = useCallback(
    (
      text: string | string[],
      timeout = 3000,
      priority = 8,
      clearPrevious = false,
      opts: { more?: boolean } = {},
    ) => {
      if (!text || (Array.isArray(text) && text.length === 0)) return;
      if (!clearPrevious && state.currentMessage && state.messagePriority > priority) return;
      // 台词常量（提示 / 互动反应 / 整点报时 / mascot:say）存的是 key，显示前晚翻译；普通文本原样返回
      const selected = toBubbleText(
        t(Array.isArray(text) ? text[Math.floor(Math.random() * text.length)] : text),
      );
      if (!selected) return;
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
