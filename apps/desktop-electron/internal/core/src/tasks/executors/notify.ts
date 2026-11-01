/**
 * `notify` 执行者：到点发一条通知（docs/design/persistent-tasks.md §7）。
 * 渠道由 DesktopService.notify 决定（桌面角色气泡 → 灵动岛 → 系统通知，免打扰中不弹系统通知）；
 * 通知本身就是结果，所以投递时不再为它另发「有结果」。
 */
import type { TaskExecutor } from '../TaskRuntime';

export interface NotifyPort {
  notify(n: { kind: 'reminder'; title: string; text: string; body?: string }): unknown;
}

export function createNotifyExecutor(port: NotifyPort): TaskExecutor {
  return {
    prepare: (task) => ({ grantVersion: task.grant.version }),
    start({ task, report }) {
      const text = task.executor.kind === 'notify' ? task.executor.text : task.goal;
      try {
        port.notify({ kind: 'reminder', title: task.title, text, body: text });
        report.completed({ summary: text, artifacts: [] });
      } catch (error) {
        report.failed({ code: 'executor_failed', message: String(error) });
      }
    },
    resume: () => undefined,
    stop: () => undefined,
  };
}
