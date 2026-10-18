/**
 * 额度刷新结果 → 给用户看的一句话（不含任何账号信息）。
 * 面板里的工具卡片与「按端」信息卡 / 详情抽屉共用。
 */
import { t } from '@nomi-ai/ui';

import type { UsageQuotaEntry, UsageToolRefresh } from '../../services/usageClient';

export type Note = { text: string; tone: 'ok' | 'dim' | 'err' };

export const ORIGIN_LABEL: Record<NonNullable<UsageQuotaEntry['origin']>, string> = {
  statusline: '来源：Claude Code 状态栏快照',
  'usage-cmd': '来源：claude /usage（官方 CLI）',
  'session-log': '来源：Codex 会话日志',
  'app-server': '来源：codex app-server（官方 CLI）',
  'grok-acp': '来源：Grok ACP billing（官方 CLI）',
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
      return { tone: 'ok', text: t('{0}：已让官方 CLI（{1}）刷新。', name, cli) };
    case 'fresh-local':
      return { tone: 'dim', text: t('{0}：本机数据还很新，没有拉起官方 CLI。', name) };
    case 'throttled':
      return {
        tone: 'dim',
        text: t('{0}：刚刷新过，{1} 秒后可再次刷新。', name, r.retryInSec),
      };
    case 'skipped':
      return r.reason === 'disabled'
        ? {
            tone: 'dim',
            text: t('{0}：已关闭「主动刷新额度」，只重读了本机已有的数据。', name),
          }
        : null;
    case 'auth':
      return {
        tone: 'err',
        text: t('{0}：没有登录或登录已失效，已清除旧额度。请在终端里重新登录该工具。', name),
      };
    case 'transient': {
      if (r.reason === 'unsupported')
        return {
          tone: 'dim',
          text: t('{0}：当前版本的 CLI 不支持非交互读取额度，已保留其他来源的数据。', name),
        };
      if (r.reason === 'not-installed')
        return { tone: 'dim', text: t('{0}：没有找到官方 CLI，无法主动刷新。', name) };
      return {
        tone: 'dim',
        text: r.stale
          ? t('{0}：这次刷新没成功（超时 / 暂时不可用），显示的是上次读到的值。', name)
          : t('{0}：这次刷新没成功（超时 / 暂时不可用），稍后再试。', name),
      };
    }
  }
}

/** 登录方式徽标（只看官方登录状态，不读凭据） */
export function authLabel(e: UsageQuotaEntry): {
  text: string;
  tone: 'neutral' | 'success' | 'warning';
} {
  if (e.status === 'api' || e.auth === 'api') return { text: t('API 密钥'), tone: 'warning' };
  if (e.auth === 'subscription') return { text: t('账号登录'), tone: 'success' };
  // 旧快照可能没带 auth：有额度窗口时按账号登录展示
  if (e.status === 'ok') return { text: t('账号登录'), tone: 'success' };
  return { text: t('未确认登录方式'), tone: 'neutral' };
}
