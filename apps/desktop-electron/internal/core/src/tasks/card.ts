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
  | { kind: 'interval'; minutes: number }
  | {
      kind: 'event';
      source: 'web' | 'github' | 'folder' | 'app' | 'mcp';
      url?: string;
      repo?: string;
      path?: string;
      app_event?: string;
      mcp_server?: string;
      mcp_tool?: string;
    };

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
    case 'event':
      return t(
        'electron.common.task-when-event',
        w.url ??
          w.repo ??
          w.path ??
          w.app_event ??
          (w.mcp_server ? `${w.mcp_server}/${w.mcp_tool ?? ''}` : w.source),
      );
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
  github?: { label: string; repos: string[]; actions?: ('comment' | 'pr')[] };
  mcp?: { server: string; tools: string[]; external: boolean }[];
  cli?: { name: string; cwd: string };
}): { summary: string; preview: string } {
  return {
    summary: t('electron.common.task-card-summary', i.title),
    preview: [
      t('electron.common.task-card-task', i.title),
      t('electron.common.task-card-goal', short(i.goal, 600)),
      t('electron.common.task-card-when', describeWhen(i.when)),
      t(
        'electron.common.task-card-who',
        i.cli
          ? t('electron.common.task-who-cli', i.cli.name, i.cli.cwd)
          : i.notify
            ? t('electron.common.task-who-notify')
            : t('electron.common.task-who-nomi'),
      ),
      t('electron.common.task-card-level', LEVEL[i.level]()),
      ...(i.github
        ? [t('electron.common.task-card-github', i.github.label, i.github.repos.join(', '))]
        : []),
      ...(i.github?.actions?.length
        ? [
            t(
              'electron.common.task-card-github-actions',
              i.github.actions
                .map((a) =>
                  a === 'comment'
                    ? t('electron.common.task-action-comment')
                    : t('electron.common.task-action-pr'),
                )
                .join('、'),
            ),
          ]
        : []),
      ...(i.mcp ?? []).map((m) =>
        t(
          m.external ? 'electron.common.task-card-mcp-external' : 'electron.common.task-card-mcp',
          m.server,
          m.tools.join(', '),
        ),
      ),
      t('electron.common.task-card-terms'),
    ].join('\n'),
  };
}

/** 配置变了、要用户处理时的说明（任务停到「等你处理」，§8.7） */
export const configText = {
  cliUnavailable: (cli: string) => t('electron.common.task-config-cli-unavailable', cli),
  workspaceUnavailable: (cwd: string) =>
    t('electron.common.task-config-workspace-unavailable', cwd),
  noModel: () => t('electron.common.task-config-no-model'),
  modelUnsupported: (model: string) => t('electron.common.task-config-model-unsupported', model),
};
