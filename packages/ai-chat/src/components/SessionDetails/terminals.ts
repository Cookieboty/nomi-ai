/**
 * 会话详情里的「终端」区块数据源（纯函数，便于单测）。
 * 从当前会话的工作区页中收集全部终端标签（运行中、已退出与启动失败均保留展示），
 * 并结合 sideTerminal 实时状态映射出展示名称、分屏副标题与聚合状态。
 */
import { t } from '@nomi-ai/ui';

import { sideTerminalIdFor, type SideTerminalStatus } from '../../services/sideTerminal';
import { basename } from '../../utils/resourceLinks';
import { pageKey, terminalPaneIds, type WorkspacePage } from '../../utils/sideTabs';

export type SessionTerminalStatus = 'running' | 'exited' | 'error';

export interface SessionTerminalItem {
  id: string;
  tabKey: string;
  name: string;
  detail?: string;
  cwd?: string;
  paneCount: number;
  status: SessionTerminalStatus;
  termIds: string[];
}

function aggregateTerminalStatus(
  termIds: readonly string[],
  getStatus: (id: string) => SideTerminalStatus | undefined,
): SessionTerminalStatus {
  const statuses = termIds.map(getStatus);
  if (statuses.some((s) => s === 'running' || s === undefined)) return 'running';
  if (statuses.some((s) => s === 'error')) return 'error';
  return 'exited';
}

export function collectSessionTerminals(
  pages: readonly WorkspacePage[],
  getStatus: (id: string) => SideTerminalStatus | undefined,
): SessionTerminalItem[] {
  const items: SessionTerminalItem[] = [];
  for (const p of pages) {
    if (p.kind !== 'terminal') continue;
    const paneIds = terminalPaneIds(p);
    const termIds = paneIds.map(sideTerminalIdFor);
    const paneCount = paneIds.length;
    const status = aggregateTerminalStatus(termIds, getStatus);
    const name =
      p.title ||
      (p.cwd ? basename(p.cwd) || p.cwd : '') ||
      p.shell ||
      t('ui.cli-monitor.fleet-origin-terminal');
    const detail =
      paneCount > 1
        ? p.cwd
          ? `${t('ui.session-workspace.details-terminal-panes', String(paneCount))} · ${p.cwd}`
          : t('ui.session-workspace.details-terminal-panes', String(paneCount))
        : p.cwd || p.shell || undefined;
    items.push({
      id: p.id,
      tabKey: pageKey(p),
      name,
      ...(detail ? { detail } : {}),
      ...(p.cwd ? { cwd: p.cwd } : {}),
      paneCount,
      status,
      termIds,
    });
  }
  return items;
}

export function countRunningSessionTerminals(items: readonly SessionTerminalItem[]): number {
  return items.filter((item) => item.status === 'running').length;
}
