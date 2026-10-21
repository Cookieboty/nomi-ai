/**
 * 回到 Nomi 主标签时恢复 Nomi 会话（#19）。
 *
 * 点侧栏里的 CLI 会话 / 分叉到 CLI 会把 ConversationStore 的「当前会话」切到 CLI 镜像项；
 * 之后从顶栏、快捷键或侧栏回到主标签，只切了 harness 标签，store 仍指向 CLI 镜像，
 * 而界面上还是 Nomi 的旧消息——下一轮会写进镜像，原会话丢轮次、关闭 CLI 标签时又被连带删除。
 * 这里统一在「主标签被激活」时把 store 当前会话拉回最近的 Nomi 会话并重载消息，
 * 不论是从哪个入口回来的。
 */
import { useEffect } from 'react';

import type { ConversationStore } from '../services/conversationStore';
import { MAIN_TAB_ID } from '../services/harnessClient';

export function restoreNomiConversation(store: ConversationStore): string | undefined {
  const cur = store.currentId();
  if (cur && store.isNomi(cur)) return undefined; // 已经在 Nomi 会话上
  const last = store.lastNomiId();
  if (!last) return undefined; // 没有可恢复的：发送时 ensureCurrentNomi 会新建
  store.switchTo(last);
  return last;
}

export function useRestoreNomiOnMain(
  activeTabId: string | undefined,
  getStore: () => ConversationStore | undefined,
  reload: () => Promise<void> | void,
): void {
  useEffect(() => {
    if (activeTabId !== MAIN_TAB_ID) return;
    const store = getStore();
    if (!store) return;
    if (restoreNomiConversation(store)) void reload();
    // getStore / reload 随渲染变化但语义稳定；只在激活的标签变化时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);
}
