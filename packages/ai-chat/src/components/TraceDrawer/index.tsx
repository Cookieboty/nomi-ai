/**
 * 开发者工具：一轮的执行轨迹（只在工作台模式下，从助手消息操作栏打开）。
 * - 时间线：思考 / 工具调用 / 网关请求的瀑布图，点一行看参数、输出、错误与耗时；
 * - 网关请求：这一轮经过网关的模型请求（模型、供应商、首字、token、结果），可看请求 / 响应正文；
 * - 子进程收发：编程助手子进程的 stdin / stdout / stderr、启动参数与退出码（诊断日志开着时才有）；
 * - 原始事件：这条消息落盘的轨迹与用量 JSON。
 * 数据来源：消息自身的轨迹 + `quality.requests`（按标签 / 客户端与时间窗）+ `diagnostics.cliRecords` /
 * `diagnostics.gatewayTrace`。正文与收发在写入时已脱敏。
 */
import { Badge, Button, Modal, ModalHostContext, Tabs, t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import {
  diagnosticsClient,
  type CliRecord,
  type CliRecordsResult,
  type GatewayTraceResult,
} from '../../services/diagnosticsClient';
import { qualityClient, type QualityRequestItem } from '../../services/qualityClient';
import type { ConvMessage } from '../../types/conversation';
import { callDuration, formatDuration } from '../../utils/toolTrace';
import { formatMs, outcomeLabel, outcomeTone } from '../QualityPanel/format';
import { formatTokens } from '../UsagePanel/format';

import styles from './index.module.css';
import {
  barOf,
  offsetLabel,
  prettyJson,
  turnWindow,
  waterfallRows,
  waterfallSpan,
  type WaterfallRow,
} from './model';

/** 这一轮属于哪种会话：编程助手标签（按标签 id 关联）或 Nomi 对话（按客户端 nomi 关联） */
export type TraceSource = { kind: 'cli'; tabId: string } | { kind: 'nomi' };

type View = 'timeline' | 'requests' | 'process' | 'raw';

const REQUEST_LIMIT = 200;
/** 右侧抽屉（与子任务抽屉同一种宿主） */
const DRAWER_HOST = { mode: 'drawer' as const };

/** 复制按钮：复制后短暂显示「已复制」 */
const CopyButton: React.FC<{ text: string; testId?: string }> = ({ text, testId }) => {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setDone(true))
          .catch(() => undefined);
      }}
    >
      {done ? t('ui.usage-tools.copied') : t('ui.knowledge-local.copy')}
    </Button>
  );
};

const Block: React.FC<{ label: string; text?: string; testId?: string }> = ({
  label,
  text,
  testId,
}) =>
  text ? (
    <section className={styles.block} data-testid={testId}>
      <header className={styles.blockHead}>
        <span>{label}</span>
        <CopyButton text={text} />
      </header>
      <pre className={styles.pre}>{text}</pre>
    </section>
  ) : null;

const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) =>
  value === undefined || value === null || value === '' ? null : (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );

const statusTone = (s: 'running' | 'done' | 'error'): 'accent' | 'success' | 'danger' =>
  s === 'error' ? 'danger' : s === 'running' ? 'accent' : 'success';

const statusLabel = (s: 'running' | 'done' | 'error'): string =>
  s === 'error'
    ? t('ui.foundation.failed')
    : s === 'running'
      ? t('ui.devtools.unfinished')
      : t('ui.usage-tools.done');

function rowTitle(row: WaterfallRow): string {
  if (row.kind === 'thinking') return t('ui.devtools.thinking');
  if (row.kind === 'tool') return row.call.name;
  if (row.kind === 'interject') return row.text;
  return row.req.display ?? row.req.model ?? t('ui.devtools.model-request');
}

/** 网关请求的正文（按需加载） */
const RequestBody: React.FC<{ traceId?: string }> = ({ traceId }) => {
  const [state, setState] = useState<GatewayTraceResult | 'loading' | { error: string } | null>(
    null,
  );
  if (!traceId)
    return <p className={styles.hint}>{t('ui.devtools.no-body-recorded-for-this-request')}</p>;
  if (state === null)
    return (
      <Button
        variant="secondary"
        size="sm"
        data-testid="trace-load-body"
        onClick={() => {
          setState('loading');
          diagnosticsClient
            .gatewayTrace(traceId)
            .then(setState)
            .catch((e: unknown) => setState({ error: (e as Error).message }));
        }}
      >
        {t('ui.devtools.view-request-and-response-body')}
      </Button>
    );
  if (state === 'loading') return <p className={styles.hint}>{t('ui.mascot-theme.loading')}</p>;
  if ('error' in state) return <p className={styles.error}>{state.error}</p>;
  if (!state.found || !state.text)
    return <p className={styles.hint}>{t('ui.devtools.no-body-recorded-for-this-request')}</p>;
  return (
    <>
      {state.truncated && <p className={styles.hint}>{t('ui.devtools.content-truncated')}</p>}
      <Block label={t('ui.devtools.request-and-response')} text={state.text} testId="trace-body" />
    </>
  );
};

const RequestDetail: React.FC<{ req: QualityRequestItem }> = ({ req }) => {
  const tk = req.tokens;
  return (
    <div className={styles.detail} data-testid="trace-request-detail">
      <dl className={styles.facts}>
        <Fact label={t('ui.foundation.model')} value={req.display ?? req.model} />
        <Fact label={t('ui.devtools.upstream-model')} value={req.upstreamModel} />
        <Fact
          label={t('ui.providers-schedule.provider')}
          value={req.providerName ?? req.provider}
        />
        <Fact label={t('ui.provider-link.key')} value={req.keyName ?? req.keyId} />
        <Fact
          label={t('ui.foundation.result')}
          value={<Badge tone={outcomeTone(req.outcome)}>{outcomeLabel(req.outcome)}</Badge>}
        />
        <Fact label={t('ui.devtools.http-status')} value={req.status} />
        <Fact label={t('ui.devtools.error-kind')} value={req.errorKind} />
        <Fact
          label={t('ui.model-quality.protocol')}
          value={[req.ingress, req.wire].filter(Boolean).join(' → ')}
        />
        <Fact label={t('ui.devtools.mode')} value={req.mode} />
        <Fact label={t('ui.devtools.first-content')} value={formatMs(req.timing.firstContentMs)} />
        <Fact label={t('ui.devtools.total-time')} value={formatMs(req.timing.endMs)} />
        <Fact
          label={t('ui.devtools.tokens')}
          value={[
            tk.input !== undefined && `${t('ui.usage-tools.input')} ${formatTokens(tk.input)}`,
            tk.output !== undefined && `${t('ui.usage-tools.output')} ${formatTokens(tk.output)}`,
            tk.cacheRead !== undefined &&
              `${t('ui.usage-tools.cache-read')} ${formatTokens(tk.cacheRead)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        <Fact label={t('ui.model-quality.trace-id')} value={req.traceId} />
      </dl>
      {!!req.attempts?.length && (
        <Block
          label={t('ui.model-quality.attempts-per-candidate')}
          text={JSON.stringify(req.attempts, null, 2)}
        />
      )}
      {!!req.notes?.length && (
        <Block label={t('ui.model-quality.gateway-adjustments')} text={req.notes.join('\n')} />
      )}
      <RequestBody traceId={req.traceId} />
    </div>
  );
};

const RowDetail: React.FC<{ row: WaterfallRow }> = ({ row }) => {
  if (row.kind === 'request') return <RequestDetail req={row.req} />;
  if (row.kind === 'interject')
    return (
      <div className={styles.detail}>
        <Block label={t('ui.session-workspace.you-added')} text={row.text} />
      </div>
    );
  if (row.kind === 'thinking')
    return (
      <div className={styles.detail}>
        <Block label={t('ui.devtools.thinking')} text={row.text} />
      </div>
    );
  const c = row.call;
  return (
    <div className={styles.detail} data-testid="trace-tool-detail">
      <dl className={styles.facts}>
        <Fact label={t('ui.foundation.tool')} value={c.name} />
        <Fact
          label={t('ui.cli-monitor.status')}
          value={<Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>}
        />
        <Fact
          label={t('ui.devtools.elapsed')}
          value={formatDuration(callDuration(c)) || undefined}
        />
        <Fact label={t('ui.devtools.call-id')} value={c.id} />
        <Fact label={t('ui.devtools.parent-call')} value={c.parentId} />
      </dl>
      <Block
        label={t('ui.usage-tools.input')}
        text={prettyJson(c.input)}
        testId="trace-tool-input"
      />
      <Block
        label={c.status === 'error' ? t('ui.model-quality.error') : t('ui.usage-tools.output')}
        text={c.output}
        testId="trace-tool-output"
      />
      {!c.input && !c.output && (
        <p className={styles.hint}>{t('ui.devtools.no-input-or-output-was-kept')}</p>
      )}
    </div>
  );
};

const Timeline: React.FC<{
  rows: WaterfallRow[];
  from: number;
  to: number;
}> = ({ rows, from, to }) => {
  const [pick, setPick] = useState<string | null>(null);
  const span = useMemo(() => waterfallSpan({ from, to }, rows), [from, to, rows]);
  if (!rows.length) return <p className={styles.hint}>{t('ui.devtools.no-steps-in-this-turn')}</p>;
  const picked = rows.find((r) => r.id === pick);
  return (
    <div className={styles.timeline}>
      <div className={styles.scale} aria-hidden>
        <span>{offsetLabel(span.from, span.from)}</span>
        <span>{offsetLabel(span.to, span.from)}</span>
      </div>
      <ul className={styles.rows} role="listbox" aria-label={t('ui.model-quality.timeline')}>
        {rows.map((r) => {
          const bar = barOf(r, span);
          const status =
            r.kind === 'tool'
              ? r.call.status
              : r.kind === 'request'
                ? r.req.outcome === 'ok'
                  ? 'done'
                  : 'error'
                : 'done';
          const dur =
            r.kind === 'request'
              ? formatMs(r.req.timing.endMs)
              : r.end !== undefined && !Number.isNaN(r.start)
                ? formatDuration(r.end - r.start)
                : '';
          return (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={pick === r.id}
                className={styles.row}
                data-kind={r.kind}
                data-status={status}
                data-testid="trace-row"
                onClick={() => setPick(pick === r.id ? null : r.id)}
              >
                <span
                  className={styles.rowName}
                  style={
                    r.kind === 'tool' ? { paddingInlineStart: `${r.depth * 12}px` } : undefined
                  }
                >
                  <span className={styles.kind}>
                    {r.kind === 'request'
                      ? t('ui.slash-commands.requests')
                      : r.kind === 'thinking'
                        ? t('ui.devtools.thinking')
                        : r.kind === 'interject'
                          ? t('ui.session-workspace.inserted')
                          : t('ui.foundation.tool')}
                  </span>
                  <span className={styles.rowTitle}>{rowTitle(r)}</span>
                </span>
                <span className={styles.track}>
                  {bar && (
                    <span
                      className={styles.bar}
                      style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                    />
                  )}
                  {r.kind === 'request' && r.firstAt !== undefined && (
                    <span
                      className={styles.marker}
                      style={{
                        left: `${((r.firstAt - span.from) / (span.to - span.from)) * 100}%`,
                      }}
                      title={t('ui.devtools.first-content')}
                    />
                  )}
                </span>
                <span className={styles.rowDur}>{dur}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {picked ? (
        <RowDetail row={picked} />
      ) : (
        <p className={styles.hint}>{t('ui.devtools.click-a-row-to-see-details')}</p>
      )}
    </div>
  );
};

const RequestList: React.FC<{
  requests: QualityRequestItem[] | null;
  error: string | null;
  source: TraceSource;
}> = ({ requests, error, source }) => {
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <p className={styles.error}>{error}</p>;
  if (!requests) return <p className={styles.hint}>{t('ui.mascot-theme.loading')}</p>;
  if (!requests.length)
    return (
      <p className={styles.hint}>
        {source.kind === 'cli'
          ? t('ui.devtools.no-gateway-requests-official-accounts-connect-directly')
          : t('ui.devtools.no-gateway-requests-in-this-turn')}
      </p>
    );
  return (
    <ul className={styles.list}>
      {requests.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={styles.listRow}
            aria-expanded={open === r.id}
            data-testid="trace-request"
            onClick={() => setOpen(open === r.id ? null : r.id)}
          >
            <Badge tone={outcomeTone(r.outcome)}>{outcomeLabel(r.outcome)}</Badge>
            <span className={styles.rowTitle}>{r.display ?? r.model ?? '—'}</span>
            <span className={styles.muted}>{r.providerName ?? r.provider ?? ''}</span>
            <span className={styles.muted}>
              {t('ui.model-quality.ttft')} {formatMs(r.timing.firstContentMs)}
            </span>
            <span className={styles.rowDur}>{formatMs(r.timing.endMs)}</span>
          </button>
          {open === r.id && <RequestDetail req={r} />}
        </li>
      ))}
    </ul>
  );
};

const EV_FILTERS = ['all', 'in', 'out', 'err'] as const;
type EvFilter = (typeof EV_FILTERS)[number];

function recordText(r: CliRecord): string {
  if (r.ev === 'spawn') return `${r.cli ?? ''} ${(r.args ?? []).join(' ')}`.trim();
  if (r.ev === 'exit') return `code=${r.code ?? 'null'} signal=${r.signal ?? 'null'}`;
  return r.data ?? r.note ?? '';
}

const ProcessLog: React.FC<{
  result: CliRecordsResult | null;
  error: string | null;
  from: number;
}> = ({ result, error, from }) => {
  const [filter, setFilter] = useState<EvFilter>('all');
  if (error) return <p className={styles.error}>{error}</p>;
  if (!result) return <p className={styles.hint}>{t('ui.mascot-theme.loading')}</p>;
  const shown = result.records.filter(
    (r) => filter === 'all' || r.ev === filter || r.ev === 'spawn' || r.ev === 'exit',
  );
  const all = result.records.map((r) => `${r.t} [${r.ev ?? '-'}] ${recordText(r)}`).join('\n');
  return (
    <div className={styles.process}>
      {!result.enabled && (
        <p className={styles.hint} data-testid="trace-diagnostics-off">
          {t('ui.devtools.diagnostic-logs-are-off')}
        </p>
      )}
      {result.truncated && <p className={styles.hint}>{t('ui.devtools.content-truncated')}</p>}
      {result.records.length > 0 && (
        <div className={styles.toolbar}>
          <Tabs
            variant="underline"
            aria-label={t('ui.devtools.filter-streams')}
            value={filter}
            onChange={setFilter}
            items={EV_FILTERS.map((v) => ({
              value: v,
              label:
                v === 'all'
                  ? t('ui.providers-schedule.all')
                  : v === 'in'
                    ? 'stdin'
                    : v === 'out'
                      ? 'stdout'
                      : 'stderr',
            }))}
          />
          <CopyButton text={all} testId="trace-copy-process" />
        </div>
      )}
      {!result.records.length && result.enabled && (
        <p className={styles.hint}>{t('ui.devtools.no-process-records-in-this-turn')}</p>
      )}
      <ol className={styles.records}>
        {shown.map((r, i) => {
          const at = Date.parse(r.t);
          return (
            <li key={`${r.t}-${i}`} className={styles.record} data-ev={r.ev}>
              <span className={styles.recordMeta}>
                <span>{Number.isFinite(at) ? offsetLabel(at, from) : r.t}</span>
                <span className={styles.ev}>{r.ev ?? '—'}</span>
                {r.pid !== undefined && <span className={styles.muted}>pid {r.pid}</span>}
              </span>
              <pre className={styles.recordData}>{recordText(r)}</pre>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export const TraceDrawer: React.FC<{
  message: ConvMessage;
  source: TraceSource;
  onClose: () => void;
}> = ({ message, source, onClose }) => {
  const [view, setView] = useState<View>('timeline');
  const win = useMemo(() => turnWindow(message), [message]);
  const [requests, setRequests] = useState<QualityRequestItem[] | null>(null);
  const [reqError, setReqError] = useState<string | null>(null);
  const [proc, setProc] = useState<CliRecordsResult | null>(null);
  const [procError, setProcError] = useState<string | null>(null);
  const tabId = source.kind === 'cli' ? source.tabId : null;

  useEffect(() => {
    let alive = true;
    // 网关记账在请求结束后才落，起点稍往前、终点稍往后，免得漏掉边上的请求
    qualityClient
      .requests({
        from: win.from - 2000,
        to: win.to + 2000,
        layer: 'gateway',
        limit: REQUEST_LIMIT,
        ...(tabId ? { tabId } : { filters: { client: ['nomi'] } }),
      })
      .then((p) => alive && setRequests([...p.items].sort((a, b) => a.ts - b.ts)))
      .catch((e: unknown) => alive && setReqError((e as Error).message));
    if (tabId)
      diagnosticsClient
        .cliRecords({ tabId, from: win.from, to: win.to })
        .then((r) => alive && setProc(r))
        .catch((e: unknown) => alive && setProcError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [win.from, win.to, tabId]);

  const rows = useMemo(() => waterfallRows(message, requests ?? []), [message, requests]);
  const tools = rows.filter((r) => r.kind === 'tool');
  const failed = tools.filter((r) => r.kind === 'tool' && r.call.status === 'error').length;
  const raw = useMemo(
    () =>
      JSON.stringify(
        {
          id: message.id,
          at: new Date(message.at).toISOString(),
          durationMs: message.durationMs,
          model: message.model,
          usage: message.usage,
          error: message.error,
          stopped: message.stopped,
          trace: message.trace ?? [],
        },
        null,
        2,
      ),
    [message],
  );

  const items: { value: View; label: string }[] = [
    { value: 'timeline', label: t('ui.model-quality.timeline') },
    {
      value: 'requests',
      label: requests
        ? t('ui.devtools.gateway-requests-n', requests.length)
        : t('ui.devtools.gateway-requests'),
    },
    ...(tabId
      ? [
          {
            value: 'process' as const,
            label: proc
              ? t('ui.devtools.process-io-n', proc.records.length)
              : t('ui.devtools.process-io'),
          },
        ]
      : []),
    { value: 'raw', label: t('ui.devtools.raw-events') },
  ];

  return (
    <ModalHostContext.Provider value={DRAWER_HOST}>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={t('ui.devtools.execution-trace')}
        bodyClassName={styles.body}
        data-testid="trace-drawer"
      >
        <div className={styles.root}>
          <dl className={styles.summary}>
            <Fact
              label={t('ui.model-quality.start')}
              value={new Date(win.from).toLocaleTimeString()}
            />
            <Fact label={t('ui.devtools.elapsed')} value={formatDuration(win.to - win.from)} />
            <Fact label={t('ui.foundation.model')} value={message.model} />
            <Fact label={t('ui.models.tool-calls')} value={String(tools.length)} />
            {failed > 0 && <Fact label={t('ui.devtools.failed-calls')} value={String(failed)} />}
            {message.usage?.inputTokens !== undefined && (
              <Fact
                label={t('ui.devtools.tokens')}
                value={`${formatTokens(message.usage.inputTokens)} / ${formatTokens(message.usage.outputTokens ?? 0)}`}
              />
            )}
          </dl>
          {message.error && <p className={styles.error}>{message.error}</p>}
          <Tabs
            variant="underline"
            items={items}
            value={view}
            onChange={setView}
            aria-label={t('ui.devtools.execution-trace')}
          />
          <div className={styles.pane}>
            {view === 'timeline' && <Timeline rows={rows} from={win.from} to={win.to} />}
            {view === 'requests' && (
              <RequestList requests={requests} error={reqError} source={source} />
            )}
            {view === 'process' && <ProcessLog result={proc} error={procError} from={win.from} />}
            {view === 'raw' && (
              <Block label={t('ui.devtools.raw-events')} text={raw} testId="trace-raw" />
            )}
          </div>
        </div>
      </Modal>
    </ModalHostContext.Provider>
  );
};

export default TraceDrawer;
