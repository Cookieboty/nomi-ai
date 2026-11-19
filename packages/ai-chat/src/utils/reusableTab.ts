/**
 * 「新建对话」找可以复用的空标签。
 *
 * Nomi 主对话早就是这样：同一个项目里已经有还没说话的空对话就切过去，不再新建一个
 * （见 services/IPCClient.ts 的 newConversation）。CLI 标签以前每次点新建都真开一个
 * 新标签：侧栏会堆一串没用的空会话，每个还占着一个 CLI 进程。
 */
import type { HarnessBackend, HarnessTabMeta } from '../services/harnessClient';

/**
 * 标签还是空的：没有跑出过 CLI 会话（cliSessionId 由内核在真正开跑后写入）、
 * 没在跑，也不是 Nomi 委派出来的。
 */
export function isEmptyTab(tab: HarnessTabMeta): boolean {
  return (
    !tab.cliSessionId &&
    !tab.delegation &&
    tab.status !== 'running' &&
    tab.status !== 'queued' &&
    tab.status !== 'error'
  );
}

/** 同一个端、同一个项目下第一个还没说话的标签；没有就返回 undefined（照常新建）。 */
export function findReusableTab(
  tabs: readonly HarnessTabMeta[] | null | undefined,
  backend: HarnessBackend,
  projectId?: string,
): HarnessTabMeta | undefined {
  const want = projectId ?? '';
  return (tabs ?? []).find(
    (tab) => tab.backend === backend && (tab.projectId ?? '') === want && isEmptyTab(tab),
  );
}
