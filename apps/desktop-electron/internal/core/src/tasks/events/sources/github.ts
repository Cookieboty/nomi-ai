/**
 * `github` 事件源（§6.2、connections.md §3）：经连接只读轮询——issue / PR 的新动态（`since` 游标）、
 * CI（workflow runs，跑完的才算事件）。按任务授权里的连接与仓库收窄（githubRead 的后台授权检查）。
 * Go 版：apps/desktop-go/internal/core/tasks/events/github.go。
 */
import { t } from '../../../i18n';
import type { ConnectionGrant, Task } from '../../types';
import type { EventSource, SourceEvent } from '../types';

export interface GithubFilter {
  repo: string;
  /** issues：issue / PR 的新建、更新、评论；ci：CI 跑完 */
  watch: 'issues' | 'ci';
  /** watch=ci 时的分支 */
  branch?: string;
}

export type GithubReader = (
  p: {
    endpoint: 'issues' | 'workflow_runs';
    repo: string;
    since?: string;
    state?: 'all';
    branch?: string;
  },
  grant: ConnectionGrant[],
) => Promise<unknown>;

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9_./-]{1,200}$/;

const repoGranted = (task: Task, repo: string) =>
  task.grant.connections.some(
    (c) =>
      c.capabilities.includes('github.read') &&
      c.resources.some((r) => r.toLowerCase() === repo.toLowerCase()),
  );

export function createGithubSource(deps: { read: GithubReader; now?: () => number }): EventSource {
  const now = deps.now ?? Date.now;
  return {
    id: 'github',
    minIntervalMs: 5 * 60_000,
    validate(filter, task) {
      const f = filter as GithubFilter | null;
      if (!f || typeof f.repo !== 'string' || !REPO.test(f.repo)) return 'repo required';
      if (f.watch !== 'issues' && f.watch !== 'ci') return 'bad watch';
      if (f.branch !== undefined && !BRANCH.test(f.branch)) return 'bad branch';
      if (!repoGranted(task, f.repo)) return `repo not granted: ${f.repo}`;
      return null;
    },
    async poll(filter, cursor, ctx) {
      const f = filter as GithubFilter;
      const grant = ctx.task.grant.connections;
      const events: SourceEvent[] = [];
      if (f.watch === 'issues') {
        // 第一次拉：游标定在现在，之前的不算（hub 也会把这次当基线）
        if (!cursor) return { events: [], cursor: new Date(now()).toISOString(), baseline: true };
        const list = (await deps.read(
          { endpoint: 'issues', repo: f.repo, since: cursor, state: 'all' },
          grant,
        )) as {
          number: number;
          title: string;
          updated_at: string;
          html_url: string;
          state: string;
          pull_request?: unknown;
          user?: { login?: string };
          comments?: number;
        }[];
        let max = cursor;
        for (const it of Array.isArray(list) ? list : []) {
          if (it.updated_at > max) max = it.updated_at;
          const kind = it.pull_request ? 'PR' : 'issue';
          events.push({
            key: `github:${f.repo}#${it.number}:${it.updated_at}`,
            occurredAt: Date.parse(it.updated_at) || now(),
            summary: t('electron.common.task-event-github-item', f.repo, kind, it.number, it.title),
            payload: {
              repo: f.repo,
              kind,
              number: it.number,
              title: it.title,
              state: it.state,
              url: it.html_url,
              author: it.user?.login,
              comments: it.comments,
              updatedAt: it.updated_at,
            },
          });
        }
        return { events, cursor: max };
      }
      const r = (await deps.read(
        { endpoint: 'workflow_runs', repo: f.repo, ...(f.branch ? { branch: f.branch } : {}) },
        grant,
      )) as {
        workflow_runs?: {
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          head_branch: string;
          html_url: string;
          updated_at: string;
        }[];
      };
      for (const run of r?.workflow_runs ?? []) {
        if (run.status !== 'completed') continue;
        events.push({
          key: `github:${f.repo}:run:${run.id}:${run.conclusion ?? ''}`,
          occurredAt: Date.parse(run.updated_at) || now(),
          summary: t(
            'electron.common.task-event-github-run',
            f.repo,
            run.name,
            run.head_branch,
            run.conclusion ?? '',
          ),
          payload: {
            repo: f.repo,
            workflow: run.name,
            branch: run.head_branch,
            conclusion: run.conclusion,
            url: run.html_url,
          },
        });
      }
      return { events, cursor: cursor ?? 'primed' };
    },
  };
}
