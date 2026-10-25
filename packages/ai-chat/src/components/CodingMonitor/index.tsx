/**
 * 「监视与会话」：进度监视（开关 / 系统通知 / 语音播报）、监视哪些助手（检测 / 立即扫描）
 * + 活跃会话列表（按端点筛选；Nomi 标签可直接打开）。
 * 只读本地日志与进程列表，不登录、不抓取任何账号。通知样式与灵动岛在「通知 / 灵动岛」里设置。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-plugins';
import {
  Badge,
  Button,
  createLogger,
  EmptyState,
  Notice,
  SettingRow,
  SettingsGroup,
  Switch,
  t as tr,
} from '@nomi-ai/ui';
import { SquareTerminal } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  AGENT_LABEL,
  STATUS_LABEL,
  agentsClient,
  endpointCounts,
  filterSessions,
  type AgentKind,
  type AgentWatchState,
  type EndpointFilter,
} from '../../services/agentsClient';
import { harnessClient } from '../../services/harnessClient';
import { usageClient } from '../../services/usageClient';
import { EndpointIcon } from '../EndpointIcon';
import { sessionUsageText } from '../UsagePanel/format';
import { useUsageFx } from '../UsagePanel/useFx';

import styles from './index.module.css';

const log = createLogger('coding-monitor');

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 日期 */
export function relTime(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return tr('ui.chat-settings.just-now');
  if (d < 3_600_000) return tr('ui.chat-settings.min-ago', Math.floor(d / 60_000));
  if (d < 86_400_000) return tr('ui.chat-settings.h-ago', Math.floor(d / 3_600_000));
  return new Date(ms).toLocaleString();
}

export const CodingMonitor: React.FC<{
  /** 打开 Nomi 标签后调用（设置页借此返回对话） */
  onOpenedTab?: () => void;
  /** 跳到「通知 / 灵动岛」设置 */
  onOpenNotify?: () => void;
}> = ({ onOpenedTab, onOpenNotify }) => {
  const [agents, setAgents] = useState<AgentWatchState | null>(null);
  const [agentFilter, setAgentFilter] = useState<EndpointFilter>('all');
  const fx = useUsageFx();
  // 「最后活动 N 分钟前」本地走时：主进程只在会话有变化时才广播，不能靠广播刷新相对时间
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const loadAgents = useCallback(() => {
    if (!agentsClient.available()) return;
    void agentsClient
      .state()
      .then(setAgents)
      .catch((e) => {
        // 主进程未就绪时不污染整页错误条
        log.warn(e instanceof Error ? e.message : String(e));
      });
  }, []);
  useEffect(() => {
    loadAgents();
    const offAgents = agentsClient.onChanged(() => loadAgents());
    // 用量变化（节流过的广播）时刷新，会话累计 Token / 费用才会跟着走
    const offUsage = usageClient.onChanged(() => loadAgents());
    return () => {
      offAgents();
      offUsage();
    };
  }, [loadAgents]);

  const setSettings = (p: Parameters<typeof agentsClient.setSettings>[0]) =>
    void agentsClient.setSettings(p).then(loadAgents);

  return (
    <div className={styles.stack} data-testid="coding-monitor">
      {!agentsClient.available() && (
        <Notice tone="warning">
          {tr('ui.providers-schedule.the-main-process-watcher-isn-t-reachable-in')}
        </Notice>
      )}
      {agents && (
        <>
          <SettingsGroup
            title={tr('ui.providers-schedule.progress-monitoring')}
            description={tr(
              'ui.providers-schedule.only-sessions-whose-files-were-just-written-and',
            )}
          >
            <SettingRow
              title={tr('ui.providers-schedule.watch-coding-agent-progress')}
              description={tr('ui.providers-schedule.show-a-bubble-dynamic-island-notice-when-a')}
            >
              <Switch
                checked={agents.settings.enabled}
                onChange={(v) => setSettings({ enabled: v })}
                aria-label={tr('ui.providers-schedule.watch-coding-agent-progress')}
                data-testid="agents-enabled"
              />
            </SettingRow>
            <SettingRow
              title={tr('ui.cli-monitor.send-a-system-notification-when-a-task-finishes')}
            >
              <Switch
                checked={agents.settings.osNotify}
                onChange={(v) => setSettings({ osNotify: v })}
                aria-label={tr('ui.cli-monitor.send-a-system-notification-when-a-task-finishes')}
                data-testid="agents-os-notify"
              />
            </SettingRow>
            <SettingRow
              title={tr('ui.providers-schedule.read-aloud')}
              description={tr(
                'ui.providers-schedule.read-task-status-and-periodic-summaries-aloud-in',
              )}
            >
              <Switch
                checked={agents.settings.summaryEnabled}
                disabled={!agents.settings.enabled}
                onChange={(v) => setSettings({ summaryEnabled: v })}
                aria-label={tr(
                  'ui.usage-tools.spoken-coding-assistant-notifications-codex-and-more',
                )}
                data-testid="agents-summary"
              />
            </SettingRow>
            {onOpenNotify && (
              <SettingRow
                title={tr('ui.providers-schedule.dynamic-island-quiet-hours')}
                description={tr(
                  'ui.providers-schedule.notification-style-types-and-quiet-hours-are-set',
                )}
              >
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="agents-open-notify"
                  onClick={onOpenNotify}
                >
                  {tr('ui.cli-monitor.open-notifications-dynamic-island')}
                </Button>
              </SettingRow>
            )}
          </SettingsGroup>

          <SettingsGroup
            title={tr('ui.providers-schedule.assistants-to-monitor')}
            description={
              <>
                {tr('ui.providers-schedule.detected')}
                {agents.detected.length
                  ? agents.detected.map((k) => tr(AGENT_LABEL[k])).join('、')
                  : tr('ui.providers-schedule.none')}
              </>
            }
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void agentsClient.scan().then(setAgents)}
                data-testid="agents-scan"
              >
                {tr('ui.providers-schedule.scan-now')}
              </Button>
            }
          >
            <div className={styles.tools}>
              {(Object.keys(AGENT_LABEL) as AgentKind[]).map((k) => {
                const found = agents.detected.includes(k);
                return (
                  <div key={k} className={styles.tool}>
                    <span className={styles.toolName}>
                      {tr(AGENT_LABEL[k])}
                      <span className={styles.toolState} data-found={found ? '1' : undefined}>
                        {found
                          ? tr('ui.providers-schedule.detected-label')
                          : tr('ui.slash-commands.not-detected')}
                      </span>
                    </span>
                    <Switch
                      checked={agents.settings.tools[k]}
                      disabled={!agents.settings.enabled}
                      onChange={(v) =>
                        setSettings({ tools: { [k]: v } as Partial<Record<AgentKind, boolean>> })
                      }
                      aria-label={tr('ui.providers-schedule.monitor', tr(AGENT_LABEL[k]))}
                      data-testid={`agents-tool-${k}`}
                    />
                  </div>
                );
              })}
            </div>
          </SettingsGroup>

          <SettingsGroup
            title={tr('ui.cli-monitor.active-sessions')}
            description={tr('ui.providers-schedule.claude-code-codex-dsh-gemini-cli-cursor-aider')}
          >
            {agents.sessions.length > 0 && (
              <div
                className={styles.row}
                role="group"
                aria-label={tr('ui.cli-monitor.filter-by-endpoint')}
                data-testid="agents-endpoints"
              >
                {endpointCounts(agents.sessions).map(([k, n]) => (
                  <Button
                    key={k}
                    size="sm"
                    variant={agentFilter === k ? 'primary' : 'ghost'}
                    aria-pressed={agentFilter === k}
                    data-testid={`agents-filter-${k}`}
                    onClick={() => setAgentFilter(k)}
                  >
                    {isBuiltinCliId(k) ? <EndpointIcon backend={k} size={14} decorative /> : null}
                    {k === 'all'
                      ? tr('ui.providers-schedule.all')
                      : k === 'tabs'
                        ? tr('ui.cli-monitor.nomi-tabs')
                        : tr(AGENT_LABEL[k as AgentKind])}{' '}
                    {n}
                  </Button>
                ))}
              </div>
            )}
            {agents.sessions.length === 0 ? (
              <EmptyState
                icon={SquareTerminal}
                title={tr('ui.providers-schedule.no-active-sessions')}
                description={tr('ui.cli-monitor.sessions-show-up-here-once-you-start-claude')}
              />
            ) : (
              <div data-testid="agents-sessions">
                {filterSessions(agents.sessions, agentFilter)
                  .slice(0, 20)
                  .map((s) => (
                    <SettingRow
                      key={s.id}
                      data-testid={`agents-session-${s.source ?? 'file'}`}
                      title={
                        <span className={styles.sessionTitle} title={s.cwd || s.path}>
                          {s.kind === 'nomi' || isBuiltinCliId(s.kind) ? (
                            <EndpointIcon backend={s.kind} size={16} />
                          ) : null}
                          <span className={styles.grow}>{s.title}</span>
                        </span>
                      }
                      description={
                        <span
                          className={styles.meta}
                          title={s.summary || undefined}
                          data-testid="agents-session-meta"
                        >
                          {[
                            s.label,
                            s.project,
                            tr('ui.mascot-theme.last-activity', relTime(s.mtime, now)),
                            s.usage ? sessionUsageText(s.usage, fx.currency, fx.rate) : '',
                            s.summary,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      }
                    >
                      <Badge
                        tone={
                          s.status === 'failed' || s.status === 'stalled'
                            ? 'warning'
                            : s.status === 'completed'
                              ? 'success'
                              : undefined
                        }
                      >
                        {tr(STATUS_LABEL[s.status])}
                      </Badge>
                      {s.source === 'tab' && s.tabId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid="agents-open-tab"
                          onClick={() =>
                            void harnessClient
                              .activateTab(s.tabId!)
                              .then(() => onOpenedTab?.())
                              .catch(() => undefined)
                          }
                        >
                          {s.unread
                            ? tr('ui.cli-monitor.view-new-results', s.unread)
                            : tr('ui.cli-monitor.open-tab')}
                        </Button>
                      )}
                    </SettingRow>
                  ))}
              </div>
            )}
          </SettingsGroup>
        </>
      )}
    </div>
  );
};
