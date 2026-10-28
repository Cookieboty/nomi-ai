/**
 * 右栏「改动」的提交区（固定在底部）与分支栏的同步按钮（docs/design/changes-panel-git.md）。
 * git 由主进程执行（cli/gitOps.ts）：钩子照常跑，拉取只快进，推送从不强推。
 */
import { Button, Checkbox, Disclosure, t } from '@nomi-ai/ui';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  CloudDownload,
  Sparkles,
  Undo2,
} from 'lucide-react';
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

import {
  harnessClient,
  type GitOpCode,
  type GitOpResult,
  type GitSyncStatus,
} from '../../services/harnessClient';
import { confirmDialog } from '../ConfirmDialog';

import pane from './WorkspacePane.module.css';

export type GitOp = 'stage' | 'commit' | 'undo' | 'fetch' | 'pull' | 'push' | 'suggest' | 'discard';

interface Notice {
  tone: 'ok' | 'error';
  text: string;
  output?: string;
  /** 刚才的提交 / 放弃：可以撤销；cwd 是做这次操作的工作区，撤销只作用于它 */
  undo?:
    | { kind: 'commit'; cwd: string; sha: string; message: string }
    | { kind: 'discard'; cwd: string; stashes: string[] };
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function gitErrorText(code: GitOpCode | undefined): string {
  switch (code) {
    case 'busy':
      return t('ui.session-workspace.git-error-busy');
    case 'auth':
      return t('ui.session-workspace.git-error-auth');
    case 'diverged':
      return t('ui.session-workspace.git-error-diverged');
    case 'rejected':
      return t('ui.session-workspace.git-error-rejected');
    case 'dirty':
      return t('ui.session-workspace.git-error-dirty');
    case 'hook':
      return t('ui.session-workspace.git-error-hook');
    case 'nothing':
      return t('ui.session-workspace.git-error-nothing');
    case 'detached':
      return t('ui.session-workspace.git-error-detached');
    case 'no-remote':
      return t('ui.session-workspace.git-error-no-remote');
    case 'no-upstream':
      return t('ui.session-workspace.git-error-no-upstream');
    case 'mismatch':
      return t('ui.session-workspace.git-error-mismatch');
    case 'moved':
      return t('ui.session-workspace.git-error-moved');
    case 'pushed':
      return t('ui.session-workspace.git-error-pushed');
    case 'no-model':
      return t('ui.session-workspace.git-error-no-model');
    case 'timeout':
      return t('ui.session-workspace.git-error-timeout');
    default:
      return t('ui.session-workspace.git-error-failed');
  }
}

/** 提交区与同步按钮共用的状态；refresh 在每次写操作后重读 diff / 分支 / 上游 */
export function useGitOps(cwd: string | null | undefined, refresh: () => void) {
  const [op, setOp] = useState<GitOp | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [message, setMessage] = useState('');
  const [pushAfter, setPushAfter] = useState(false);
  const opRef = useRef<GitOp | null>(null);

  // 换目录：上一个仓库的提示和没写完的提交信息不带过来
  const [forCwd, setForCwd] = useState(cwd);
  if (forCwd !== cwd) {
    setForCwd(cwd);
    setNotice(null);
    setMessage('');
  }
  // 操作进行中换了工作区：旧操作晚到的结果（提示、撤销、生成的提交信息）不写进新工作区（#152）。
  // 每个操作用发起时闭包里的 cwd，完成后和当前的比一下
  const cwdRef = useRef(cwd);
  useLayoutEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  const here = (at: string) => cwdRef.current === at;

  const exec = useCallback(
    async (kind: GitOp, fn: () => Promise<GitOpResult>): Promise<GitOpResult | null> => {
      if (!cwd || opRef.current) return null;
      opRef.current = kind;
      setOp(kind);
      if (kind !== 'stage') setNotice(null);
      let r: GitOpResult;
      try {
        r = await fn();
      } catch (e) {
        r = { ok: false, code: 'error', output: e instanceof Error ? e.message : String(e) };
      } finally {
        opRef.current = null;
        setOp(null);
      }
      if (!r.ok && cwdRef.current === cwd)
        setNotice({ tone: 'error', text: gitErrorText(r.code), output: r.output });
      // 生成提交信息只读
      if (kind !== 'suggest') refresh();
      return r;
    },
    [cwd, refresh],
  );

  const stage = (paths: string[], on: boolean) =>
    cwd && paths.length
      ? exec('stage', () =>
          on ? harnessClient.gitStage(cwd, paths) : harnessClient.gitUnstage(cwd, paths),
        )
      : null;

  const push = async (sync: GitSyncStatus | null) => {
    if (!cwd) return;
    const r = await exec('push', () => harnessClient.gitPush(cwd));
    if (r?.ok && here(cwd)) {
      const target = sync?.upstream ?? sync?.pushRemote ?? '';
      setNotice({ tone: 'ok', text: t('ui.session-workspace.pushed-to', target) });
    }
  };

  /** paths：没有已暂存内容时要提交的文件；undefined = 只提交已暂存的 */
  const commit = async (paths: string[] | undefined, sync: GitSyncStatus | null) => {
    const msg = message.trim();
    if (!cwd || !msg) return;
    const r = await exec('commit', () => harnessClient.gitCommit(cwd, msg, paths));
    if (!r?.ok || !r.sha) return;
    if (here(cwd)) {
      setMessage('');
      setNotice({
        tone: 'ok',
        text: t('ui.session-workspace.committed-sha', r.sha.slice(0, 7)),
        undo: { kind: 'commit', cwd, sha: r.sha, message: msg },
      });
    }
    if (pushAfter) await push(sync);
  };

  const undo = async () => {
    const u = notice?.undo;
    if (!cwd || !u) return;
    // 撤销记录属于别的工作区：不对当前工作区执行
    if (u.cwd !== cwd) {
      setNotice(null);
      return;
    }
    const r = await exec('undo', () =>
      u.kind === 'commit'
        ? harnessClient.gitCommitUndo(cwd, u.sha)
        : harnessClient.gitDiscardUndo(cwd, u.stashes),
    );
    if (r?.ok && here(cwd)) {
      setNotice(null);
      if (u.kind === 'commit') setMessage(u.message);
    }
  };

  /** 辅助模型写提交信息（替换输入框里的内容）；paths 同 commit */
  const suggest = async (paths: string[] | undefined) => {
    if (!cwd) return;
    const r = await exec('suggest', () => harnessClient.gitSuggestMessage(cwd, paths));
    if (r?.ok && r.message && here(cwd)) setMessage(r.message);
  };

  /** 放弃未暂存的改动：先确认；存进 stash，可以撤销 */
  const discard = async (paths: string[]) => {
    if (!cwd || !paths.length) return;
    const ask =
      paths.length === 1
        ? t('ui.session-workspace.discard-unstaged-changes-in', paths[0]!)
        : t('ui.session-workspace.discard-unstaged-changes-in-n-files', String(paths.length));
    if (!(await confirmDialog({ message: ask, danger: true }))) return;
    const r = await exec('discard', () => harnessClient.gitDiscard(cwd, paths));
    if (r?.ok && r.stashes?.length && here(cwd))
      setNotice({
        tone: 'ok',
        text: t('ui.session-workspace.discarded-changes-saved-in-git-stash', String(paths.length)),
        undo: { kind: 'discard', cwd, stashes: r.stashes },
      });
  };

  const fetchRemote = async () => {
    if (!cwd) return;
    const r = await exec('fetch', () => harnessClient.gitFetch(cwd));
    if (!r?.ok || !here(cwd)) return;
    // 落后几个提交要等重读的上游状态；这里只说检查过了
    setNotice({ tone: 'ok', text: t('ui.session-workspace.checked-the-remote') });
  };

  const pull = async () => {
    if (!cwd) return;
    const r = await exec('pull', () => harnessClient.gitPull(cwd));
    if (r?.ok && here(cwd))
      setNotice({ tone: 'ok', text: t('ui.session-workspace.pulled-fast-forward') });
  };

  return {
    op,
    notice,
    dismiss: () => setNotice(null),
    message,
    setMessage,
    pushAfter,
    setPushAfter,
    stage,
    commit,
    undo,
    suggest,
    discard,
    fetchRemote,
    pull,
    push,
  };
}

export type GitOps = ReturnType<typeof useGitOps>;

/** 分支栏右侧：检查远端 / 拉取 / 推送 */
export const GitSyncButtons: React.FC<{ sync: GitSyncStatus | null; ops: GitOps }> = ({
  sync,
  ops,
}) => {
  if (!sync?.branch) return null;
  const busy = ops.op !== null;
  const canFetch = !!sync.upstream || !!sync.pushRemote;
  return (
    <span className={pane.syncButtons} data-testid="rail-git-sync">
      {sync.upstream ? (
        <span className={pane.upstream} title={t('ui.session-workspace.upstream', sync.upstream)}>
          {sync.upstream}
        </span>
      ) : (
        <span className={pane.upstream} data-testid="rail-git-unpublished">
          {t('ui.session-workspace.not-on-the-remote-yet')}
        </span>
      )}
      {canFetch ? (
        <button
          type="button"
          className={pane.syncBtn}
          disabled={busy}
          data-busy={ops.op === 'fetch' || undefined}
          data-testid="rail-git-fetch"
          title={t('ui.session-workspace.check-the-remote-for-new-commits')}
          aria-label={t('ui.session-workspace.check-the-remote-for-new-commits')}
          onClick={() => void ops.fetchRemote()}
        >
          <CloudDownload size={13} />
        </button>
      ) : null}
      {sync.upstream && sync.behind > 0 ? (
        <button
          type="button"
          className={pane.syncBtn}
          disabled={busy}
          data-busy={ops.op === 'pull' || undefined}
          data-testid="rail-git-pull"
          title={t('ui.session-workspace.pull-n-commits-fast-forward-only', String(sync.behind))}
          aria-label={t(
            'ui.session-workspace.pull-n-commits-fast-forward-only',
            String(sync.behind),
          )}
          onClick={() => void ops.pull()}
        >
          <ArrowDownToLine size={13} />
          {sync.behind}
        </button>
      ) : null}
      {sync.upstream ? (
        sync.ahead > 0 ? (
          <button
            type="button"
            className={pane.syncBtn}
            disabled={busy}
            data-busy={ops.op === 'push' || undefined}
            data-testid="rail-git-push"
            title={t('ui.session-workspace.push-n-commits-to', String(sync.ahead), sync.upstream)}
            aria-label={t(
              'ui.session-workspace.push-n-commits-to',
              String(sync.ahead),
              sync.upstream,
            )}
            onClick={() => void ops.push(sync)}
          >
            <ArrowUpFromLine size={13} />
            {sync.ahead}
          </button>
        ) : null
      ) : sync.pushRemote ? (
        <button
          type="button"
          className={pane.syncBtn}
          disabled={busy}
          data-busy={ops.op === 'push' || undefined}
          data-testid="rail-git-publish"
          title={t('ui.session-workspace.publish-branch-to', sync.pushRemote)}
          aria-label={t('ui.session-workspace.publish-branch-to', sync.pushRemote)}
          onClick={() => void ops.push(sync)}
        >
          <ArrowUpFromLine size={13} />
          {t('ui.session-workspace.publish')}
        </button>
      ) : null}
    </span>
  );
};

/** 操作结果：成功一行字（提交可撤销），失败带 git 的原始输出 */
const NoticeLine: React.FC<{ ops: GitOps }> = ({ ops }) => {
  const n = ops.notice;
  if (!n) return null;
  return (
    <div
      className={pane.gitNotice}
      data-tone={n.tone}
      role={n.tone === 'error' ? 'alert' : 'status'}
      data-testid="git-notice"
    >
      <div className={pane.gitNoticeHead}>
        <span className={pane.gitNoticeText}>{n.text}</span>
        {n.undo ? (
          <button
            type="button"
            className={pane.link}
            disabled={ops.op !== null}
            data-testid="git-undo-commit"
            title={
              n.undo.kind === 'commit'
                ? t('ui.session-workspace.undo-this-commit-changes-go-back-to-staged')
                : t('ui.session-workspace.put-the-discarded-changes-back')
            }
            onClick={() => void ops.undo()}
          >
            <Undo2 size={12} />
            {n.undo.kind === 'commit'
              ? t('ui.session-workspace.undo-commit')
              : t('ui.session-workspace.undo-discard')}
          </button>
        ) : null}
        <button
          type="button"
          className={pane.link}
          aria-label={t('ui.mascot-theme.dismiss')}
          title={t('ui.mascot-theme.dismiss')}
          onClick={ops.dismiss}
        >
          ×
        </button>
      </div>
      {n.output ? (
        <Disclosure
          className={pane.gitOutput}
          summaryClassName={pane.gitOutputSummary}
          summary={t('ui.session-workspace.git-output')}
        >
          <pre data-testid="git-notice-output">{n.output}</pre>
        </Disclosure>
      ) : null}
    </div>
  );
};

/**
 * 底部提交区。stagedCount > 0 时只提交已暂存的；否则先暂存 paths（当前列表里的文件）再提交。
 * 「提交后推送」对「让助手提交」同样生效。
 */
export const GitCommitBox: React.FC<{
  ops: GitOps;
  sync: GitSyncStatus | null;
  /** 有可提交的改动（工作区干净时只显示结果提示） */
  hasChanges: boolean;
  stagedCount: number;
  paths: string[];
  onAskAssistant: (push: boolean) => void;
}> = ({ ops, sync, hasChanges, stagedCount, paths, onAskAssistant }) => {
  if (!hasChanges && !ops.notice) return null;
  const busy = ops.op !== null;
  const count = stagedCount > 0 ? stagedCount : paths.length;
  const canCommit = !busy && !!ops.message.trim() && count > 0;
  // 游离 HEAD 推不了：不给勾
  const canPush = !!sync?.branch && (!!sync.upstream || !!sync.pushRemote);
  const submit = () => {
    if (canCommit) void ops.commit(stagedCount > 0 ? undefined : paths, sync);
  };
  return (
    <div className={pane.commitBox} data-testid="rail-commit-box">
      <NoticeLine ops={ops} />
      {hasChanges ? (
        <>
          <textarea
            className={pane.commitInput}
            value={ops.message}
            rows={2}
            disabled={ops.op === 'commit' || ops.op === 'suggest'}
            placeholder={t(
              'ui.session-workspace.commit-message-hint-to-commit',
              isMac ? '⌘↩' : 'Ctrl+↩',
            )}
            aria-label={t('ui.session-workspace.commit-message')}
            data-testid="rail-commit-message"
            onChange={(e) => ops.setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className={pane.commitActions}>
            <button
              type="button"
              className={pane.syncBtn}
              disabled={busy || count === 0}
              data-busy={ops.op === 'suggest' || undefined}
              data-testid="rail-commit-suggest"
              title={t('ui.session-workspace.write-a-commit-message-with-the-helper-model')}
              aria-label={t('ui.session-workspace.write-a-commit-message-with-the-helper-model')}
              onClick={() => void ops.suggest(stagedCount > 0 ? undefined : paths)}
            >
              <Sparkles size={13} className={ops.op === 'suggest' ? pane.pulse : undefined} />
            </button>
            <label
              className={pane.commitCheck}
              title={t('ui.session-workspace.commit-then-git-push-never-force-push')}
            >
              <Checkbox
                checked={ops.pushAfter && canPush}
                disabled={!canPush || busy}
                data-testid="rail-commit-push-after"
                onChange={(e) => ops.setPushAfter(e.target.checked)}
              />
              {t('ui.session-workspace.push-after-commit')}
            </label>
            <span className={pane.commitSpacer} />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              data-testid="rail-ask-commit"
              title={t('ui.session-workspace.put-a-commit-request-in-the-composer-send')}
              onClick={() => onAskAssistant(ops.pushAfter && canPush)}
            >
              <Bot size={14} />
              {t('ui.session-workspace.ask-assistant-to-commit')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canCommit}
              data-testid="rail-commit"
              title={
                stagedCount > 0
                  ? t('ui.session-workspace.commits-only-the-n-staged-files', String(stagedCount))
                  : t('ui.session-workspace.stages-and-commits-the-n-listed-files', String(count))
              }
              onClick={submit}
            >
              {ops.op === 'commit'
                ? t('ui.session-workspace.running-commit-hooks')
                : t('ui.session-workspace.commit')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
};
