/**
 * Agent 看板（docs/development/agent-board.md）：契约 fleet.* 的视图侧封装。
 * 数据类型直接取契约的结果类型；资源占用由视图按需拉取（内核只在标签 / 任务变化时推 fleet.changed）。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-catalog';

import type { ConversationBackend } from '../types/chat';

import { api, hasTransport } from './api';

export type FleetState = Awaited<ReturnType<typeof api.fleet.state>>;
export type FleetAgent = FleetState['agents'][number];
export type FleetColumn = FleetAgent['column'];

export const fleetAvailable = () => hasTransport();

export const fleetApi = {
  state: () => api.fleet.state(),
  archive: (id: string) => api.fleet.archive({ id }),
  onChange: (fn: (s: FleetState) => void) => api.on('fleet.changed', fn),
};

/** 看板分列的顺序与标题 */
export const FLEET_COLUMNS: { key: FleetColumn; label: string }[] = [
  { key: 'todo', label: 'ui.cli-monitor.fleet-col-todo' },
  { key: 'running', label: 'ui.chat-settings.in-progress' },
  { key: 'paused', label: 'ui.providers-schedule.task-paused' },
  { key: 'done', label: 'ui.foundation.done' },
];

export const ORIGIN_LABEL: Record<FleetAgent['origin'], string> = {
  self: 'ui.cli-monitor.fleet-origin-self',
  nomi: 'ui.cli-monitor.fleet-origin-nomi',
  conversation: 'ui.cli-monitor.fleet-origin-conversation',
  task: 'ui.cli-monitor.fleet-origin-task',
  workbench: 'ui.cli-monitor.fleet-origin-workbench',
  terminal: 'ui.cli-monitor.fleet-origin-terminal',
};

export const NEEDS_YOU_LABEL: Record<NonNullable<FleetAgent['needsYou']>, string> = {
  permission: 'ui.cli-monitor.fleet-needs-permission',
  sandbox: 'ui.cli-monitor.fleet-needs-sandbox',
  accept: 'ui.providers-schedule.task-awaiting-accept',
};

/** 端点图标用的后端：内核报来的插件 / 未知后端按「外部插件」画 */
export function iconBackend(a: FleetAgent): ConversationBackend {
  if (a.backend === 'nomi') return 'nomi';
  return isBuiltinCliId(a.backend) ? a.backend : 'external';
}

/** 1536 MB → 「1.5 GB」；不到 1 MB 写「< 1 MB」 */
export function formatBytes(n: number): string {
  const mb = n / (1024 * 1024);
  if (mb < 1) return '< 1 MB';
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(mb < 10 * 1024 ? 1 : 0)} GB`;
}

/** CPU 占用：100 = 一个核 */
export function formatCpu(p: number): string {
  if (p < 1) return p > 0 ? '< 1%' : '0%';
  return `${Math.round(p)}%`;
}

export type LoadLevel = 'normal' | 'warn' | 'critical';

/** 看板的统计：纳管 / 外部的内存，正在跑的、要你处理的数量，负载等级 */
export interface FleetSummary {
  managedBytes: number;
  externalBytes: number;
  running: number;
  needsYou: number;
  level: LoadLevel;
}

/**
 * 负载等级（P1 的近似：内核还没报系统内存压力）：编程助手与 Nomi 占物理内存的比例、整机 CPU 占核数的比例，
 * 取大的那个；≥ 50% 告警，≥ 75% 危险。
 */
export const LOAD_WARN = 0.5;
export const LOAD_CRITICAL = 0.75;

export function summarize(s: FleetState | null): FleetSummary {
  const out: FleetSummary = {
    managedBytes: 0,
    externalBytes: 0,
    running: 0,
    needsYou: 0,
    level: 'normal',
  };
  if (!s) return out;
  for (const a of s.agents) {
    const bytes = a.usage?.rssBytes ?? 0;
    if (a.scope === 'external') out.externalBytes += bytes;
    else out.managedBytes += bytes;
    if (a.scope === 'managed' && a.origin !== 'self' && a.column === 'running') out.running += 1;
    if (a.needsYou) out.needsYou += 1;
  }
  const mem = s.system.totalMemBytes
    ? (out.managedBytes + out.externalBytes) / s.system.totalMemBytes
    : 0;
  const cpu = s.system.cores ? s.system.cpuPercent / (s.system.cores * 100) : 0;
  const share = Math.max(mem, cpu);
  out.level = share >= LOAD_CRITICAL ? 'critical' : share >= LOAD_WARN ? 'warn' : 'normal';
  return out;
}
