/**
 * 委派结果消息下面的「已编辑 N 个文件」：子任务改的文件回到来源对话（和子任务面板里同一张卡片）。
 * 行级 Diff 从子任务标签自己的会话里读（标签已关 / 读不到时只列文件与增删行数，「查看更改」按 git 看）。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import {
  matchDelegateChanges,
  messagesInRange,
  type DelegateChanges,
} from '../../services/delegateChanges';
import { harnessClient, type HarnessTabMessage } from '../../services/harnessClient';
import { fromHarnessMessage } from '../../utils/convAdapters';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import type { ChangeEntry } from '../../utils/sessionChanges';
import { TurnEditSummaryCard } from '../SessionWorkspace/TurnEditSummaryCard';

function statusOf(added?: number, removed?: number): Pick<ChangeEntry, 'status' | 'letter'> {
  if (added && !removed) return { status: 'added', letter: 'A' };
  return { status: 'modified', letter: 'M' };
}

export const DelegateChangesCard: React.FC<{ messageId: string; changes: DelegateChanges }> = ({
  messageId,
  changes,
}) => {
  const { tabId, cwd, backend, from, to, files } = changes;
  const [child, setChild] = useState<HarnessTabMessage[] | null>(null);
  useEffect(() => {
    if (!tabId) return;
    let alive = true;
    void harnessClient
      .tabMessages(tabId)
      .then((m) => alive && setChild(m))
      .catch(() => alive && setChild([]));
    return () => {
      alive = false;
    };
  }, [tabId]);
  const entries = useMemo<ChangeEntry[]>(() => {
    const listed = files.map((f) => f.file);
    if (child?.length) {
      const conv = messagesInRange(
        child.map((m) => fromHarnessMessage(m, backend ?? 'claude')),
        from,
        to,
      );
      const matched = matchDelegateChanges(listed, conv, cwd, messageId).entries;
      // 会话里认不出的文件用消息里记下的计数
      return matched.map((e, i) =>
        e.diff ? e : { ...e, added: files[i]?.added ?? 0, removed: files[i]?.removed ?? 0 },
      );
    }
    return files.map((f) => ({
      file: f.file,
      added: f.added ?? 0,
      removed: f.removed ?? 0,
      ...statusOf(f.added, f.removed),
      messageId,
    }));
  }, [child, files, cwd, backend, from, to, messageId]);
  if (!entries.length) return null;
  return (
    <div data-testid="delegate-changes">
      <TurnEditSummaryCard
        messageId={messageId}
        entries={entries}
        cwd={cwd}
        sourceLabel={
          backend ? t((ENDPOINT_NAME as Record<string, string>)[backend] ?? backend) : undefined
        }
      />
    </div>
  );
};
