/**
 * 子任务 / 子代理是谁（图标 + 名字）：标签、会话详情的 Agents、悬停卡片共用这一份，
 * 都按它实际的来源判断，不再各自猜（以前进程内子代理没有来源时有的地方画机器人、有的画 Claude）。
 * - agent 标签：标签的后端；
 * - 后台 Nomi、侧边聊天：Nomi；
 * - 进程内子代理：派出它的那个对话——agent 标签就是那个助手；父转录是 Nomi 对话时，
 *   按主标签当前接的后端（主标签切到 agent 时是它，平常就是 Nomi）。
 */
import { t } from '@nomi-ai/ui';

import { MAIN_TAB_ID, type HarnessTabMeta } from '../services/harnessClient';
import type { ConvMessage } from '../types/conversation';

import { ENDPOINT_NAME, type EndpointKey } from './endpointBadge';
import type { SubagentTarget } from './sideTabs';
import { reduceTraceCached } from './toolTrace';

type Tabs = readonly Pick<HarnessTabMeta, 'id' | 'backend'>[] | undefined;

const known = (b: string | null | undefined): EndpointKey | null =>
  b && b in ENDPOINT_NAME ? (b as EndpointKey) : null;

/** 父转录里这条调用所在消息的实际生成后端；还在流式输出（未进历史）时返回 null */
export function callMessageBackend(
  messages: readonly ConvMessage[] | undefined,
  callId: string | undefined,
): EndpointKey | null {
  if (!messages?.length || !callId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!m.trace?.length) continue;
    for (const e of reduceTraceCached(m.trace)) {
      if (e.type === 'tool' && e.call.id === callId) {
        if (!m.model) return null;
        if (m.model === 'claude-code') return 'claude';
        const cli = known(m.model);
        return cli && cli !== 'other' ? cli : 'nomi';
      }
    }
  }
  return null;
}

/** 进程内子代理所属的端点：优先按父消息记录的实际后端，流式中再看主标签当前后端 */
export function nestedOwnerBackend(
  parentTabId: string | null,
  tabs: Tabs,
  callId?: string,
  columnMessages?: readonly ConvMessage[],
): EndpointKey | null {
  if (parentTabId) return known(tabs?.find((x) => x.id === parentTabId)?.backend);
  const fromMsg = callMessageBackend(columnMessages, callId);
  if (fromMsg) return fromMsg;
  return known(tabs?.find((x) => x.id === MAIN_TAB_ID)?.backend) ?? 'nomi';
}

/** 父转录是 Nomi 对话时，能替子代理收话的标签：主标签接在派出它的同一个 agent 上时才是主标签 */
export function nestedHostTabId(
  parentTabId: string | null,
  tabs: Tabs,
  callId?: string,
  columnMessages?: readonly ConvMessage[],
): string | null {
  if (parentTabId) return parentTabId;
  const main = tabs?.find((x) => x.id === MAIN_TAB_ID);
  if (!main || main.backend === 'nomi') return null;
  const fromMsg = callMessageBackend(columnMessages, callId);
  if (fromMsg && fromMsg !== main.backend) return null;
  return MAIN_TAB_ID;
}

/** 侧栏标签 / 悬停卡片用的端点 */
export function agentTargetBackend(
  target: SubagentTarget,
  tabs: Tabs,
  columnMessages?: readonly ConvMessage[],
): EndpointKey | null {
  if (target.kind === 'nomi-task' || target.kind === 'side-chat') return 'nomi';
  if (target.kind === 'harness') return known(tabs?.find((x) => x.id === target.tabId)?.backend);
  return nestedOwnerBackend(target.parentTabId, tabs, target.callId, columnMessages);
}

/** 会话详情 Agents 的一行：委派按它的 agent；侧边聊天是 Nomi；子代理按所属端点，名字用它自己的类型 */
export function sessionAgentIdentity(
  a: { kind: 'delegate' | 'subagent' | 'side-chat'; backend?: string | null; label?: string },
  ownerBackend: EndpointKey | null | undefined,
): { name: string; backend: EndpointKey | null } {
  if (a.kind === 'delegate') {
    const backend = known(a.backend);
    return {
      backend,
      name: backend ? t(ENDPOINT_NAME[backend]) : a.backend || t('ui.usage-tools.subagent'),
    };
  }
  if (a.kind === 'side-chat')
    return { backend: 'nomi', name: a.label || t('ui.session-workspace.side-chat-title') };
  return { backend: ownerBackend ?? null, name: a.label || t('ui.usage-tools.subagent') };
}
