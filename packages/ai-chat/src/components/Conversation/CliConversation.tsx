/**
 * 编程助手标签的会话视图：只有它订阅当前标签的实时进度（流式期间约每帧一次），
 * App 和其余 useHarnessTabs() 的消费者不跟着重渲染。
 */
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { useHarnessLive, useHarnessTabsCore } from '../../contexts/HarnessTabsContext';
import { harnessClient } from '../../services/harnessClient';
import { modelSwitchTipFor, useModelSwitch } from '../../services/modelSwitchTip';
import { tabLiveToConv } from '../../utils/convAdapters';

import { TabSandboxRequests } from './SandboxRequests';

import { ConversationView } from './index';

type Props = Omit<
  React.ComponentProps<typeof ConversationView>,
  'live' | 'onPermission' | 'onRetry' | 'onEdit' | 'onStopAgent'
>;

export const CliConversation: React.FC<Props> = (props) => {
  const tabs = useHarnessTabsCore();
  const tabLive = useHarnessLive((l) => l[props.scopeId]);
  const live = useMemo(() => tabLiveToConv(tabLive), [tabLive]);
  // 回调保持引用稳定：内联箭头会击穿每条消息的 memo，让窗口内所有助手消息重跑变更聚合 / trace 归并。
  // 回调里读 ref 拿最新的标签状态。
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  });
  const scopeRef = useRef(props.scopeId);
  const messagesRef = useRef(props.messages);
  useLayoutEffect(() => {
    scopeRef.current = props.scopeId;
    messagesRef.current = props.messages;
  });
  const onPermission = useCallback(
    (id: string, allow: boolean, opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' }) => {
      void tabsRef.current.replyPermissionFor(scopeRef.current, id, allow, opts);
    },
    [],
  );
  /** 重新生成 / 重试：删掉之前那条用户消息及之后的内容，从它开新会话重发 */
  const onRetry = useCallback((id: string) => {
    const list = messagesRef.current;
    const i = list.findIndex((m) => m.id === id);
    for (let k = i - 1; k >= 0; k--) {
      const m = list[k]!;
      if (m.role === 'user')
        return void tabsRef.current
          .resendFromTab(scopeRef.current, m.id, m.text)
          .catch(() => undefined);
    }
  }, []);
  /** 编辑：同样截断到这条用户消息之前，再发改过的内容 */
  const onEdit = useCallback((id: string, text: string) => {
    void tabsRef.current.resendFromTab(scopeRef.current, id, text).catch(() => undefined);
  }, []);
  const scopeId = props.scopeId;
  // 会话中途换了模型、还没发送：弱提示（发送后消失，切回原模型也消失）
  const switchedTo = useModelSwitch(scopeId);
  const modelSwitchTip = useMemo(
    () => modelSwitchTipFor(props.messages, switchedTo),
    [props.messages, switchedTo],
  );
  const onStopAgent = useCallback(
    (agentId: string) => void harnessClient.stopAgent(scopeId, agentId).catch(() => undefined),
    [scopeId],
  );
  // 沙箱授权卡片自己订阅标签状态：元素引用稳定，会话视图不跟着标签状态重渲染
  const sandboxRequests = useMemo(() => <TabSandboxRequests tabId={scopeId} />, [scopeId]);
  return (
    <ConversationView
      {...props}
      sandboxRequests={sandboxRequests}
      live={live}
      onPermission={onPermission}
      onRetry={onRetry}
      onEdit={onEdit}
      onStopAgent={onStopAgent}
      modelSwitchTip={modelSwitchTip}
    />
  );
};
