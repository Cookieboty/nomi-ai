/**
 * 委派结果消息下面的「已编辑 N 个文件」：子任务改的文件回到来源对话（和子任务面板里同一张卡片）。
 * 行级 Diff 从子任务标签自己的会话里读（标签已关 / 读不到时只列文件与增删行数，「查看更改」按 git 看）。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import {
  matchDelegateChanges,
  messagesInRange,
  peekPrefetchedGitFallback,
  peekPrefetchedTabMessages,
  resolveGitFallbackForReported,
  type DelegateChanges,
  type GitFallbackEntry,
} from '../../services/delegateChanges';
import { harnessClient, type HarnessTabMessage } from '../../services/harnessClient';
import { fromHarnessMessage } from '../../utils/convAdapters';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import type { ChangeEntry } from '../../utils/sessionChanges';
import { workspaceKey, workspaceRelPath } from '../../utils/workspacePath';
import { TurnEditSummaryCard } from '../SessionWorkspace/TurnEditSummaryCard';

function statusOf(added?: number, removed?: number): Pick<ChangeEntry, 'status' | 'letter'> {
  if (added && !removed) return { status: 'added', letter: 'A' };
  return { status: 'modified', letter: 'M' };
}

export const DelegateChangesCard: React.FC<{ messageId: string; changes: DelegateChanges }> = ({
  messageId,
  changes,
}) => {
  const { tabId, cwd, childCwd, backend, from, to, files } = changes;
  const [child, setChild] = useState<HarnessTabMessage[] | null>(() =>
    peekPrefetchedTabMessages(changes),
  );
  const [gitFallback, setGitFallback] = useState<ReadonlyMap<string, GitFallbackEntry> | null>(() =>
    peekPrefetchedGitFallback(changes),
  );
  useEffect(() => {
    if (!tabId) return;
    if (peekPrefetchedTabMessages(changes)) return;
    let alive = true;
    void harnessClient
      .tabMessages(tabId)
      .then((m) => alive && setChild(m))
      .catch(() => alive && setChild([]));
    return () => {
      alive = false;
    };
  }, [tabId, changes]);
  const matchCwd = childCwd ?? cwd;
  const conv = useMemo(() => {
    if (!child?.length) return [];
    return messagesInRange(
      child.map((m) => fromHarnessMessage(m, backend ?? 'claude')),
      from,
      to,
    );
  }, [child, backend, from, to]);
  const hasMissingLineDiff = useMemo(() => {
    const listed = files.map((f) => f.file);
    const matched = matchDelegateChanges(listed, conv, matchCwd, messageId, gitFallback).entries;
    return matched.some((e) => !e.diff);
  }, [files, conv, matchCwd, messageId, gitFallback]);
  useEffect(() => {
    if (!cwd || !hasMissingLineDiff) return;
    if (peekPrefetchedGitFallback(changes) || gitFallback) return;
    if (tabId && child === null) return;
    let alive = true;
    const listed = files.map((f) => f.file);
    const missingKeys = new Set(listed.map((f) => workspaceKey(workspaceRelPath(cwd, f))));
    void resolveGitFallbackForReported(listed, cwd, missingKeys, {
      gitDiff: (c) => harnessClient.gitDiff(c),
      readFile: (c, p) => harnessClient.workspaceRead(c, p),
    })
      .then((m) => {
        if (alive && m) setGitFallback(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cwd, hasMissingLineDiff, changes, gitFallback, tabId, child, files]);
  const entries = useMemo<ChangeEntry[]>(() => {
    const listed = files.map((f) => f.file);
    if (conv.length || gitFallback?.size) {
      const matched = matchDelegateChanges(listed, conv, matchCwd, messageId, gitFallback).entries;
      // 会话与 Git 里仍认不出的文件：若消息已持久化精确计数则保留（statsKnown: true），否则隐藏 +0 −0
      return matched.map((e, i) => {
        if (e.diff || e.statsKnown !== false) return e;
        const saved = files[i];
        if (saved?.added != null && saved?.removed != null) {
          return {
            ...e,
            added: saved.added,
            removed: saved.removed,
            statsKnown: true,
            ...statusOf(saved.added, saved.removed),
          };
        }
        return e;
      });
    }
    return files.map((f) => {
      const known = f.added != null && f.removed != null;
      return {
        file: f.file,
        added: f.added ?? 0,
        removed: f.removed ?? 0,
        statsKnown: known,
        ...statusOf(f.added, f.removed),
        messageId,
      };
    });
  }, [conv, files, matchCwd, messageId, gitFallback]);
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
