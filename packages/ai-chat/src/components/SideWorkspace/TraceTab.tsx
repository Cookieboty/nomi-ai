/**
 * 会话工作区「运行轨迹」标签页：
 * - 按 pageId 读取内存中的 SideTraceEntry（session / turn / task）；
 * - 默认与 SideWorkspace 一同保活（hidden 切换不丢失缩放/选中/视图状态），且与实时会话消息同步。
 */
import React, { useMemo } from 'react';

import { useSideTrace } from '../../services/sideTrace';
import type { ConvMessage } from '../../types/conversation';
import { TraceWorkbench } from '../TraceDrawer';
import type { TraceTarget } from '../TraceDrawer/sessionLoader';
import { useSessionTraceTarget } from '../TraceDrawer/useSessionTraceTarget';

export const TraceTab: React.FC<{
  pageId: string;
  title?: string;
  hidden?: boolean;
  messages: readonly ConvMessage[];
}> = ({ pageId, title, hidden, messages }) => {
  const entry = useSideTrace(pageId);
  const spec = entry?.spec;
  const sessionTarget = useSessionTraceTarget(
    messages,
    spec?.kind === 'session' ? (spec.title ?? title) : title,
  );

  const target: TraceTarget = useMemo(() => {
    if (!spec || spec.kind === 'session') return sessionTarget;
    if (spec.kind === 'task') {
      return { kind: 'task', task: spec.task, attempts: spec.attempts };
    }
    const latestMsg = messages.find((m) => m.id === spec.message.id) ?? spec.message;
    return {
      kind: 'turn',
      message: latestMsg,
      source: spec.source,
      userPrompt: spec.userPrompt,
      allMessages: messages,
    };
  }, [spec, sessionTarget, messages]);

  return <TraceWorkbench target={target} embedded hidden={hidden} />;
};

export default TraceTab;
