/**
 * 会话详情里的「任务」：从这个会话建的持续任务（origin.conversationId）。
 * 后台派给编程助手的（origin.via = delegate 且执行者是编程助手）已经在「智能体」里作为子任务列出，这里不重复；
 * 派给后台 Nomi 的（delegate_to_nomi，执行者是 Nomi）是任务，列在这里。
 * 排序：要你处理的、进行中的在前，其余按最近更新。
 */
import { groupOf, type Task, type TaskGroup } from '../../services/tasksClient';

const ORDER: Record<TaskGroup, number> = {
  needs_you: 0,
  running: 1,
  waiting_trigger: 2,
  ended: 3,
};

export function sessionTasks(tasks: readonly Task[], conversationId: string | undefined): Task[] {
  if (!conversationId) return [];
  return tasks
    .filter(
      (x) =>
        x.origin?.conversationId === conversationId &&
        !(x.origin.via === 'delegate' && x.executor?.kind === 'cli'),
    )
    .sort((a, b) => ORDER[groupOf(a)] - ORDER[groupOf(b)] || b.updatedAt - a.updatedAt);
}

/** 进行中（含要你处理的） */
export function countActiveTasks(tasks: readonly Task[]): number {
  return tasks.filter((x) => {
    const g = groupOf(x);
    return g === 'running' || g === 'needs_you';
  }).length;
}
