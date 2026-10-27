import { t } from '@nomi-ai/ui';

import { ENDPOINT_NAME } from './endpointBadge';

/** CLI 标签的输入框提示：随运行状态与后端变化（不显示 Nomi 的「请先选择AI模型」） */
export function cliTabPlaceholder(tab: { title: string; backend: string; status: string }): string {
  const label = (ENDPOINT_NAME as Record<string, string>)[tab.backend] ?? tab.backend;
  if (tab.status === 'running')
    return t('ui.cli-monitor.is-working-you-can-send-again-when-it', label);
  if (tab.status === 'queued')
    return t('ui.cli-monitor.is-queued-waiting-for-other-tabs-to-finish', label);
  if (tab.title && tab.title !== label) return t('ui.cli-monitor.message', tab.title, label);
  return t('ui.mascot-theme.message', label);
}
