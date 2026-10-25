/**
 * 预算与隐私：日 / 月预算与单任务提醒线、统计开关、日志读取、保留时长、一键清空。
 * 全部只存本机；没有云同步 / 排行榜 / 分享入口。
 */
import { Badge, Button, Input, Notice, Select, Switch, t } from '@nomi-ai/ui';
import { ShieldCheck, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

import {
  usageClient,
  type UsageRetention,
  type UsageSettings,
  type UsageState,
} from '../../services/usageClient';
import { AppIcon } from '../AppIcons';

import { currencySymbol } from './format';
import styles from './index.module.css';

type BudgetKey = 'dailyBudget' | 'monthlyBudget' | 'taskAlert';

const fmt = (n: number) => (n > 0 ? String(n) : '');

/** 输入框文本 → 金额；空 = 0（不提醒）；非法返回 null */
export function parseAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) return null;
  return Math.round(n * 100) / 100;
}

interface Props {
  state: UsageState;
  onSettings: (s: UsageSettings) => void;
  /** 清空后让上层重新拉取数据 */
  onCleared: (s: UsageState) => void;
}

export const Budget: React.FC<Props> = ({ state, onSettings, onCleared }) => {
  const st = state.settings;
  const sym = currencySymbol(st.currency);
  const [vals, setVals] = useState<Record<BudgetKey, string>>({
    dailyBudget: fmt(st.dailyBudget),
    monthlyBudget: fmt(st.monthlyBudget),
    taskAlert: fmt(st.taskAlert),
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 外部设置变化（换币种会换算金额）时同步输入框：渲染期比较
  const [seen, setSeen] = useState({
    d: st.dailyBudget,
    m: st.monthlyBudget,
    k: st.taskAlert,
  });
  if (seen.d !== st.dailyBudget || seen.m !== st.monthlyBudget || seen.k !== st.taskAlert) {
    setSeen({ d: st.dailyBudget, m: st.monthlyBudget, k: st.taskAlert });
    setVals({
      dailyBudget: fmt(st.dailyBudget),
      monthlyBudget: fmt(st.monthlyBudget),
      taskAlert: fmt(st.taskAlert),
    });
  }

  const patch = async (p: Partial<UsageSettings>) => {
    try {
      onSettings(await usageClient.setSettings(p));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const commit = (k: BudgetKey) => {
    const n = parseAmount(vals[k]);
    if (n == null) {
      setErr(t('ui.usage-tools.the-amount-must-be-a-number-0-leave'));
      return;
    }
    if (n !== st[k]) void patch({ [k]: n });
    else setErr(null);
  };
  const clear = async () => {
    if (
      !window.confirm(
        t('ui.usage-tools.clear-all-usage-records-your-price-table-and', state.records),
      )
    )
      return;
    setBusy(true);
    try {
      onCleared(await usageClient.clear());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (k: BudgetKey, label: string, testid: string) => (
    <label className={styles.budgetField}>
      <span>{label}</span>
      <span className={styles.amount}>
        <span aria-hidden="true">{sym}</span>
        <Input
          size="sm"
          type="number"
          step="any"
          min="0"
          inputMode="decimal"
          placeholder={t('ui.usage-tools.no-alert')}
          value={vals[k]}
          data-testid={testid}
          aria-label={label}
          onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
          onBlur={() => commit(k)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(k);
          }}
        />
      </span>
    </label>
  );

  return (
    <div className={styles.stack} data-testid="usage-budget">
      {err && <p className={styles.err}>{err}</p>}
      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('ui.usage-tools.budget-and-alerts')}</h3>
          <Badge tone="neutral">{st.currency}</Badge>
        </header>
        <div className={styles.budgetGrid}>
          {field('dailyBudget', t('ui.usage-tools.daily-budget'), 'usage-budget-daily')}
          {field('monthlyBudget', t('ui.usage-tools.monthly-budget'), 'usage-budget-monthly')}
          {field(
            'taskAlert',
            t('ui.usage-tools.single-task-spend-alert-line'),
            'usage-budget-task',
          )}
        </div>
        <p className={styles.dim}>{t('ui.usage-tools.you-are-alerted-once-at-80-and-once')}</p>
        <p className={styles.dim}>
          {t('ui.usage-tools.alerts-are-held-back-during-quiet-mode-and')}
        </p>
      </section>

      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('ui.chat-settings.privacy-data')}</h3>
          <AppIcon icon={ShieldCheck} />
        </header>
        <div className={styles.switchCol}>
          <Switch
            checked={st.enabled}
            onChange={(v) => void patch({ enabled: v })}
            label={t('ui.usage-tools.record-token-usage')}
            data-testid="usage-enabled"
          />
          <Switch
            checked={st.readToolLogs}
            disabled={!st.enabled}
            onChange={(v) => void patch({ readToolLogs: v })}
            label={t('ui.usage-tools.read-local-coding-tool-session-logs')}
            data-testid="usage-read-logs"
          />
          <Switch
            checked={st.activeQuotaRefresh}
            disabled={!st.enabled}
            onChange={(v) => void patch({ activeQuotaRefresh: v })}
            label={t('ui.usage-tools.active-quota-refresh-let-the-official-cli-fetch')}
            data-testid="usage-active-quota"
          />
        </div>
        <p className={styles.dim}>
          {t('ui.usage-tools.when-on-clicking-refresh-on-the-quota-card')}
        </p>
        <p className={styles.dim}>
          {t('ui.usage-tools.only-the-time-model-token-counts-and-session')}
        </p>
        <label className={styles.budgetField}>
          <span>{t('ui.usage-tools.record-retention')}</span>
          <Select
            size="sm"
            aria-label={t('ui.usage-tools.record-retention')}
            data-testid="usage-retention"
            value={st.retention}
            onChange={(e) => void patch({ retention: e.target.value as UsageRetention })}
            options={[
              { value: '90d', label: t('ui.usage-tools.90-days') },
              { value: '1y', label: t('ui.usage-tools.1-year') },
              { value: 'forever', label: t('ui.usage-tools.keep-forever') },
            ]}
          />
        </label>
        <div className={styles.actionsRow}>
          <Button
            size="sm"
            variant="danger"
            disabled={busy || state.records === 0}
            onClick={() => void clear()}
            data-testid="usage-clear"
          >
            <AppIcon icon={Trash2} />
            {t('ui.usage-tools.clear-usage-records')}
          </Button>
          <span className={styles.dim}>{t('ui.usage-tools.records', state.records)}</span>
        </div>
        <Notice tone="info" icon={ShieldCheck}>
          {t('ui.usage-tools.all-usage-data-stays-on-this-computer-nothing')}
        </Notice>
      </section>
    </div>
  );
};
