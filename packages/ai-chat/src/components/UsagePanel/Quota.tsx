/**
 * 订阅额度 / 工具卡片（尽力而为）。
 * 每个编程工具一张可扩展卡片，顶部用 Tabs 切换工具。
 * 卡片区块：工具名与图标、登录方式（账号 vs API Key）、额度（仅账号登录）、
 * 用量与费用（USD/当前币种）、状态、刷新说明；Claude 另有 statusline 钩子。
 * 额度只来自本机已有数据与用户点「刷新」时官方 CLI 自己取到的结果；
 * Nomi 不读取、不上传任何登录凭据。
 */
import { Badge, Button, Card, Tabs, t } from '@nomi-ai/ui';
import { Gauge, KeyRound, RefreshCw, UserRound } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  USAGE_SOURCE_LABEL,
  usageClient,
  type UsageBreakdownRow,
  type UsageQuotaEntry,
  type UsageQuotaHook,
  type UsageQuotaWindow,
  type UsageToolRefresh,
} from '../../services/usageClient';
import { AppIcon } from '../AppIcons';
import { relTime } from '../CodingMonitor';

import { formatTokens, quotaWindowLabel, resetText } from './format';
import styles from './index.module.css';
import { moneyOf, SourceIcon, type Fx } from './shared';

const nameOf = (e: UsageQuotaEntry) => {
  const k = USAGE_SOURCE_LABEL[e.id];
  return k ? t(k) : e.label;
};

const ORIGIN_LABEL: Record<NonNullable<UsageQuotaEntry['origin']>, string> = {
  statusline: '来源：Claude Code 状态栏快照',
  'usage-cmd': '来源：claude /usage（官方 CLI）',
  'session-log': '来源：Codex 会话日志',
  'app-server': '来源：codex app-server（官方 CLI）',
  'grok-acp': '来源：Grok ACP billing（官方 CLI）',
};

type Note = { text: string; tone: 'ok' | 'dim' | 'err' };

/** 把一次刷新结果翻译成给用户看的一句话（不含任何账号信息） */
export function refreshNote(id: string, r: UsageToolRefresh): Note | null {
  const name = id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Grok';
  const cli =
    id === 'claude' ? 'claude -p /usage' : id === 'codex' ? 'codex app-server' : 'grok ACP billing';
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

const Window: React.FC<{ w: UsageQuotaWindow; now: number }> = ({ w, now }) => {
  const pct = Math.round(w.usedPercent);
  const tone = pct >= 90 ? styles.quotaHigh : pct >= 70 ? styles.quotaMid : '';
  return (
    <li className={styles.quotaWin} data-testid="usage-quota-window">
      <div className={styles.quotaWinHead}>
        <span>{quotaWindowLabel(w.id, w.windowMinutes)}</span>
        {w.expired ? (
          <span className={styles.dim}>{t('窗口已重置，下次使用后更新')}</span>
        ) : (
          <>
            <b>{t('已用 {0}%', pct)}</b>
            {w.resetAt ? <span className={styles.dim}>{resetText(w.resetAt, now)}</span> : null}
          </>
        )}
      </div>
      {!w.expired && (
        <div
          className={`${styles.quotaBar} ${tone}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={quotaWindowLabel(w.id, w.windowMinutes)}
        >
          <i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
        </div>
      )}
    </li>
  );
};

/** Claude Code 的额度只出现在它的 statusline 输入里：这里让用户自己决定要不要开启本地快照 */
const ClaudeHook: React.FC<{
  hook: UsageQuotaHook;
  busy: boolean;
  err: string | null;
  onToggle: (on: boolean) => void;
}> = ({ hook, busy, err, onToggle }) => (
  <div className={styles.quotaHook} data-testid="usage-quota-hook">
    {!hook.supported ? (
      <p className={styles.dim}>
        {t(
          '暂不支持在 Windows 上自动开启。可以在 Claude Code 的 statusLine 脚本里把 stdin 的 rate_limits 写到本地文件。',
        )}
      </p>
    ) : hook.problem ? (
      <p className={styles.err}>
        {hook.problem === 'invalid-settings'
          ? t('~/.claude/settings.json 不是合法的 JSON，为避免弄坏它，Nomi 没有改动。')
          : t('你已经配置了非命令类型的 statusLine，Nomi 不会覆盖它。')}
      </p>
    ) : hook.enabled ? (
      <>
        <p className={styles.dim}>
          {hook.hasSnapshot
            ? t('已开启状态栏快照：额度来自 Claude Code 每次回复后给状态栏的数据。')
            : t('已开启状态栏快照：等 Claude Code 完成一次回复后，这里就会出现额度。')}
          {hook.hadOwnStatusLine && <> {t('你原来的状态栏命令照常运行。')}</>}
        </p>
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onToggle(false)}
            data-testid="usage-hook-off"
          >
            {t('关闭并恢复原配置')}
          </Button>
        </div>
      </>
    ) : (
      <>
        <p className={styles.dim}>
          {t(
            'Claude Code 的 5 小时 / 每周额度不会写进会话日志，只出现在它给状态栏的数据里（官方文档，需 Pro / Max 订阅）。可以选择开启：Nomi 在 ~/.claude/settings.json 接入一个本地小脚本，把这份数据存成一个本机文件；你原来的状态栏命令照常运行，随时可关闭恢复。不读取凭据，不联网。',
          )}
        </p>
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onToggle(true)}
            data-testid="usage-hook-on"
          >
            {t('开启 Claude Code 额度同步')}
          </Button>
        </div>
      </>
    )}
    {err && <p className={styles.err}>{err}</p>}
  </div>
);

function authLabel(e: UsageQuotaEntry): { text: string; tone: 'neutral' | 'success' | 'warning' } {
  if (e.status === 'api' || e.auth === 'api') return { text: t('API 密钥'), tone: 'warning' };
  if (e.auth === 'subscription') return { text: t('账号登录'), tone: 'success' };
  // 旧快照可能没带 auth：有额度窗口时按账号登录展示
  if (e.status === 'ok') return { text: t('账号登录'), tone: 'success' };
  return { text: t('未确认登录方式'), tone: 'neutral' };
}

const ToolCard: React.FC<{
  entry: UsageQuotaEntry;
  usage: UsageBreakdownRow | null;
  fx: Fx;
  now: number;
  note: Note | null;
  hook: UsageQuotaHook | null;
  hookBusy: boolean;
  hookErr: string | null;
  onToggleHook: (on: boolean) => void;
}> = ({ entry: e, usage, fx, now, note, hook, hookBusy, hookErr, onToggleHook }) => {
  const auth = authLabel(e);
  const money = moneyOf(fx);
  const isApi = e.status === 'api' || e.auth === 'api';
  const showQuota = !isApi;
  const statusAttr = e.status === 'api' ? 'api' : e.status === 'ok' ? 'ok' : 'unavailable';

  return (
    <Card
      className={styles.toolCard}
      data-testid={`usage-quota-${e.id}`}
      data-status={statusAttr}
      title={
        <span className={styles.toolCardTitle}>
          <SourceIcon source={e.id} size={18} />
          <b>{nameOf(e)}</b>
          {e.plan ? <Badge tone="neutral">{e.plan}</Badge> : null}
          <Badge tone={auth.tone}>{auth.text}</Badge>
          {e.stale ? <Badge tone="warning">{t('上次读取')}</Badge> : null}
        </span>
      }
      subtitle={e.updatedAt ? t('更新于 {0}', relTime(e.updatedAt, now)) : t('可扩展工具卡片')}
    >
      <div className={styles.toolSections}>
        <section className={styles.toolSection} data-testid={`usage-tool-auth-${e.id}`}>
          <header className={styles.toolSectionHead}>
            <AppIcon icon={isApi ? KeyRound : UserRound} size={14} />
            <h4>{t('登录方式')}</h4>
          </header>
          <p className={styles.dim}>
            {isApi
              ? t('当前按 API Key / 第三方供应商计费，不展示订阅额度，只统计用量与费用。')
              : e.auth === 'unknown'
                ? t('尚未确认登录方式；有额度快照时仍会展示。')
                : t('当前为账号 / 订阅登录，可展示官方 CLI 返回的订阅额度。')}
          </p>
        </section>

        {showQuota && (
          <section className={styles.toolSection} data-testid={`usage-tool-quota-${e.id}`}>
            <header className={styles.toolSectionHead}>
              <AppIcon icon={Gauge} size={14} />
              <h4>{t('订阅额度')}</h4>
            </header>
            {e.origin ? (
              <div className={styles.dim} data-testid={`usage-quota-origin-${e.id}`}>
                {t(ORIGIN_LABEL[e.origin])}
              </div>
            ) : null}
            {e.status === 'ok' ? (
              <ul className={styles.quotaList} aria-label={t('{0}额度窗口', nameOf(e))}>
                {e.windows.map((w) => (
                  <Window key={w.id} w={w} now={now} />
                ))}
              </ul>
            ) : (
              <span className={styles.dim}>
                {e.id === 'grok'
                  ? t('Grok 已识别为官方账号登录，但当前 CLI 没有返回可用额度。请点击刷新重试。')
                  : t('暂未返回可用额度')}
              </span>
            )}
          </section>
        )}

        {isApi && (
          <section className={styles.toolSection} data-testid={`usage-tool-quota-${e.id}`}>
            <header className={styles.toolSectionHead}>
              <AppIcon icon={Gauge} size={14} />
              <h4>{t('订阅额度')}</h4>
            </header>
            <span className={styles.dim}>{t('API 计费，无订阅额度')}</span>
          </section>
        )}

        <section className={styles.toolSection} data-testid={`usage-tool-usage-${e.id}`}>
          <header className={styles.toolSectionHead}>
            <h4>{t('用量与费用')}</h4>
            <span className={styles.dim}>{t('近 7 天')}</span>
          </header>
          {usage && usage.calls > 0 ? (
            <div className={styles.toolUsageRow}>
              <span>
                {t('总 Token')} <b>{formatTokens(usage.tokens)}</b>
              </span>
              <span>
                {t('费用')} <b>{money(usage.costUsd)}</b>
              </span>
              <span className={styles.dim}>{t('{0} 次调用', usage.calls)}</span>
            </div>
          ) : (
            <span className={styles.dim}>{t('近 7 天还没有读到该工具的用量。')}</span>
          )}
        </section>

        <section className={styles.toolSection} data-testid={`usage-tool-status-${e.id}`}>
          <header className={styles.toolSectionHead}>
            <h4>{t('状态')}</h4>
          </header>
          {note ? (
            <p className={note.tone === 'err' ? styles.err : styles.dim}>{note.text}</p>
          ) : (
            <p className={styles.dim}>
              {t('点顶部「刷新」时，才会让官方 CLI 按需取额度；不会自动轮询。')}
            </p>
          )}
        </section>

        {hook && e.id === 'claude' && showQuota && (
          <ClaudeHook hook={hook} busy={hookBusy} err={hookErr} onToggle={onToggleHook} />
        )}
      </div>
    </Card>
  );
};

export interface QuotaCardProps {
  /** 概览已查询的 bySource；传入后不再单独 query，避免重复 IPC */
  usageBySource?: UsageBreakdownRow[];
  fx?: Fx;
}

export const QuotaCard: React.FC<QuotaCardProps> = ({
  usageBySource,
  fx = { currency: 'USD', rate: 7.2 },
}) => {
  const [rows, setRows] = useState<UsageQuotaEntry[] | null>(null);
  const [hook, setHook] = useState<UsageQuotaHook | null>(null);
  const [hookBusy, setHookBusy] = useState(false);
  const [hookErr, setHookErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [active, setActive] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tab, setTab] = useState<string>('');

  const usageById = useMemo(() => {
    const map: Record<string, UsageBreakdownRow> = {};
    for (const row of usageBySource ?? []) map[row.key] = row;
    return map;
  }, [usageBySource]);

  const load = useCallback(
    () =>
      Promise.all([usageClient.quota(), usageClient.state().catch(() => null)])
        .then(([r, st]) => {
          setRows(r);
          setNow(Date.now());
          if (st) setActive(st.settings.activeQuotaRefresh !== false);
          if (r.some((e) => e.id === 'claude' && (e.auth ?? 'subscription') === 'subscription'))
            return usageClient.quotaHook().then(setHook);
          setHook(null);
        })
        .catch(() => setRows([])),
    [],
  );

  useEffect(() => {
    if (!usageClient.available()) return;
    let alive = true;
    const run = () => {
      if (alive) void load();
    };
    run();
    const off = usageClient.onChanged(run);
    const timer = setInterval(run, 30_000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, [load]);

  const tools = useMemo(() => rows ?? [], [rows]);

  useEffect(() => {
    if (!tools.length) {
      setTab('');
      return;
    }
    if (!tab || !tools.some((e) => e.id === tab)) setTab(tools[0]!.id);
  }, [tools, tab]);

  const refresh = () => {
    setRefreshing(true);
    setNotes([]);
    usageClient
      .quotaRefresh()
      .then((r) => {
        setRows(r.entries);
        setNow(Date.now());
        const out: Note[] = [];
        for (const id of ['claude', 'codex', 'grok'] as const) {
          const res = r.tools[id];
          const n = res ? refreshNote(id, res) : null;
          if (n) out.push(n);
        }
        setNotes(out);
        void usageClient
          .state()
          .then((st) => setActive(st.settings.activeQuotaRefresh !== false))
          .catch(() => undefined);
        void load();
      })
      .catch((e: unknown) =>
        setNotes([{ tone: 'err', text: e instanceof Error ? e.message : String(e) }]),
      )
      .finally(() => setRefreshing(false));
  };

  const toggle = (on: boolean) => {
    setHookBusy(true);
    setHookErr(null);
    usageClient
      .setQuotaHook(on)
      .then((h) => {
        setHook(h);
        return load();
      })
      .catch((e: unknown) => setHookErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setHookBusy(false));
  };

  if (!rows) return null;

  const noteFor = (id: string): Note | null => {
    const name =
      id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : id === 'grok' ? 'Grok' : '';
    return notes.find((n) => (name ? n.text.startsWith(name) : false)) ?? null;
  };

  const current = tools.find((e) => e.id === tab) ?? tools[0] ?? null;

  return (
    <section className={styles.panel} data-testid="usage-quota-card">
      <header className={styles.panelHead}>
        <h3>{t('订阅额度')}</h3>
        <Badge tone="neutral">{t('尽力而为')}</Badge>
        <Button
          size="sm"
          disabled={refreshing}
          onClick={refresh}
          aria-label={t('刷新额度')}
          title={
            active
              ? t('只在点击时才让官方 CLI 去取额度，不会自动轮询')
              : t('已关闭「主动刷新额度」：只重读本机已有的数据')
          }
          data-testid="usage-quota-refresh"
        >
          <AppIcon icon={RefreshCw} /> {refreshing ? t('刷新中…') : t('刷新')}
        </Button>
        <AppIcon icon={Gauge} />
      </header>

      {notes.length > 0 && (
        <ul className={styles.quotaNotes} data-testid="usage-quota-notes" role="status">
          {notes.map((n, i) => (
            <li key={i} className={n.tone === 'err' ? styles.err : styles.dim}>
              {n.text}
            </li>
          ))}
        </ul>
      )}

      {tools.length === 0 ? (
        <p className={styles.dim} data-testid="usage-quota-empty">
          {t('没有检测到以账号 / 订阅登录的编程工具。')}
        </p>
      ) : (
        <>
          <Tabs
            aria-label={t('编程工具')}
            value={tab || tools[0]!.id}
            onChange={setTab}
            items={tools.map((e) => ({
              value: e.id,
              label: (
                <span className={styles.toolTabLabel}>
                  <SourceIcon source={e.id} size={14} />
                  {nameOf(e)}
                </span>
              ),
            }))}
            data-testid="usage-quota-tabs"
          />
          {current && (
            <ToolCard
              entry={current}
              usage={usageById[current.id] ?? null}
              fx={fx}
              now={now}
              note={noteFor(current.id)}
              hook={hook}
              hookBusy={hookBusy}
              hookErr={hookErr}
              onToggleHook={toggle}
            />
          )}
        </>
      )}

      <p className={styles.dim}>
        {t(
          '只有以账号 / 订阅登录的工具才有额度；用 API Key、第三方供应商或本地路由的工具（包括 Nomi 对话）按量计费，只统计用量与费用。额度只来自这台电脑上已有的数据，以及你点「刷新」时官方 CLI 自己取到的结果；登录方式也只看官方的登录状态。',
        )}
      </p>
      <p className={styles.dim} data-testid="usage-quota-privacy">
        {t(
          '隐私：Nomi 不读取、不保存、不上传任何登录凭据（不打开 auth.json、.credentials.json 或系统钥匙串）。点「刷新」时，快照过期才会临时启动官方 CLI（claude -p /usage、codex app-server、Grok ACP billing），由它用自己的登录态去取，Nomi 只保留百分比、窗口、重置时间和套餐；注意 Codex 会因此向 OpenAI 发一次请求。不会自动轮询，同一工具 60 秒内最多刷新一次；可在「隐私与数据」里关闭「主动刷新额度」。',
        )}
      </p>
    </section>
  );
};
