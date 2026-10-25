/**
 * 会话流里的系统卡片：斜杠命令（/context /cost /status /model /help …）的结果。
 * 它们由 Nomi 本机生成，不属于任何一轮模型回复，也不会发给模型。
 */
import { Icon, t } from '@nomi-ai/ui';
import { AlertTriangle, Check, Info, Terminal, X, XCircle } from 'lucide-react';
import React, { useState } from 'react';

import { formatTokens, formatUsd } from '../../slash/tokens';
import type { CardAction, CardBody, SlashCard } from '../../slash/types';

import styles from './index.module.css';

const pct = (n: number, d: number) => (d > 0 ? Math.min(100, (n / d) * 100) : 0);

const ContextBody: React.FC<{ b: Extract<CardBody, { kind: 'context' }> }> = ({ b }) => {
  const total = pct(b.used, b.windowSize);
  const tone = total >= 90 ? 'danger' : total >= 70 ? 'warn' : 'ok';
  return (
    <div className={styles.ctx} data-testid="slash-card-context">
      <div className={styles.ctxHead}>
        <span className={styles.big} data-testid="ctx-percent">
          {total.toFixed(total < 10 ? 1 : 0)}%
        </span>
        <span className={styles.muted}>
          {t('{0} / {1} tokens', formatTokens(b.used), formatTokens(b.windowSize))}
          {b.basis === 'estimate' && <> · {t('ui.usage-tools.estimated')}</>}
        </span>
        {b.model && <span className={styles.chip}>{b.model}</span>}
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(total)}
        aria-label={t('ui.slash-commands.context-usage')}
        data-tone={tone}
        data-testid="ctx-bar"
      >
        {b.categories.map((c) => (
          <span
            key={c.key}
            className={`${styles.seg} ${styles[`seg_${c.key}`] ?? ''}`}
            style={{ width: `${pct(c.tokens, b.windowSize)}%` }}
            title={`${c.label}: ${formatTokens(c.tokens)}`}
          />
        ))}
      </div>
      <ul className={styles.legend} data-testid="ctx-categories">
        {b.categories.map((c) => (
          <li key={c.key}>
            <i className={`${styles.dot} ${styles[`seg_${c.key}`] ?? ''}`} />
            <span className={styles.legendLabel}>{c.label}</span>
            <span className={styles.muted}>
              {formatTokens(c.tokens)} · {pct(c.tokens, b.windowSize).toFixed(1)}%
            </span>
          </li>
        ))}
        <li>
          <i className={`${styles.dot} ${styles.seg_free}`} />
          <span className={styles.legendLabel}>{t('ui.slash-commands.free')}</span>
          <span className={styles.muted}>
            {formatTokens(Math.max(0, b.windowSize - b.used))} · {(100 - total).toFixed(1)}%
          </span>
        </li>
      </ul>
      {b.notes.map((n) => (
        <p key={n} className={styles.note}>
          {n}
        </p>
      ))}
    </div>
  );
};

const CostBody: React.FC<{ b: Extract<CardBody, { kind: 'cost' }> }> = ({ b }) => {
  const s = b.session;
  const row = (
    label: string,
    v: { costUsd: number; tokens: number; calls: number } | undefined,
    id: string,
  ) =>
    v ? (
      <tr data-testid={`cost-${id}`}>
        <th scope="row">{label}</th>
        <td>{formatTokens(v.tokens)}</td>
        <td>{v.costUsd ? formatUsd(v.costUsd) : '—'}</td>
        <td>{v.calls}</td>
      </tr>
    ) : null;
  return (
    <div data-testid="slash-card-cost">
      <table className={styles.table}>
        <thead>
          <tr>
            <th />
            <th>{t('Token')}</th>
            <th>{t('ui.usage-tools.cost')}</th>
            <th>{t('ui.slash-commands.requests')}</th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid="cost-session">
            <th scope="row">{t('ui.slash-commands.this-session')}</th>
            <td>
              {formatTokens(s.input + s.output)}
              <span className={styles.muted}>
                {' '}
                ({t('ui.slash-commands.in-out', formatTokens(s.input), formatTokens(s.output))}
                {s.cacheRead ? t('ui.slash-commands.cache', formatTokens(s.cacheRead)) : ''})
              </span>
            </td>
            <td>{s.costUsd ? formatUsd(s.costUsd) : '—'}</td>
            <td>{s.turns - s.missing}</td>
          </tr>
          {row(t('ui.usage-tools.today'), b.today, 'today')}
          {row(t('ui.usage-tools.last-7-days'), b.week, 'week')}
        </tbody>
      </table>
      {b.notes.map((n) => (
        <p key={n} className={styles.note}>
          {n}
        </p>
      ))}
    </div>
  );
};

const ListBody: React.FC<{ b: Extract<CardBody, { kind: 'list' }> }> = ({ b }) => {
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState('');
  if (!b.items.length) return <p className={styles.note}>{b.empty}</p>;
  return (
    <div data-testid="slash-card-list">
      <ul className={styles.list}>
        {b.items.map((it, i) => {
          const head = it.group && it.group !== b.items[i - 1]?.group ? it.group : null;
          const active = chosen === null ? it.active : chosen === i;
          return (
            <React.Fragment key={`${it.label}-${i}`}>
              {head && <li className={styles.groupHead}>{head}</li>}
              <li className={styles.item} data-active={active ? 'true' : undefined}>
                <span className={styles.itemLabel}>
                  {it.label}
                  {it.hint && <span className={styles.hint}> {it.hint}</span>}
                </span>
                {it.description && <span className={styles.itemDesc}>{it.description}</span>}
                {it.badge && <span className={styles.chip}>{it.badge}</span>}
                {it.action && (
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={busy !== null || active}
                    data-testid={`slash-card-action-${i}`}
                    onClick={() => {
                      setBusy(i);
                      setErr('');
                      void Promise.resolve(it.action!.run())
                        .then(() => setChosen(i))
                        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                        .finally(() => setBusy(null));
                    }}
                  >
                    {active ? (
                      <>
                        <Icon icon={Check} size={12} /> {t('ui.providers-schedule.current')}
                      </>
                    ) : (
                      it.action.label
                    )}
                  </button>
                )}
              </li>
            </React.Fragment>
          );
        })}
      </ul>
      {err && (
        <p className={`${styles.note} ${styles.err}`} role="alert">
          {err}
        </p>
      )}
      {b.note && <p className={styles.note}>{b.note}</p>}
    </div>
  );
};

const DiffBody: React.FC<{ b: Extract<CardBody, { kind: 'diff' }> }> = ({ b }) => {
  if (!b.ok)
    return (
      <p className={`${styles.note} ${styles.err}`}>
        {b.error ?? t('ui.slash-commands.failed-to-read')}
      </p>
    );
  if (!b.status.trim() && !b.diff.trim())
    return <p className={styles.note}>{t('ui.slash-commands.no-uncommitted-changes')}</p>;
  return (
    <div data-testid="slash-card-diff">
      {b.status.trim() && <pre className={styles.pre}>{b.status}</pre>}
      {b.stat.trim() && <pre className={styles.pre}>{b.stat}</pre>}
      {b.diff.trim() && (
        <pre className={`${styles.pre} ${styles.diff}`}>
          {b.diff.split('\n').map((l, i) => (
            <span
              key={i}
              className={
                l.startsWith('+') && !l.startsWith('+++')
                  ? styles.add
                  : l.startsWith('-') && !l.startsWith('---')
                    ? styles.del
                    : l.startsWith('@@')
                      ? styles.hunk
                      : undefined
              }
            >
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {b.truncated && (
        <p className={styles.note}>
          {t('ui.slash-commands.too-long-only-the-first-part-is-shown')}
        </p>
      )}
    </div>
  );
};

const ActionButtons: React.FC<{ actions: CardAction[]; onDone?: (a: CardAction) => void }> = ({
  actions,
  onDone,
}) => {
  const [err, setErr] = useState('');
  if (!actions.length) return null;
  return (
    <div className={styles.actions}>
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          className={styles.btn}
          data-testid={`slash-card-act-${a.id}`}
          onClick={() => {
            setErr('');
            void Promise.resolve(a.run())
              .then(() => onDone?.(a))
              .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
          }}
        >
          {a.label}
        </button>
      ))}
      {err && <span className={styles.err}>{err}</span>}
    </div>
  );
};

export const SystemCardView: React.FC<{
  card: SlashCard;
  onDismiss?: (id: string) => void;
}> = ({ card, onDismiss }) => {
  const b = card.body;
  const tone = b.kind === 'notice' ? b.tone : 'info';
  const ToneIcon = tone === 'error' ? XCircle : tone === 'warn' ? AlertTriangle : Info;
  return (
    <section
      className={styles.card}
      data-tone={tone}
      data-kind={b.kind}
      data-testid="slash-card"
      aria-label={card.title}
    >
      <header className={styles.head}>
        <span className={styles.headIcon}>
          <Icon icon={b.kind === 'notice' ? ToneIcon : Terminal} size={14} />
        </span>
        <span className={styles.title}>{card.title}</span>
        <code className={styles.cmd} data-testid="slash-card-command">
          {card.command}
        </code>
        <span className={styles.spacer} />
        {onDismiss && (
          <button
            type="button"
            className={styles.close}
            aria-label={t('ui.providers-schedule.close')}
            title={t('ui.providers-schedule.close')}
            data-testid="slash-card-dismiss"
            onClick={() => onDismiss(card.id)}
          >
            <Icon icon={X} size={13} />
          </button>
        )}
      </header>
      <div className={styles.body}>
        {b.kind === 'context' && <ContextBody b={b} />}
        {b.kind === 'cost' && <CostBody b={b} />}
        {b.kind === 'list' && <ListBody b={b} />}
        {b.kind === 'diff' && <DiffBody b={b} />}
        {b.kind === 'status' && (
          <dl className={styles.kv} data-testid="slash-card-status">
            {b.rows.map((r) => (
              <React.Fragment key={r.label}>
                <dt>{r.label}</dt>
                <dd data-tone={r.tone}>{r.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        {b.kind === 'notice' && (
          <div data-testid="slash-card-notice">
            <p className={styles.text}>{b.text}</p>
            {b.detail && <p className={styles.note}>{b.detail}</p>}
          </div>
        )}
        {card.actions?.length ? (
          <ActionButtons
            actions={card.actions}
            onDone={(a) => a.id === 'send-plain' && onDismiss?.(card.id)}
          />
        ) : null}
      </div>
    </section>
  );
};
