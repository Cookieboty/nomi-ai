/**
 * 「监视与会话」：进度监视（开关 / 系统通知 / 语音播报）、监视哪些助手（检测 / 立即扫描）
 * + 活跃会话列表（按端点筛选；Nomi 标签可直接打开）。
 * 只读本地日志与进程列表，不登录、不抓取任何账号。通知样式与灵动岛在「通知 / 灵动岛」里设置。
 */
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
  if (d < 60_000) return tr('刚刚');
  if (d < 3_600_000) return tr('{0} 分钟前', Math.floor(d / 60_000));
  if (d < 86_400_000) return tr('{0} 小时前', Math.floor(d / 3_600_000));
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
        <Notice tone="warning">{tr('当前环境无法访问主进程监视器。')}</Notice>
      )}
      {agents && (
        <>
          <SettingsGroup
            title={tr('进度监视')}
            description={tr(
              '只算「文件刚有写入且进程还在」的会话，按会话去重。只读本地日志与进程列表，不登录、不刮取任何账号。',
            )}
          >
            <SettingRow
              title={tr('监视编程助手进度')}
              description={tr('任务完成、失败、卡住或等待确认时在气泡 / 灵动岛里提示。')}
            >
              <Switch
                checked={agents.settings.enabled}
                onChange={(v) => setSettings({ enabled: v })}
                aria-label={tr('监视编程助手进度')}
                data-testid="agents-enabled"
              />
            </SettingRow>
            <SettingRow title={tr('任务完成 / 卡住时发送系统通知')}>
              <Switch
                checked={agents.settings.osNotify}
                onChange={(v) => setSettings({ osNotify: v })}
                aria-label={tr('任务完成 / 卡住时发送系统通知')}
                data-testid="agents-os-notify"
              />
            </SettingRow>
            <SettingRow
              title={tr('语音播报')}
              description={tr(
                '任务状态和定时汇总在提示音之外再朗读一遍；关闭时只保留提示音。遵守语音开关与静音。',
              )}
            >
              <Switch
                checked={agents.settings.summaryEnabled}
                disabled={!agents.settings.enabled}
                onChange={(v) => setSettings({ summaryEnabled: v })}
                aria-label={tr('编程助手消息语音播报（Codex 等）')}
                data-testid="agents-summary"
              />
            </SettingRow>
            {onOpenNotify && (
              <SettingRow
                title={tr('灵动岛与免打扰')}
                description={tr(
                  '通知样式、类型与免打扰时段在「通知 / 灵动岛」和「日程与日历」里设置。',
                )}
              >
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="agents-open-notify"
                  onClick={onOpenNotify}
                >
                  {tr('打开通知 / 灵动岛')}
                </Button>
              </SettingRow>
            )}
          </SettingsGroup>

          <SettingsGroup
            title={tr('监视哪些助手')}
            description={
              <>
                {tr('已检测：')}
                {agents.detected.length
                  ? agents.detected.map((k) => tr(AGENT_LABEL[k])).join('、')
                  : tr('无')}
              </>
            }
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void agentsClient.scan().then(setAgents)}
                data-testid="agents-scan"
              >
                {tr('立即扫描')}
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
                        {found ? tr('已检测到') : tr('未检测到')}
                      </span>
                    </span>
                    <Switch
                      checked={agents.settings.tools[k]}
                      disabled={!agents.settings.enabled}
                      onChange={(v) =>
                        setSettings({ tools: { [k]: v } as Partial<Record<AgentKind, boolean>> })
                      }
                      aria-label={tr('监视 {0}', tr(AGENT_LABEL[k]))}
                      data-testid={`agents-tool-${k}`}
                    />
                  </div>
                );
              })}
            </div>
          </SettingsGroup>

          <SettingsGroup
            title={tr('活跃会话')}
            description={tr(
              'Claude Code / Codex / dsh / Gemini CLI / Cursor / Aider / Cline / Continue 与 Nomi 里的编程助手标签。',
            )}
          >
            {agents.sessions.length > 0 && (
              <div
                className={styles.row}
                role="group"
                aria-label={tr('按端点筛选')}
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
                    {k === 'claude' || k === 'codex' || k === 'dsh' || k === 'grok' ? (
                      <EndpointIcon backend={k} size={14} decorative />
                    ) : null}
                    {k === 'all'
                      ? tr('全部')
                      : k === 'tabs'
                        ? tr('Nomi 标签')
                        : tr(AGENT_LABEL[k as AgentKind])}{' '}
                    {n}
                  </Button>
                ))}
              </div>
            )}
            {agents.sessions.length === 0 ? (
              <EmptyState
                icon={SquareTerminal}
                title={tr('暂无活跃会话')}
                description={tr(
                  '启动 Claude Code、Codex、dsh 等工具或打开编程助手标签后会出现在这里。',
                )}
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
                          {s.kind === 'nomi' ||
                          s.kind === 'claude' ||
                          s.kind === 'codex' ||
                          s.kind === 'dsh' ? (
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
                            tr('最后活动 {0}', relTime(s.mtime)),
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
                          {s.unread ? tr('查看 {0} 条新结果', s.unread) : tr('打开标签')}
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
