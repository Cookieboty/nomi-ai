/**
 * 旧的提醒 / 定时代理任务并入任务页（只读适配器，docs/design/persistent-tasks.md §13 的 2.1.0 调整）。
 * 数据迁移推迟；这里只把它们映射成任务页能列出的条目，点开仍进各自原有的编辑界面。
 * Go 版：apps/desktop-go/internal/core/tasks/legacy.go。
 */
import type { Repeat } from '../schedule/recurrence';

export interface LegacyTaskItem {
  source: 'reminder' | 'schedule';
  id: string;
  title: string;
  enabled: boolean;
  nextRunAt?: number;
  repeat?: Repeat;
  lastStatus?: string;
}

export interface LegacyReminder {
  id: string;
  text: string;
  dueAt: number;
  status: string;
  repeat?: Repeat;
}

export interface LegacySchedTask {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAt: number;
  repeat: Repeat;
  lastStatus?: string;
}

/** 提醒在前（按到期时间），定时任务在后（按下次运行时间） */
export function legacyItems(
  reminders: LegacyReminder[],
  sched: LegacySchedTask[],
): LegacyTaskItem[] {
  const r: LegacyTaskItem[] = reminders
    .filter((x) => x.status === 'pending')
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((x) => ({
      source: 'reminder' as const,
      id: x.id,
      title: x.text,
      enabled: true,
      nextRunAt: x.dueAt,
      ...(x.repeat ? { repeat: x.repeat } : {}),
    }));
  const s: LegacyTaskItem[] = [...sched]
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .map((x) => ({
      source: 'schedule' as const,
      id: x.id,
      title: x.name,
      enabled: x.enabled,
      nextRunAt: x.nextRunAt,
      repeat: x.repeat,
      ...(x.lastStatus ? { lastStatus: x.lastStatus } : {}),
    }));
  return [...r, ...s];
}
