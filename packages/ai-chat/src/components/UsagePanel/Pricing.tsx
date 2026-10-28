import { Badge, Button, Input, Notice, t } from '@nomi-ai/ui';
import { Info, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import {
  usageClient,
  type UsageCustomPrice,
  type UsagePriceSyncResult,
  type UsageSettings,
  type UsageState,
  type UsageSummary,
} from '../../services/usageClient';
import { AppIcon } from '../AppIcons';

import { formatDateTime, formatPrice, formatTokens, syncFailureReason } from './format';
import styles from './index.module.css';

interface Row {
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

const toRow = (p: UsageCustomPrice): Row => ({
  model: p.model,
  input: String(p.input),
  output: String(p.output),
  cacheRead: p.cacheRead == null ? '' : String(p.cacheRead),
  cacheWrite: p.cacheWrite == null ? '' : String(p.cacheWrite),
});

const num = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
};

/** 表单行 → 价格；不合法返回错误信息 */
export function parseRows(rows: Row[]): { prices: UsageCustomPrice[] } | { error: string } {
  const out: UsageCustomPrice[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const model = r.model.trim();
    if (!model) return { error: t('ui.usage-tools.model-name-can-t-be-empty') };
    const key = model.toLowerCase();
    if (seen.has(key)) return { error: t('ui.usage-tools.model-is-duplicated', model) };
    seen.add(key);
    const input = num(r.input);
    const output = num(r.output);
    const cr = num(r.cacheRead);
    const cw = num(r.cacheWrite);
    if (input == null || output == null || [input, output, cr, cw].some((n) => Number.isNaN(n)))
      return { error: t('ui.usage-tools.prices-for-must-be-numbers-0-input-and', model) };
    out.push({
      model,
      input,
      output,
      ...(cr != null ? { cacheRead: cr } : {}),
      ...(cw != null ? { cacheWrite: cw } : {}),
    });
  }
  return { prices: out };
}

interface Props {
  state: UsageState;
  unpriced: UsageSummary['unpriced'];
  onSettings: (s: UsageSettings) => void;
  /** 价格同步后拿到最新状态 */
  onState?: (s: UsageState) => void;
}

/** 同步结果 → 一句话（失败时说明原因，并明确已有价格没有被改动） */
export function priceSyncMessage(r: UsagePriceSyncResult): string {
  if (r.ok)
    return r.status === 'not-modified'
      ? t('ui.usage-tools.price-table-is-up-to-date-nothing-downloaded')
      : t('ui.usage-tools.synced-prices-for-models', r.count);
  return t('ui.usage-tools.sync-failed-existing-prices-are-still-in-use', syncFailureReason(r));
}

export const Pricing: React.FC<Props> = ({ state, unpriced, onSettings, onState }) => {
  const st = state.settings;
  const [rows, setRows] = useState<Row[]>(() => st.customPrices.map(toRow));
  const [rate, setRate] = useState(String(st.cnyPerUsd));
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 草稿状态：用户改过但没保存的表单不能被「内容没变的新引用」冲掉（用量刷新每次都会带回克隆出来的新数组）
  const [pricesDirty, setPricesDirty] = useState(false);
  const [rateDirty, setRateDirty] = useState(false);
  const [conflictPrices, setConflictPrices] = useState(false);
  const [conflictRate, setConflictRate] = useState(false);
  const conflict = conflictPrices || conflictRate;
  // 外部设置变化（保存 / 另一个窗口修改）时同步表单：渲染期比较「语义内容」而不是引用
  const priceKey = JSON.stringify(st.customPrices);
  const [seen, setSeen] = useState({ prices: priceKey, rate: st.cnyPerUsd });
  if (seen.prices !== priceKey || seen.rate !== st.cnyPerUsd) {
    const pricesChanged = seen.prices !== priceKey;
    const rateChanged = seen.rate !== st.cnyPerUsd;
    setSeen({ prices: priceKey, rate: st.cnyPerUsd });
    if (pricesChanged) {
      if (pricesDirty)
        setConflictPrices(true); // 保留草稿，提示外部已变化
      else setRows(st.customPrices.map(toRow));
    }
    if (rateChanged) {
      if (rateDirty) setConflictRate(true);
      else setRate(String(st.cnyPerUsd));
    }
  }
  /** 放弃草稿，载入最新的已保存值 */
  const reloadLatest = () => {
    setRows(st.customPrices.map(toRow));
    setRate(String(st.cnyPerUsd));
    setPricesDirty(false);
    setRateDirty(false);
    setConflictPrices(false);
    setConflictRate(false);
    setErr(null);
  };

  const patch = async (p: Partial<UsageSettings>) => {
    try {
      const next = await usageClient.setSettings(p);
      // 先把「已保存」的基线挪到新值，再通知父级：保存产生的变化不算外部冲突
      setSeen((cur) => ({
        prices: p.customPrices ? JSON.stringify(next.customPrices) : cur.prices,
        rate: p.cnyPerUsd != null ? next.cnyPerUsd : cur.rate,
      }));
      if (p.customPrices) {
        setRows(next.customPrices.map(toRow)); // 显示规范化后的值
        setPricesDirty(false);
        setConflictPrices(false);
      }
      if (p.cnyPerUsd != null) {
        setRate(String(next.cnyPerUsd));
        setRateDirty(false);
        setConflictRate(false);
      }
      onSettings(next);
      setErr(null);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const update = (i: number, k: keyof Row, v: string) => {
    setSaved(false);
    setPricesDirty(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  };
  const add = (model = '') => {
    setSaved(false);
    setPricesDirty(true);
    setRows((rs) => [...rs, { model, input: '', output: '', cacheRead: '', cacheWrite: '' }]);
  };
  const save = async () => {
    const r = parseRows(rows);
    if ('error' in r) return setErr(r.error);
    if (await patch({ customPrices: r.prices })) setSaved(true);
  };
  const saveRate = async () => {
    const n = Number(rate);
    if (!(n > 0 && n < 1000))
      return setErr(t('ui.usage-tools.the-exchange-rate-must-be-a-number-greater'));
    await patch({ cnyPerUsd: n });
  };
  const sync = state.pricing.sync;
  const syncPrices = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const { result, ...next } = await usageClient.syncPrices();
      setSyncMsg({ ok: result.ok, text: priceSyncMessage(result) });
      onState?.(next as UsageState);
    } catch (e) {
      setSyncMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSyncing(false);
    }
  };
  const custom = new Set(st.customPrices.map((p) => p.model.toLowerCase()));
  const todo = unpriced.filter(
    (u) => !rows.some((r) => r.model.trim().toLowerCase() === u.model.toLowerCase()),
  );

  return (
    <div className={styles.stack} data-testid="usage-pricing">
      {conflict && (
        <Notice tone="warning" icon={Info} data-testid="usage-pricing-conflict">
          {t('ui.usage-tools.prices-exchange-rates-were-updated-elsewhere-your-unsaved')}
          <button type="button" className={styles.chip} onClick={reloadLatest}>
            {t('ui.usage-tools.discard-edits-and-load-latest')}
          </button>
        </Notice>
      )}
      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('ui.usage-tools.currency-exchange-rate')}</h3>
        </header>
        <div className={styles.fxRow}>
          <label className={styles.rate}>
            <span>1 USD =</span>
            <Input
              size="sm"
              type="number"
              step="any"
              min="0"
              className={styles.rateInput}
              value={rate}
              data-testid="usage-rate"
              aria-label={t('ui.usage-tools.usd-to-cny-exchange-rate')}
              onChange={(e) => {
                setRate(e.target.value);
                setRateDirty(true);
              }}
              onBlur={() => void saveRate()}
            />
            <span>CNY</span>
            <Badge tone="neutral">{t('ui.usage-tools.customizable')}</Badge>
          </label>
        </div>
        <p className={styles.dim}>
          {t('ui.usage-tools.costs-are-priced-in-usd-and-converted-with')}
        </p>
      </section>

      <section className={styles.panel} data-testid="usage-price-sync">
        <header className={styles.panelHead}>
          <h3>{t('ui.usage-tools.price-table-sync')}</h3>
          <span className={styles.dim} data-testid="usage-sync-status">
            {sync && sync.count > 0
              ? t(
                  'ui.usage-tools.price-table-date-last-synced-models',
                  sync.tableDate || '—',
                  formatDateTime(sync.fetchedAt),
                  sync.count,
                )
              : t('ui.usage-tools.not-synced-yet-using-the-built-in-price', state.pricing.date)}
          </span>
        </header>
        <p className={styles.dim}>{t('ui.usage-tools.models-data-sync-note')}</p>
        <div className={styles.actionsRow}>
          <Button
            size="sm"
            onClick={() => void syncPrices()}
            disabled={syncing}
            data-testid="usage-sync-prices"
          >
            {syncing ? t('ui.usage-tools.syncing') : t('ui.usage-tools.sync-prices')}
          </Button>
          {syncMsg && (
            <span className={syncMsg.ok ? styles.ok : styles.err} data-testid="usage-sync-result">
              {syncMsg.text}
            </span>
          )}
        </div>
      </section>

      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('ui.usage-tools.custom-prices')}</h3>
          <span className={styles.dim}>{t('ui.usage-tools.usd-1m-tokens')}</span>
        </header>
        <p className={styles.dim}>
          {t('ui.usage-tools.add-models-missing-from-the-built-in-table')}
        </p>
        {todo.length > 0 && (
          <Notice tone="warning" icon={Info} data-testid="usage-todo-prices">
            {t('ui.usage-tools.these-models-were-used-but-have-no-price')}
            {todo.slice(0, 8).map((u) => (
              <button
                key={u.model}
                type="button"
                className={styles.chip}
                onClick={() => add(u.model)}
              >
                <AppIcon icon={Plus} size={12} />
                {u.model}
              </button>
            ))}
          </Notice>
        )}
        {rows.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid="usage-custom-table">
              <thead>
                <tr>
                  <th>{t('ui.foundation.model')}</th>
                  <th className={styles.num}>{t('ui.usage-tools.input')}</th>
                  <th className={styles.num}>{t('ui.usage-tools.output')}</th>
                  <th className={styles.num}>{t('ui.usage-tools.cache-read')}</th>
                  <th className={styles.num}>{t('ui.usage-tools.cache-write')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} data-testid="usage-custom-row">
                    <td>
                      <Input
                        size="sm"
                        value={r.model}
                        placeholder="model-name"
                        aria-label={t('ui.usage-tools.model-name')}
                        onChange={(e) => update(i, 'model', e.target.value)}
                      />
                    </td>
                    {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((k) => (
                      <td key={k} className={styles.num}>
                        <Input
                          size="sm"
                          type="number"
                          step="any"
                          min="0"
                          className={styles.priceIn}
                          value={r[k]}
                          aria-label={[r.model || t('ui.foundation.model'), k].join(' ')}
                          data-testid={`usage-price-${k}`}
                          onChange={(e) => update(i, k, e.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('ui.usage-tools.delete-this-row')}
                        onClick={() => {
                          setSaved(false);
                          setPricesDirty(true);
                          setRows((rs) => rs.filter((_, j) => j !== i));
                        }}
                      >
                        <AppIcon icon={Trash2} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.actionsRow}>
          <Button size="sm" onClick={() => add()} data-testid="usage-add-price">
            <AppIcon icon={Plus} />
            {t('ui.usage-tools.add-model-price')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void save()}
            data-testid="usage-save-prices"
          >
            {t('ui.usage-tools.save-prices')}
          </Button>
          {saved && <span className={styles.ok}>{t('ui.voice-mascot.saved')}</span>}
        </div>
        {err && <p className={styles.err}>{err}</p>}
      </section>

      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('ui.usage-tools.built-in-price-table')}</h3>
          <span className={styles.dim}>
            {t(
              'ui.usage-tools.compiled-on-from-official-public-price-lists-not',
              state.pricing.date,
            )}
          </span>
        </header>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="usage-builtin-table">
            <thead>
              <tr>
                <th>{t('ui.foundation.model')}</th>
                <th className={styles.num}>{t('ui.usage-tools.input')}</th>
                <th className={styles.num}>{t('ui.usage-tools.output')}</th>
                <th className={styles.num}>{t('ui.usage-tools.cache-read')}</th>
                <th className={styles.num}>{t('ui.usage-tools.cache-write')}</th>
                <th>{t('ui.providers-schedule.note')}</th>
              </tr>
            </thead>
            <tbody>
              {state.pricing.builtin.map((p) => (
                <tr key={p.model}>
                  <td className={styles.mono}>
                    {p.label ?? p.model}
                    {custom.has(p.model.toLowerCase()) && (
                      <Badge tone="accent" className={styles.estBadge}>
                        {t('ui.usage-tools.overridden')}
                      </Badge>
                    )}
                  </td>
                  <td className={styles.num}>{formatPrice(p.input)}</td>
                  <td className={styles.num}>{formatPrice(p.output)}</td>
                  <td className={styles.num}>{formatPrice(p.cacheRead)}</td>
                  <td className={styles.num}>{formatPrice(p.cacheWrite)}</td>
                  <td className={styles.dim}>
                    {p.note ?? ''}
                    {p.tiers?.map((x) => (
                      <div key={x.size}>
                        {t(
                          'ui.usage-tools.per-request-above',
                          formatTokens(x.size),
                          `${formatPrice(x.input)} / ${formatPrice(x.output)}`,
                        )}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.dim}>{t('ui.usage-tools.models-that-are-neither-in-the-table-nor')}</p>
      </section>
    </div>
  );
};
