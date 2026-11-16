/**
 * 子任务 / 子代理是谁（图标 + 名字）：标签、会话详情的 Agents、悬停卡片共用这一份，
 * 都按它实际的来源判断，不再各自猜（以前进程内子代理没有来源时有的地方画机器人、有的画 Claude）。
 * - 编程助手标签：标签的后端；
 * - 后台 Nomi、侧边聊天：Nomi；
 * - 进程内子代理：派出它的那个对话——编程助手标签就是那个助手；父转录是 Nomi 对话时，
 *   按主标签当前接的后端（主标签切到编程助手时是它，平常就是 Nomi）。
 */
import { t } from '@nomi-ai/ui';

import { MAIN_TAB_ID, type HarnessTabMeta } from '../services/harnessClient';

import { ENDPOINT_NAME, type EndpointKey } from './endpointBadge';
import type { SubagentTarget } from './sideTabs';

type Tabs = readonly Pick<HarnessTabMeta, 'id' | 'backend'>[] | undefined;

const known = (b: string | null | undefined): EndpointKey | null =>
  b && b in ENDPOINT_NAME ? (b as EndpointKey) : null;

/** 进程内子代理所属的端点 */
export function nestedOwnerBackend(parentTabId: string | null, tabs: Tabs): EndpointKey | null {
  if (parentTabId) return known(tabs?.find((x) => x.id === parentTabId)?.backend);
  return known(tabs?.find((x) => x.id === MAIN_TAB_ID)?.backend) ?? 'nomi';
}

/** 父转录是 Nomi 对话时，能替子代理收话的标签：主标签接在编程助手上时就是主标签，否则没有 */
export function nestedHostTabId(parentTabId: string | null, tabs: Tabs): string | null {
  if (parentTabId) return parentTabId;
  const main = tabs?.find((x) => x.id === MAIN_TAB_ID);
  return main && main.backend !== 'nomi' ? MAIN_TAB_ID : null;
}

/** 侧栏标签 / 悬停卡片用的端点 */
export function agentTargetBackend(target: SubagentTarget, tabs: Tabs): EndpointKey | null {
  if (target.kind === 'nomi-task' || target.kind === 'side-chat') return 'nomi';
  if (target.kind === 'harness') return known(tabs?.find((x) => x.id === target.tabId)?.backend);
  return nestedOwnerBackend(target.parentTabId, tabs);
}

/** 会话详情 Agents 的一行：委派按它的编程助手；侧边聊天是 Nomi；子代理按所属端点，名字用它自己的类型 */
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
