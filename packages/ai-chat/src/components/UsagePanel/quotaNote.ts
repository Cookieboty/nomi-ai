/**
 * 额度刷新结果 → 给用户看的一句话（不含任何账号信息）。
 * 面板里的工具卡片与「按端」信息卡 / 详情抽屉共用。
 */
import { t } from '@nomi-ai/ui';

import type { UsageQuotaEntry, UsageToolRefresh } from '../../services/usageClient';

export type Note = { text: string; tone: 'ok' | 'dim' | 'err' };

export const ORIGIN_LABEL: Record<NonNullable<UsageQuotaEntry['origin']>, string> = {
  statusline: 'ui.usage-tools.source-claude-code-statusline-snapshot',
  'usage-cmd': 'ui.usage-tools.source-claude-usage-official-cli',
  'session-log': 'ui.usage-tools.source-codex-session-logs',
  'app-server': 'ui.usage-tools.source-codex-app-server-official-cli',
  'grok-acp': 'ui.usage-tools.source-grok-acp-billing-official-cli',
};

const TOOL_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
const TOOL_CLI: Record<string, string> = {
  claude: 'claude -p /usage',
  codex: 'codex app-server',
  grok: 'grok ACP billing',
};

export const toolName = (id: string): string => TOOL_NAME[id] ?? id;

export function refreshNote(id: string, r: UsageToolRefresh): Note | null {
  const name = toolName(id);
  const cli = TOOL_CLI[id] ?? id;
  switch (r.state) {
    case 'ok':
      return { tone: 'ok', text: t('ui.usage-tools.refreshed-by-the-official-cli', name, cli) };
    case 'fresh-local':
      return {
        tone: 'dim',
        text: t('ui.usage-tools.local-data-is-still-fresh-so-the-official', name),
      };
    case 'throttled':
      return {
        tone: 'dim',
        text: t('ui.usage-tools.just-refreshed-you-can-refresh-again-in-s', name, r.retryInSec),
      };
    case 'skipped':
      return r.reason === 'disabled'
        ? {
            tone: 'dim',
            text: t('ui.usage-tools.active-quota-refresh-is-off-so-only-data', name),
          }
        : null;
    case 'auth':
      return {
        tone: 'err',
        text: t('ui.usage-tools.not-signed-in-or-the-sign-in-has', name),
      };
    case 'transient': {
      if (r.reason === 'unsupported')
        return {
          tone: 'dim',
          text: t('ui.usage-tools.this-cli-version-can-t-report-quota-non', name),
        };
      if (r.reason === 'not-installed')
        return {
          tone: 'dim',
          text: t('ui.usage-tools.the-official-cli-was-not-found-so-it', name),
        };
      return {
        tone: 'dim',
        text: r.stale
          ? t(
              'ui.usage-tools.this-refresh-failed-timeout-temporarily-unavailable-showing-the',
              name,
            )
          : t('ui.usage-tools.this-refresh-failed-timeout-temporarily-unavailable-try-again', name),
      };
    }
  }
}

/** 登录方式徽标（只看官方登录状态，不读凭据） */
export function authLabel(e: UsageQuotaEntry): {
  text: string;
  tone: 'neutral' | 'success' | 'warning';
} {
  if (e.status === 'api' || e.auth === 'api')
    return { text: t('ui.foundation.api-key'), tone: 'warning' };
  if (e.auth === 'subscription')
    return { text: t('ui.usage-tools.account-sign-in'), tone: 'success' };
  // 旧快照可能没带 auth：有额度窗口时按账号登录展示
  if (e.status === 'ok') return { text: t('ui.usage-tools.account-sign-in'), tone: 'success' };
  return { text: t('ui.usage-tools.sign-in-method-unknown'), tone: 'neutral' };
}
