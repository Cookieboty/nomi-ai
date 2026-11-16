/**
 * 子任务改动带回来源对话：内核核对出的改动文件（delegate.completed 的 changedFiles / report.changedFiles）
 * 是权威列表；这里从子任务标签自己的会话里补上每个文件的 +/− 和行级 Diff（和子任务面板里
 * 「已编辑 N 个文件」卡片同一份数据），写进来源对话那条结果消息：
 *   - 消息正文列文件 + 增删行数（Nomi 下一轮从历史里读到改了什么；不放整段 Diff）；
 *   - 消息上记下 delegateChanges，对话里用同一张「已编辑 N 个文件」卡片打开每个文件的 Diff。
 */
import type { ConvMessage } from '../types/conversation';
import { fromHarnessMessage } from '../utils/convAdapters';
import { aggregateSessionChanges, type ChangeEntry } from '../utils/sessionChanges';
import { workspaceKey, workspaceRelPath } from '../utils/workspacePath';

import type { DelegateResult } from './delegateClient';
import type { HarnessTabMessage, HarnessTabsState } from './harnessClient';

export interface DelegateChangeFile {
  file: string;
  /** 子任务会话里认得出的增删行数（跑命令改的文件没有） */
  added?: number;
  removed?: number;
}

/** 结果消息上记下的子任务改动（持久化在消息里） */
export interface DelegateChanges {
  /** 子任务标签（读它的会话拿行级 Diff） */
  tabId?: string;
  /** 子任务的工作目录（文件路径相对它） */
  cwd?: string;
  backend?: string;
  /** 这一次（或接着对话的这一轮）的时间范围：只取这段里子任务会话的改动 */
  from?: number;
  to?: number;
  files: DelegateChangeFile[];
}

/** 内核核对出的改动文件：汇报里的优先（已按 git 核对），否则内核列出的 */
export function reportedFiles(r: DelegateResult): string[] {
  const files = (r.report?.changedFiles?.length ? r.report.changedFiles : r.changedFiles) ?? [];
  return [...new Set(files.filter(Boolean))];
}

/** 子任务会话里 [from, to] 之间的消息（没有范围时全部） */
export function messagesInRange(
  messages: readonly ConvMessage[],
  from?: number,
  to?: number,
): ConvMessage[] {
  if (from == null && to == null) return [...messages];
  return messages.filter(
    (m) => (from == null || (m.at ?? 0) >= from) && (to == null || (m.at ?? 0) <= to),
  );
}

const keyOf = (cwd: string | undefined, file: string) => workspaceKey(workspaceRelPath(cwd, file));

/**
 * 子任务会话里的改动，按内核列出的文件挑出来（同路径后写覆盖）；内核列表里有、会话里认不出的
 * （跑命令改的）只带路径。返回的 entries 带行级 Diff（卡片用），files 只有路径和计数（消息正文用）。
 */
export function matchDelegateChanges(
  reported: readonly string[],
  childMessages: readonly ConvMessage[],
  cwd: string | undefined,
  messageId: string,
): { files: DelegateChangeFile[]; entries: ChangeEntry[] } {
  const byKey = new Map<string, ChangeEntry>();
  for (const e of aggregateSessionChanges(childMessages)) {
    if (e.file && e.file !== '(unnamed)') byKey.set(keyOf(cwd, e.file), e);
  }
  const files: DelegateChangeFile[] = [];
  const entries: ChangeEntry[] = [];
  for (const f of reported) {
    const hit = byKey.get(keyOf(cwd, f));
    if (hit) {
      files.push({ file: f, added: hit.added, removed: hit.removed });
      entries.push({ ...hit, file: workspaceRelPath(cwd, hit.file), messageId });
    } else {
      files.push({ file: f });
      entries.push({
        file: f,
        added: 0,
        removed: 0,
        status: 'modified',
        letter: 'M',
        messageId,
      });
    }
  }
  return { files, entries };
}

export interface DelegateChangesDeps {
  tabs: () => Promise<HarnessTabsState>;
  tabMessages: (id: string) => Promise<HarnessTabMessage[]>;
  now?: () => number;
}

/** 读子任务会话等太久就不等了（结果消息照样写，只是没有 +/−） */
const READ_TIMEOUT_MS = 2500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * 委派结果 → 子任务改动（没有改动文件时 null）。读不到子任务会话（标签已关、超时）时仍返回文件列表，只是没有计数。
 */
export async function collectDelegateChanges(
  r: DelegateResult,
  deps: DelegateChangesDeps,
): Promise<DelegateChanges | null> {
  const reported = reportedFiles(r);
  if (!reported.length) return null;
  const now = deps.now?.() ?? Date.now();
  // 这一次 / 这一轮的时间范围：从结束往前推用时（多留 1 秒），之后的不算
  const from = r.durationMs > 0 ? now - r.durationMs - 1000 : undefined;
  const to = now + 1000;
  const state = await withTimeout(deps.tabs(), READ_TIMEOUT_MS);
  const tab =
    state?.tabs.find((x) => x.id === r.tabId) ??
    state?.tabs.find((x) => x.delegation?.taskId === r.taskId);
  const tabId = tab?.id ?? r.tabId;
  const base: DelegateChanges = {
    ...(tabId ? { tabId } : {}),
    ...(tab?.cwd ? { cwd: tab.cwd } : {}),
    ...(tab?.backend ? { backend: tab.backend } : {}),
    ...(from != null ? { from } : {}),
    to,
    files: reported.map((file) => ({ file })),
  };
  if (!tabId) return base;
  const raw = await withTimeout(deps.tabMessages(tabId), READ_TIMEOUT_MS);
  if (!raw) return base;
  const backend = tab?.backend ?? (r.cli === 'nomi' ? 'claude' : r.cli);
  const conv = messagesInRange(
    raw.map((m) => fromHarnessMessage(m, backend)),
    from,
    to,
  );
  return { ...base, files: matchDelegateChanges(reported, conv, tab?.cwd, '').files };
}
