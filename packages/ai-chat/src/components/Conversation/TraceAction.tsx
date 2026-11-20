/**
 * 助手消息操作栏的「执行轨迹」按钮（只在工作台模式下由 App 放进 slots.actions）：
 * 点开右侧抽屉看这一轮的时间线、工具参数与输出、网关请求、子进程收发。抽屉按需加载。
 */
import { t } from '@nomi-ai/ui';
import { IconZoomScan as ScanSearch } from '@tabler/icons-react';
import React, { Suspense, lazy, useState } from 'react';

import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import type { ConvMessage } from '../../types/conversation';
import type { TraceSource } from '../TraceDrawer';

import { ActionButton, type ConvSlots } from './Messages';
import { nomiSlots } from './nomiSlots';

const TraceDrawer = lazy(() => import('../TraceDrawer'));

function compactTurnTitle(prompt?: string): string {
  const line = prompt?.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!line) return t('ui.devtools.scope-turn');
  const short = line.length > 16 ? `${line.slice(0, 16)}…` : line;
  return `${t('ui.devtools.scope-turn')} · ${short}`;
}

export const TraceAction: React.FC<{
  message: ConvMessage;
  source: TraceSource;
  userPrompt?: string;
}> = ({ message, source, userPrompt }) => {
  const pane = useSubagentPane();
  const [open, setOpen] = useState(false);
  const handleOpen = () => {
    if (pane?.hasHost) {
      const title = compactTurnTitle(userPrompt);
      pane.openTrace(
        { kind: 'turn', message, source, userPrompt, title },
        { dedupeKey: `turn:${message.id}`, title },
      );
      return;
    }
    setOpen(true);
  };
  return (
    <>
      <ActionButton
        icon={ScanSearch}
        label={t('ui.devtools.execution-trace')}
        testId="msg-trace"
        onClick={handleOpen}
      />
      {open && (
        <Suspense fallback={null}>
          <TraceDrawer
            message={message}
            source={source}
            userPrompt={userPrompt}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
};

/** 给会话视图的 slots 加上「执行轨迹」按钮（App 只在工作台模式下用） */
export function traceActions(source: TraceSource): Pick<ConvSlots, 'actions'> {
  return {
    actions: (m, ctx) => <TraceAction message={m} source={source} userPrompt={ctx?.prompt} />,
  };
}

/** 工作台模式下的 Nomi 对话 slots：执行轨迹按客户端 nomi 关联网关请求 */
export const nomiTraceSlots: ConvSlots = { ...nomiSlots, ...traceActions({ kind: 'nomi' }) };
