/**
 * 执行轨迹工作台的共享基础组件与辅助映射（图标、状态、代码块、网关请求详情、关键词高亮）。
 */
import { Badge, Button, Icon, t } from '@nomi-ai/ui';
import {
  IconActivity as ActivityIcon,
  IconAlertCircle as CircleAlert,
  IconBrain as Brain,
  IconCompass as Compass,
  IconFilePencil as FilePen,
  IconFilePlus as FilePlus,
  IconFileText as FileText,
  IconFolderOpen as FolderOpen,
  IconGlobe as Globe,
  IconListCheck as ListChecks,
  IconMessagePlus as MessagePlus,
  IconRobot as Bot,
  IconSearch as Search,
  IconSparkles as Sparkles,
  IconTerminal2 as SquareTerminal,
  IconTool as Wrench,
  IconUser as UserIcon,
} from '@tabler/icons-react';
import type { TablerIcon as IconGlyph } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';

import {
  diagnosticsClient,
  type GatewayTraceResult,
} from '../../services/diagnosticsClient';
import type { QualityRequestItem } from '../../services/qualityClient';
import type { ToolKind } from '../../utils/toolTrace';
import { formatMs, outcomeLabel, outcomeTone } from '../QualityPanel/format';
import { formatTokens } from '../UsagePanel/format';

import styles from './index.module.css';
import {
  auditQualityRequest,
  requestOutputTps,
  type ModelAuditVerdict,
  type TraceNode,
  type TraceNodeStatus,
} from './model';

const TOOL_KIND_ICON: Record<ToolKind, IconGlyph> = {
  read: FileText,
  search: Search,
  list: FolderOpen,
  edit: FilePen,
  write: FilePlus,
  command: SquareTerminal,
  subagent: Bot,
  web: Globe,
  todo: ListChecks,
  other: Wrench,
};

export function iconForNode(node: Pick<TraceNode, 'kind' | 'toolKind'>): IconGlyph {
  switch (node.kind) {
    case 'user':
      return UserIcon;
    case 'thinking':
      return Brain;
    case 'subagent':
      return Bot;
    case 'reply':
      return Sparkles;
    case 'request':
      return ActivityIcon;
    case 'interject':
      return MessagePlus;
    case 'error':
      return CircleAlert;
    case 'status':
      return Compass;
    case 'tool':
      return TOOL_KIND_ICON[node.toolKind ?? 'other'] ?? Wrench;
  }
}

export const statusTone = (
  s: TraceNodeStatus,
): 'accent' | 'success' | 'danger' | 'warning' => {
  if (s === 'error') return 'danger';
  if (s === 'running') return 'accent';
  if (s === 'stopped') return 'warning';
  return 'success';
};

export const statusLabel = (s: TraceNodeStatus): string => {
  if (s === 'error') return t('ui.foundation.failed');
  if (s === 'running') return t('ui.devtools.unfinished');
  if (s === 'stopped') return t('ui.chat-settings.stopped');
  return t('ui.usage-tools.done');
};

/** 复制按钮：复制后短暂显示「已复制」 */
export const CopyButton: React.FC<{ text: string; label?: string; testId?: string }> = ({
  text,
  label,
  testId,
}) => {
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
      {done ? t('ui.usage-tools.copied') : (label ?? t('ui.knowledge-local.copy'))}
    </Button>
  );
};

export const Block: React.FC<{
  label: string;
  text?: string;
  testId?: string;
  className?: string;
}> = ({ label, text, testId, className }) =>
  text ? (
    <section className={`${styles.block} ${className ?? ''}`} data-testid={testId}>
      <header className={styles.blockHead}>
        <span>{label}</span>
        <CopyButton text={text} />
      </header>
      <pre className={styles.pre}>{text}</pre>
    </section>
  ) : null;

export const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) =>
  value === undefined || value === null || value === '' ? null : (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );

/** 在文本中高亮搜索关键词（大小写不敏感） */
export const HighlightText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length || !text) return <>{text}</>;
  const escaped = terms.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  if (parts.length <= 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, idx) =>
        terms.some((term) => part.toLowerCase() === term) ? (
          <mark key={idx} className={styles.highlight}>
            {part}
          </mark>
        ) : (
          <React.Fragment key={idx}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};

/** 网关请求的正文（按需加载） */
export const RequestBody: React.FC<{ traceId?: string }> = ({ traceId }) => {
  const [state, setState] = useState<GatewayTraceResult | 'loading' | { error: string } | null>(
    null,
  );
  if (!traceId) {
    return <p className={styles.hint}>{t('ui.devtools.no-body-recorded-for-this-request')}</p>;
  }
  if (state === null) {
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
  }
  if (state === 'loading') return <p className={styles.hint}>{t('ui.mascot-theme.loading')}</p>;
  if ('error' in state) return <p className={styles.error}>{state.error}</p>;
  if (!state.found || !state.text) {
    return <p className={styles.hint}>{t('ui.devtools.no-body-recorded-for-this-request')}</p>;
  }
  return (
    <>
      {state.truncated && <p className={styles.hint}>{t('ui.devtools.content-truncated')}</p>}
      <Block label={t('ui.devtools.request-and-response')} text={state.text} testId="trace-body" />
    </>
  );
};

export const verdictTone = (
  v: ModelAuditVerdict,
): 'success' | 'danger' | 'warning' | 'neutral' => {
  if (v === 'verified') return 'success';
  if (v === 'mismatch') return 'danger';
  if (v === 'suspect') return 'warning';
  return 'neutral';
};

export const verdictLabel = (v: ModelAuditVerdict): string => {
  if (v === 'verified') return t('ui.devtools.verdict-verified');
  if (v === 'mismatch') return t('ui.devtools.verdict-mismatch');
  if (v === 'suspect') return t('ui.devtools.verdict-suspect');
  return t('ui.devtools.verdict-unverified');
};

export const AuditBadge: React.FC<{
  verdict: ModelAuditVerdict;
  extra?: string;
  testId?: string;
}> = ({ verdict, extra, testId }) => (
  <Badge tone={verdictTone(verdict)} data-testid={testId}>
    {extra ? `${verdictLabel(verdict)} · ${extra}` : verdictLabel(verdict)}
  </Badge>
);

export const RequestDetail: React.FC<{ req: QualityRequestItem }> = ({ req }) => {
  const tk = req.tokens;
  const audit = auditQualityRequest(req);
  const fp = req.fingerprint;
  const tps = requestOutputTps(req);
  const sigText = [
    fp?.hasThinkSig ? 'thinking-signature' : '',
    fp?.hasSealedReasoning ? 'sealed-reasoning' : '',
    fp?.hasReasoningText && !fp.hasThinkSig ? 'reasoning-text-only' : '',
  ]
    .filter(Boolean)
    .join(', ');
  const headersText = fp?.headers
    ? Object.entries(fp.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : '';

  return (
    <div className={styles.detail} data-testid="trace-request-detail">
      <dl className={styles.facts}>
        <Fact label={t('ui.foundation.model')} value={req.display ?? req.model} />
        <Fact label={t('ui.devtools.upstream-model')} value={req.upstreamModel} />
        <Fact
          label={t('ui.devtools.observed-model')}
          value={fp?.responseModel ?? req.responseModel}
        />
        <Fact
          label={t('ui.devtools.fingerprint-check')}
          value={<AuditBadge verdict={audit.verdict} testId="request-audit-verdict" />}
        />
        <Fact label={t('ui.devtools.response-id')} value={fp?.responseId} />
        <Fact label={t('ui.devtools.system-fingerprint')} value={fp?.systemFingerprint} />
        <Fact label={t('ui.devtools.service-tier')} value={fp?.serviceTier} />
        <Fact label={t('ui.devtools.reasoning-signature')} value={sigText} />
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
        {tps !== undefined && (
          <Fact label={t('ui.model-quality.output-speed')} value={`${tps.toFixed(1)} tok/s`} />
        )}
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
      {audit.evidences.length > 0 && (
        <section className={styles.block} data-testid="request-fingerprint-evidences">
          <header className={styles.blockHead}>
            <span>{t('ui.devtools.fingerprint-check')}</span>
          </header>
          <ul className={styles.evidenceMiniList}>
            {audit.evidences.map((ev) => (
              <li key={ev.id} className={styles.evidenceMiniItem} data-status={ev.status}>
                {ev.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {headersText && (
        <Block
          label={t('ui.devtools.upstream-headers')}
          text={headersText}
          testId="request-fingerprint-headers"
        />
      )}
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

export const NodeIconGlyph: React.FC<{ node: Pick<TraceNode, 'kind' | 'toolKind'>; size?: number }> =
  ({ node, size = 15 }) => <Icon icon={iconForNode(node)} size={size} />;
