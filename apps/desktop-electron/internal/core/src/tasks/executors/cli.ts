/**
 * `cli` 执行者：用户在 Nomi 里装好、配好的编程助手在后台标签里执行任务（docs/design/persistent-tasks.md §7.2、§7.3）。
 *
 * - 隔离：git 仓库里每个任务一个 worktree（复用委派的 prepareIsolation）；续跑 / 退回时复用上一次的标签与 worktree；
 * - 权限：授权等级换算成标签的权限档（L1 计划档只读；L2 及以上在 worktree 里改文件），不给「完全放开」；
 * - 审批：标签里的审批请求先过确定性命令分类与授权等级——授权外的直接拒绝，其余要人的让任务停到「等你批准」，
 *   回答经 resume 回到标签（replyPermission）；任务标签的审批等待 7 天；
 * - 接管：用户在标签里自己发消息 → takenOver；
 * - 结束：解析 [nomi-report]，按 git 算改动的文件；**不自动回填**——worktree 留到用户验收，回填是验收卡片上的单独动作。
 *
 * Go 版：apps/desktop-go/internal/core/tasks/executor_cli.go。
 */
import { classifyCommand } from '../../desktop/commandClass';
import type { AttemptContext, TaskExecutor } from '../TaskRuntime';
import type { Task } from '../types';

import { classifyError } from './nomi';

export interface CliTabEvent {
  tabId: string;
  event: { type: string; id?: string; summary?: string; kind?: string };
}

export interface CliHarness {
  bins(): Record<string, string | null | undefined>;
  createTab(opts: {
    backend: string;
    cwd: string;
    title: string;
    activate: false;
    permissionMode: 'plan' | 'acceptEdits';
    delegation: { goal: string; taskId: string };
    modelOverride?: string;
  }): { id: string };
  hasTab(id: string): boolean;
  sendTab(id: string, prompt: string): Promise<{ text: string; usage?: Record<string, unknown> }>;
  cancelTab(id: string): boolean;
  replyPermission(tabId: string, requestId: string, allow: boolean): boolean;
  takenOver(id: string): boolean;
  onEvent(fn: (e: CliTabEvent) => void): () => void;
  /** HarnessStoppedError（标签被停 / 接管） */
  isStopped(err: unknown): boolean;
}

export interface CliIsolation {
  kind: 'worktree' | 'shared-cwd';
  cwd: string;
  sourceCwd: string;
  gitRoot?: string;
  worktreePath?: string;
}

export interface CliExecutorDeps {
  harness: CliHarness;
  prepareIsolation(sourceCwd: string, key: string): Promise<CliIsolation>;
  gitChanged(cwd: string): Promise<string[] | null>;
  buildPrompt(b: { goal: string; context?: string; doneWhen: string }): string;
  parseReport(
    text: string,
  ): { done: string; changedFiles: string[]; unfinished?: string; needsUser?: string } | null;
  /** 目录还存在、仍在授权范围里 */
  dirOk(dir: string): boolean;
}

interface Run {
  gen: number;
  tabId: string;
  ctx: AttemptContext;
  /** 等人的审批：requestId → 已转给任务收件箱 */
  pending: Set<string>;
  off: () => void;
  stopped: boolean;
}

/** 审批摘要里的命令：整行与「标题: 」后面的部分都分类，取更严重的 */
export function classifySummary(summary: string): ReturnType<typeof classifyCommand> {
  const after = summary.includes(':') ? summary.slice(summary.indexOf(':') + 1) : '';
  const a = classifyCommand(summary);
  const b = after ? classifyCommand(after) : null;
  const rank = { external: 1, never: 2, credential: 3 } as const;
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * 标签里来了一个审批请求，后台怎么办（§8.4）：allow 直接放行；ask 停下来等人；deny 授权外，直接拒绝。
 * 计划审批一律问人；读凭据 / 合并发布永远问人；对外动作要 L4；跑命令要 L3（事件触发的任务读过外部内容，问人）。
 */
export function decidePermission(
  task: Task,
  ev: { summary?: string; kind?: string },
  tainted: boolean,
): 'allow' | 'ask' | 'deny' {
  if (ev.kind === 'approve-plan') return 'ask';
  const cls = classifySummary(ev.summary ?? '');
  if (cls === 'credential' || cls === 'never') return 'ask';
  if (cls === 'external') return task.grant.level >= 4 ? 'allow' : 'ask';
  if (task.grant.level < 3) return 'deny';
  return tainted ? 'ask' : 'allow';
}

export function createCliExecutor(d: CliExecutorDeps): TaskExecutor {
  const runs = new Map<string, Run>();

  const promptFor = (ctx: AttemptContext, reused: boolean): string => {
    const { task, attempt } = ctx;
    const c = attempt.cause;
    if (reused) {
      if (c.kind === 'rework')
        return `用户退回了上次的结果，意见：${c.note ?? ''}\n请按意见修改，完成后照原格式汇报。`;
      if (c.answer)
        return `用户对你上次停下来请求的回答：${c.answer.approve ? '同意' : '不同意'}${c.answer.input ? `，并补充：${c.answer.input}` : ''}。请继续，完成后照原格式汇报。`;
      return '上次执行被中断了（应用重启或出错）。先检查工作目录与 git 状态，确认哪些已经做过，不要重复对外动作；然后接着完成任务，照原格式汇报。';
    }
    return d.buildPrompt({
      goal: task.goal,
      doneWhen: '目标里写的结果达成；做不到时说明原因',
      context: task.title,
    });
  };

  return {
    prepare(task) {
      if (task.executor.kind !== 'cli')
        return { error: { code: 'executor_failed', message: 'not a cli task' } };
      const ex = task.executor;
      // 用户点名的编程助手不可用：失败并提示，不悄悄换成别的（§7.3）
      if (!d.harness.bins()[ex.cli])
        return { error: { code: 'config_changed', message: `${ex.cli} is not installed` } };
      if (!d.dirOk(ex.cwd))
        return { error: { code: 'config_changed', message: `workspace unavailable: ${ex.cwd}` } };
      return {
        grantVersion: task.grant.version,
        cli: ex.cli,
        cwd: ex.cwd,
        ...(ex.model ? { model: ex.model } : {}),
      };
    },

    start(ctx) {
      void (async () => {
        const { task, attempt, report, previous } = ctx;
        if (task.executor.kind !== 'cli') return;
        const ex = task.executor;
        let tabId = previous?.carrier?.tabId;
        let isolation: CliIsolation | null = null;
        const reused =
          !!tabId &&
          d.harness.hasTab(tabId) &&
          !d.harness.takenOver(tabId) &&
          attempt.cause.kind !== 'manual' &&
          attempt.cause.kind !== 'schedule' &&
          attempt.cause.kind !== 'event';
        try {
          if (!reused) {
            isolation =
              ex.isolation === 'worktree'
                ? await d.prepareIsolation(ex.cwd, `task-${attempt.id}`)
                : { kind: 'shared-cwd', cwd: ex.cwd, sourceCwd: ex.cwd };
            tabId = d.harness.createTab({
              backend: ex.cli,
              cwd: isolation.cwd,
              title: `${task.title}`.slice(0, 60),
              activate: false,
              permissionMode: task.grant.level >= 2 ? 'acceptEdits' : 'plan',
              delegation: { goal: task.goal.slice(0, 200), taskId: task.id },
              ...(ex.model ? { modelOverride: ex.model } : {}),
            }).id;
            report.carrier({
              tabId,
              cwd: isolation.cwd,
              sourceCwd: isolation.sourceCwd,
              ...(isolation.worktreePath ? { worktree: isolation.worktreePath } : {}),
              ...(isolation.gitRoot ? { gitRoot: isolation.gitRoot } : {}),
            });
          } else {
            report.carrier({ ...previous!.carrier });
          }
        } catch (e) {
          report.failed({
            code: 'prepare_failed',
            message: e instanceof Error ? e.message : String(e),
          });
          return;
        }
        const id = tabId!;
        const tainted = attempt.cause.kind === 'event';
        const run: Run = {
          gen: attempt.gen,
          tabId: id,
          ctx,
          pending: new Set(),
          off: () => undefined,
          stopped: false,
        };
        runs.set(task.id, run);
        run.off = d.harness.onEvent((e) => {
          if (e.tabId !== id) return;
          report.heartbeat();
          if (e.event.type !== 'permission' || !e.event.id) return;
          const verdict = decidePermission(task, e.event, tainted);
          if (verdict === 'allow') d.harness.replyPermission(id, e.event.id, true);
          else if (verdict === 'deny') d.harness.replyPermission(id, e.event.id, false);
          else {
            run.pending.add(e.event.id);
            report.needsUser({
              kind: 'approval',
              requestId: e.event.id,
              detail: (e.event.summary ?? '').slice(0, 800),
            });
          }
        });
        try {
          const before = reused ? null : await d.gitChanged(isolation!.cwd);
          const r = await d.harness.sendTab(id, promptFor(ctx, reused));
          run.off();
          runs.delete(task.id);
          const u = (r.usage ?? {}) as {
            inputTokens?: number;
            outputTokens?: number;
            costUsd?: number;
          };
          report.usage({
            ...(u.inputTokens ? { inputTokens: u.inputTokens } : {}),
            ...(u.outputTokens ? { outputTokens: u.outputTokens } : {}),
            ...(typeof u.costUsd === 'number' ? { costUsd: u.costUsd } : { costKnown: false }),
          });
          const parsed = d.parseReport(r.text);
          const workCwd = isolation?.cwd ?? previous?.carrier?.cwd ?? ex.cwd;
          const after = await d.gitChanged(workCwd);
          const changed = after
            ? after.filter((f) => !(before ?? []).includes(f) || parsed?.changedFiles.includes(f))
            : (parsed?.changedFiles ?? []);
          const summary = [
            parsed?.done ?? r.text.trim().slice(-2000),
            parsed?.unfinished ? `没做完的：${parsed.unfinished}` : '',
            parsed?.needsUser ? `需要你决定的：${parsed.needsUser}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          report.completed({
            summary: summary || '(no report)',
            artifacts: changed.map((f) => ({ kind: 'file', ref: f })),
          });
        } catch (err) {
          run.off();
          runs.delete(task.id);
          if (d.harness.isStopped(err)) {
            // 用户在标签里接手：交给用户；我们自己停的（取消 / 撤销 / 超时）不再回报
            if (!run.stopped && d.harness.takenOver(id)) report.takenOver();
            return;
          }
          report.failed(classifyError(err instanceof Error ? err.message : String(err)));
        }
      })();
    },

    resume(taskId, gen, answer) {
      const run = runs.get(taskId);
      if (!run || run.gen !== gen || !answer.requestId) return;
      if (run.pending.delete(answer.requestId)) {
        // 标签里的审批还在等（7 天内）：直接回答；已经超时的，回答由 resume 新开一轮带过去
        if (!d.harness.replyPermission(run.tabId, answer.requestId, answer.approve))
          run.ctx.report.failed({ code: 'executor_crashed', message: 'permission_expired' });
      }
    },

    stop(taskId, gen) {
      const run = runs.get(taskId);
      if (!run || run.gen !== gen) return;
      run.stopped = true;
      d.harness.cancelTab(run.tabId);
    },
  };
}
