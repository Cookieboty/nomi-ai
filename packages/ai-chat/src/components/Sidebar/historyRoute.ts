/** 历史会话的来源信息（客户端、线路、账号）：侧栏历史行的标签与悬停提示 */
import { t } from '@nomi-ai/ui';

import type { HistoryClient, HistorySession } from '../../services/historyClient';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';

const CLIENT_LABELS: Record<HistoryClient, string> = {
  cli: 'CLI',
  desktop: 'Desktop',
  ide: 'IDE',
  exec: 'exec',
  nomi: ENDPOINT_FULL.nomi(),
};

/** 行内只标出非官方线路，官方会话不加标签，保持列表干净 */
export function routeTag(h: HistorySession): string | null {
  if (h.route === 'gateway') return t('ui.cli-monitor.third-party');
  if (h.route === 'custom') return h.provider || t('ui.cli-monitor.third-party');
  return null;
}

/** 行内只显示首字母（第三方供应商名的首字，Nomi 网关为 N），完整名称在行的悬停提示里 */
export function routeInitial(h: HistorySession): string {
  if (h.route === 'gateway') return 'N';
  const name = (h.provider ?? '').trim();
  return name ? [...name][0]!.toUpperCase() : '?';
}

/** 悬停提示里的来源信息：客户端、线路、账号 */
export function historyOrigin(h: HistorySession): string[] {
  const out: string[] = [];
  if (h.client) out.push(t('ui.cli-monitor.client', CLIENT_LABELS[h.client]));
  if (h.route === 'official') out.push(t('ui.cli-monitor.route-official'));
  else if (h.route === 'gateway') out.push(t('ui.cli-monitor.route-third-party-nomi-gateway'));
  else if (h.route === 'custom')
    out.push(t('ui.cli-monitor.route-other-third-party', h.provider || '?'));
  if (h.account) out.push(t('ui.cli-monitor.account', h.account));
  return out;
}
