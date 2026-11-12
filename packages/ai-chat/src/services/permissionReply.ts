/**
 * 回一条权限请求（卡片上的「允许 / 拒绝」最终都走这里）。
 *
 * 后台委派是持续任务，审批本该经任务回应（tasks.decide）——任务收件箱和内核的等待状态才对得上。
 * 但任务已经结束 / 被接管 / 这条请求已不在它的等待里时，内核会拒绝（ok:false 或直接抛错），
 * 而请求在编程助手那边仍然挂着：只看任务这一条路，就会出现「按钮点了完全没反应」，
 * 要等超时（普通标签 2 分钟、委派 10 分钟、任务标签最长 7 天）才消失。
 *
 * 任务回应失败时退回直接回标签；明确返回 false 才表示请求失效，通信异常继续抛出以便重试。
 */
import { api } from './api';
import { harnessClient } from './harnessClient';

export interface PermissionReplyDeps {
  /** 任务回应（后台委派）；任务不在了返回 ok:false 或抛错 */
  decide?: (a: { id: string; requestId: string; approve: boolean }) => Promise<unknown>;
  /** 直接回标签（所有标签都支持的兜底） */
  reply: (tabId: string, requestId: string, allow: boolean) => Promise<boolean | undefined>;
  /** 计划批准卡（只走标签） */
  replyApprovePlan?: (
    tabId: string,
    requestId: string,
    choice: 'acceptEdits' | 'manual' | 'deny',
  ) => Promise<boolean | undefined>;
}

const defaultDeps = (): PermissionReplyDeps => ({
  decide: (a) => api.tasks.decide(a),
  reply: (tabId, requestId, allow) => harnessClient.replyPermission(tabId, requestId, allow),
  replyApprovePlan: (tabId, requestId, choice) =>
    harnessClient.replyApprovePlan(tabId, requestId, choice),
});

/**
 * 任务回应成功了没有。外层可能是 TaskCmdResult 本身，也可能是 { ok, data } 包装（契约层两种都有），
 * 所以往里看一层：只有明确拿到 ok:false 才算没成功（任务已结束 / 请求已失效）。
 */
function decideOk(r: unknown): boolean {
  const pick = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return true;
    const o = v as { ok?: unknown; data?: unknown };
    if (o.ok === false) return false;
    if (o.data && typeof o.data === 'object') return pick(o.data);
    return true;
  };
  return pick(r);
}

export interface PermissionReplyOptions {
  /** 计划批准的选择（批准并自动改文件 / 批准并逐项确认 / 拒绝） */
  approvePlan?: 'acceptEdits' | 'manual' | 'deny';
  /** 这个标签所属的持续任务：给了就先经任务回应 */
  taskId?: string;
}

/** true = 已送达；false = 内核明确拒绝失效请求；发送异常继续抛出，保留重试入口。 */
export async function replyPermissionRequest(
  tabId: string,
  requestId: string,
  allow: boolean,
  opts: PermissionReplyOptions = {},
  deps: PermissionReplyDeps = defaultDeps(),
): Promise<boolean> {
  // 计划批准卡的内核路径只在标签上（任务回应不带 approvePlan）
  if (opts.taskId && !opts.approvePlan && deps.decide) {
    try {
      if (decideOk(await deps.decide({ id: opts.taskId, requestId, approve: allow }))) return true;
    } catch {
      /* 任务已经不在了 / 被接管：退回标签，别让按钮变成死键 */
    }
  }
  const r = opts.approvePlan
    ? await deps.replyApprovePlan?.(tabId, requestId, opts.approvePlan)
    : await deps.reply(tabId, requestId, allow);
  return r !== false;
}
