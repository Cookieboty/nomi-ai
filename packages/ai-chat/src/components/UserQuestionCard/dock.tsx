/**
 * 当前会话的问题卡：Nomi 对话按 conversationId，编程助手标签按 tabId。
 * 挂载时补拉一次，之后跟 ai.userQuestion 走。
 */
import React, { useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import { UserQuestionCard, type UserQuestionRequest, type UserQuestionSubmission } from './index';

interface QuestionEvent {
  id: string;
  closed?: boolean;
  source?: UserQuestionRequest['source'];
  conversationId?: string;
  tabId?: string;
  questions?: UserQuestionRequest['questions'];
  expiresAt?: number;
}

const isRequest = (ev: QuestionEvent): ev is QuestionEvent & UserQuestionRequest =>
  !ev.closed && !!ev.source && !!ev.questions?.length && typeof ev.expiresAt === 'number';

export const UserQuestionDock: React.FC<{
  conversationId?: string;
  tabId?: string;
}> = ({ conversationId, tabId }) => {
  const [items, setItems] = useState<UserQuestionRequest[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasTransport()) return;
    let alive = true;
    const apply = (ev: QuestionEvent) => {
      if (ev.closed || !isRequest(ev)) {
        if (ev.closed) setItems((list) => list.filter((item) => item.id !== ev.id));
        return;
      }
      const next: UserQuestionRequest = {
        id: ev.id,
        source: ev.source,
        conversationId: ev.conversationId,
        tabId: ev.tabId,
        questions: ev.questions,
        expiresAt: ev.expiresAt,
      };
      setItems((list) => {
        const i = list.findIndex((item) => item.id === next.id);
        if (i < 0) return [...list, next];
        const copy = list.slice();
        copy[i] = next;
        return copy;
      });
    };
    const off = api.on('ai.userQuestion', (payload) => apply(payload as QuestionEvent));
    void api.ai.userQuestion
      .pending()
      .then((list) => {
        if (alive) setItems(list as UserQuestionRequest[]);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!items.length) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [items.length]);

  const visible = items.filter((item) => {
    if (item.expiresAt <= now) return false;
    if (tabId) return item.tabId === tabId;
    return !item.tabId && !!conversationId && item.conversationId === conversationId;
  });
  const request = visible[0];
  if (!request) return null;

  const submit = (submission: UserQuestionSubmission) => {
    setItems((list) => list.filter((item) => item.id !== request.id));
    void api.ai.userQuestion
      .answer({
        id: request.id,
        action: submission.action,
        ...(submission.answers ? { answers: submission.answers } : {}),
        ...(submission.details ? { details: submission.details } : {}),
      })
      .catch(() => undefined);
  };

  return <UserQuestionCard key={request.id} request={request} onSubmit={submit} />;
};
