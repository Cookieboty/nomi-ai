/**
 * 助手消息操作栏的「执行轨迹」按钮（只在工作台模式下由 App 放进 slots.actions）：
 * 点开右侧抽屉看这一轮的时间线、工具参数与输出、网关请求、子进程收发。抽屉按需加载。
 */
import { t } from '@nomi-ai/ui';
import { ScanSearch } from 'lucide-react';
import React, { Suspense, lazy, useState } from 'react';

import type { ConvMessage } from '../../types/conversation';
import type { TraceSource } from '../TraceDrawer';

import { ActionButton, type ConvSlots } from './Messages';
import { nomiSlots } from './nomiSlots';

const TraceDrawer = lazy(() => import('../TraceDrawer'));

export const TraceAction: React.FC<{ message: ConvMessage; source: TraceSource }> = ({
  message,
  source,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton
        icon={ScanSearch}
        label={t('ui.devtools.execution-trace')}
        testId="msg-trace"
        onClick={() => setOpen(true)}
      />
      {open && (
        <Suspense fallback={null}>
          <TraceDrawer message={message} source={source} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
};

/** 给会话视图的 slots 加上「执行轨迹」按钮（App 只在工作台模式下用） */
export function traceActions(source: TraceSource): Pick<ConvSlots, 'actions'> {
  return { actions: (m) => <TraceAction message={m} source={source} /> };
}

/** 工作台模式下的 Nomi 对话 slots：执行轨迹按客户端 nomi 关联网关请求 */
export const nomiTraceSlots: ConvSlots = { ...nomiSlots, ...traceActions({ kind: 'nomi' }) };
