/**
 * 「模型」页顶部的模型数据同步（docs/design/unified-gateway.md §12.7.2）：从 models.dev 下载公开数据，
 * 一次同时更新模型参数（上下文、输出上限、标准窗口，供编程助手注入与「模型」页显示）和价格表。
 * 启动时自动同步（距上次核对超过 12 小时，可关闭），也可以手动「立即同步」。
 */
import { Button, Icon, Switch, t } from '@nomi-ai/ui';
import { Database } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import type { GatewayState } from '../../services/gatewayClient';
import {
  usageClient,
  usageClientAvailable,
  type UsagePriceSyncResult,
  type UsageState,
} from '../../services/usageClient';
import { formatDateTime, syncFailureReason } from '../UsagePanel/format';

import styles from './index.module.css';

const resultText = (r: UsagePriceSyncResult): string =>
  r.ok
    ? r.status === 'not-modified'
      ? t('ui.models.models-data-up-to-date')
      : t('ui.models.models-data-synced')
    : t('ui.models.models-data-sync-failed', syncFailureReason(r));

export const ModelsDataSyncCard: React.FC<{ gateway: GatewayState | null }> = ({ gateway }) => {
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!usageClientAvailable()) return;
    let alive = true;
    void usageClient
      .state()
      .then((s) => alive && setUsage(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!usage) return null;
  const sync = usage.pricing.sync;
  const catalog = gateway?.catalog;
  const auto = usage.settings.modelsSyncAuto !== false;

  const runSync = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      const { result, ...next } = await usageClient.syncPrices();
      setUsage(next as UsageState);
      setMsg({ ok: result.ok, text: resultText(result) });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSyncing(false);
    }
  };
  const setAuto = (v: boolean) =>
    void usageClient
      .setSettings({ modelsSyncAuto: v })
      .then((settings) => setUsage((u) => (u ? { ...u, settings } : u)))
      .catch((e: unknown) => setMsg({ ok: false, text: String(e) }));

  return (
    <section className={styles.card} aria-labelledby="models-data" data-testid="models-data-sync">
      <div className={styles.cardHeadRow}>
        <h3 id="models-data" className={styles.cardTitle}>
          <Icon icon={Database} size={16} />
          {t('ui.models.models-data')}
        </h3>
        <Button
          size="sm"
          onClick={() => void runSync()}
          disabled={syncing}
          data-testid="models-data-sync-now"
        >
          {syncing ? t('ui.usage-tools.syncing') : t('ui.models.sync-now')}
        </Button>
      </div>
      <p className={styles.sub} data-testid="models-data-status">
        {catalog
          ? catalog.synced
            ? t('ui.models.models-data-synced-status', catalog.version, catalog.models)
            : t('ui.models.models-data-builtin-status', catalog.version, catalog.models)
          : null}
        {sync?.checkedAt ? ` · ${t('ui.models.last-checked', formatDateTime(sync.checkedAt))}` : ''}
      </p>
      <p className={styles.sub}>{t('ui.models.models-data-note')}</p>
      <label className={styles.inlineSwitch}>
        <Switch
          checked={auto}
          onChange={setAuto}
          aria-label={t('ui.models.sync-on-startup')}
          data-testid="models-data-auto"
        />
        <span>{t('ui.models.sync-on-startup')}</span>
      </label>
      {msg && (
        <p
          className={msg.ok ? styles.okText : styles.errText}
          role="status"
          data-testid="models-data-result"
        >
          {msg.text}
        </p>
      )}
    </section>
  );
};
