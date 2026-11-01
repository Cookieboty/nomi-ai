/**
 * 授权卡片的文案（task_propose 弹给用户确认，§12）：给用户看，跟界面语言走（electron 词典）。
 */
import { t } from '../i18n';

import type { GrantLevel } from './types';

export type ProposeWhen =
  | { kind: 'manual' }
  | { kind: 'once'; at: string }
  | { kind: 'daily' | 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; minutes: number };

export function describeWhen(w: ProposeWhen): string {
  switch (w.kind) {
    case 'manual':
      return t('electron.common.task-when-manual');
    case 'once':
      return t('electron.common.task-when-once', w.at);
    case 'daily':
      return t('electron.common.task-when-daily', w.time);
    case 'weekdays':
      return t('electron.common.task-when-weekdays', w.time);
    case 'weekly':
      return t('electron.common.task-when-weekly', w.days.join(', '), w.time);
    case 'interval':
      return t('electron.common.task-when-interval', w.minutes);
  }
}

const LEVEL: Record<GrantLevel, () => string> = {
  0: () => t('electron.common.task-level-0'),
  1: () => t('electron.common.task-level-1'),
  2: () => t('electron.common.task-level-2'),
  3: () => t('electron.common.task-level-3'),
  4: () => t('electron.common.task-level-4'),
};

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function authorizationCard(i: {
  title: string;
  goal: string;
  when: ProposeWhen;
  notify: boolean;
  level: GrantLevel;
}): { summary: string; preview: string } {
  return {
    summary: t('electron.common.task-card-summary', i.title),
    preview: [
      t('electron.common.task-card-task', i.title),
      t('electron.common.task-card-goal', short(i.goal, 600)),
      t('electron.common.task-card-when', describeWhen(i.when)),
      t(
        'electron.common.task-card-who',
        i.notify ? t('electron.common.task-who-notify') : t('electron.common.task-who-nomi'),
      ),
      t('electron.common.task-card-level', LEVEL[i.level]()),
      t('electron.common.task-card-terms'),
    ].join('\n'),
  };
}
