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
      setErr(t('金额需要是不小于 0 的数字（留空 = 不提醒）'));
      return;
    }
    if (n !== st[k]) void patch({ [k]: n });
    else setErr(null);
  };
  const clear = async () => {
    if (
      !window.confirm(
        t('清空全部 {0} 条用量记录？价格表和预算设置会保留，此操作不可撤销。', state.records),
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
          placeholder={t('不提醒')}
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
          <h3>{t('预算与提醒')}</h3>
          <Badge tone="neutral">{st.currency}</Badge>
        </header>
        <div className={styles.budgetGrid}>
          {field('dailyBudget', t('每日预算'), 'usage-budget-daily')}
          {field('monthlyBudget', t('每月预算'), 'usage-budget-monthly')}
          {field('taskAlert', t('单个任务花费提醒线'), 'usage-budget-task')}
        </div>
        <p className={styles.dim}>
          {t(
            '花费到预算的 80% 和 100% 时各提醒一次（看板娘气泡 + 灵动岛，只显示不朗读）。单个任务指同一会话连续使用，超过提醒线时提醒一次。留空 = 不提醒。',
          )}
        </p>
        <p className={styles.dim}>
          {t(
            '免打扰时不会弹出，等恢复后补提醒；未定价模型的用量不计入花费。金额按当前币种填写，切换币种时会按汇率换算。',
          )}
        </p>
      </section>

      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('隐私与数据')}</h3>
          <AppIcon icon={ShieldCheck} />
        </header>
        <div className={styles.switchCol}>
          <Switch
            checked={st.enabled}
            onChange={(v) => void patch({ enabled: v })}
            label={t('记录 Token 用量')}
            data-testid="usage-enabled"
          />
          <Switch
            checked={st.readToolLogs}
            disabled={!st.enabled}
            onChange={(v) => void patch({ readToolLogs: v })}
            label={t('读取本机编程工具的会话日志')}
            data-testid="usage-read-logs"
          />
          <Switch
            checked={st.activeQuotaRefresh}
            disabled={!st.enabled}
            onChange={(v) => void patch({ activeQuotaRefresh: v })}
            label={t('主动刷新额度（点「刷新」时让官方 CLI 去取）')}
            data-testid="usage-active-quota"
          />
        </div>
        <p className={styles.dim}>
          {t(
            '开启后，在额度卡点「刷新」且本机数据已过期时，才会临时启动 claude 或 codex（官方 CLI，用它自己的登录态取额度，Codex 会向 OpenAI 发一次请求）。从不自动轮询；关闭后刷新只重读本机已有的数据。',
          )}
        </p>
        <p className={styles.dim}>
          {t(
            '只提取时间、模型、Token 数和会话编号，不保存对话内容，也不读取任何账号凭据。关闭后仍会记录 Nomi 对话的用量。',
          )}
        </p>
        <label className={styles.budgetField}>
          <span>{t('记录保留时长')}</span>
          <Select
            size="sm"
            aria-label={t('记录保留时长')}
            data-testid="usage-retention"
            value={st.retention}
            onChange={(e) => void patch({ retention: e.target.value as UsageRetention })}
            options={[
              { value: '90d', label: t('90 天') },
              { value: '1y', label: t('1 年') },
              { value: 'forever', label: t('永久保留') },
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
            {t('清空用量记录')}
          </Button>
          <span className={styles.dim}>{t('当前 {0} 条记录', state.records)}</span>
        </div>
        <Notice tone="info" icon={ShieldCheck}>
          {t('所有用量数据只保存在这台电脑上：不上传、不做云同步，也没有排行榜或分享入口。')}
        </Notice>
      </section>
    </div>
  );
};
