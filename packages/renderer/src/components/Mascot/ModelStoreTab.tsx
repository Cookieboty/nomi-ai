import type { ModelDownloadProgress, StoreEntryView, StoreStateView } from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Notice } from '@nomi-ai/ui';
import { PackageOpen, Store } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import styles from './style.module.css';

import { useMascot } from '@/contexts/MascotContext';
import { conditionsText, licenseLabel } from '@/mascot/licenseTerms';

const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).host : '—';
  } catch {
    return '—';
  }
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** 模型商店：远程目录（只含开源许可模型），下载带进度 + sha256 校验，可更新 / 删除。 */
export const ModelStoreTab: React.FC = () => {
  const api = window.electronAPI?.models;
  const { state: mascot, selectModel } = useMascot();
  const [state, setState] = useState<StoreStateView | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Record<string, ModelDownloadProgress>>({});

  const load = useCallback(
    async (refresh: boolean) => {
      if (!api) return;
      setLoading(true);
      try {
        setState(await api.storeState(refresh));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    // 挂载 / api 变化时初次拉取 + 订阅后端变更/进度：属于外部数据同步，豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    void load(true);
    const offP = api?.onProgress((p) => setProgress((prev) => ({ ...prev, [p.id]: p })));
    const offC = api?.onChanged(() => void load(false));
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      offP?.();
      offC?.();
    };
  }, [api, load]);

  if (!api) return <EmptyState icon={Store} title={t('模型商店仅在桌面应用中可用')} />;

  const install = async (e: StoreEntryView) => {
    setProgress((p) => ({
      ...p,
      [e.id]: { id: e.id, received: 0, total: e.size, state: 'downloading' },
    }));
    await api.install(e.id);
  };

  return (
    <div data-testid="model-store">
      <div className={styles.storeBar}>
        <span className={styles.credit}>
          {state?.offline
            ? t('离线：显示缓存的目录')
            : t('目录：{0}', hostOf(state?.catalogUrls[0]))}
          {state?.fetchedAt ? ` · ${new Date(state.fetchedAt).toLocaleString()}` : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load(true)}
          data-testid="store-refresh"
        >
          {loading ? t('刷新中…') : t('刷新')}
        </Button>
      </div>
      {!state && loading && <LoadingState rows={3} data-testid="store-loading" />}
      {state?.error && !state.entries.length && (
        <ErrorState
          data-testid="store-error"
          title={t('无法获取模型目录')}
          detail={state.error}
          onRetry={() => void load(true)}
          retrying={loading}
          retryTestId="store-error-retry"
        />
      )}
      {!!state?.rejectedCount && (
        <Notice tone="warning">
          {t('已忽略')} {state.rejectedCount} {t('个不符合许可 / 安全要求的条目。')}
        </Notice>
      )}
      {state && !state.entries.length && !state.error && (
        <EmptyState icon={PackageOpen} title={t('目录为空')} />
      )}
      <div className={styles.storeList}>
        {state?.entries.map((e) => {
          const p = progress[e.id];
          const busy = e.downloading || p?.state === 'downloading' || p?.state === 'verifying';
          const installed =
            !!e.installedVersion ||
            mascot.modelList.some((m) => m.name === e.id && m.origin === 'bundled');
          const pct = p && p.total ? Math.round((p.received / p.total) * 100) : 0;
          return (
            <div key={e.id} className={styles.storeItem} data-testid={`store-item-${e.id}`}>
              {e.thumbnailUrl ? (
                <img src={e.thumbnailUrl} alt={t(e.name)} className={styles.thumb} />
              ) : (
                <div className={styles.thumb} />
              )}
              <div className={styles.storeInfo}>
                <div className={styles.creditHead}>
                  <strong>{t(e.name)}</strong>
                  <Badge tone={e.licenseTerms ? 'warning' : 'success'}>
                    {licenseLabel(e.license)}
                  </Badge>
                  <Badge tone="neutral">v{e.version}</Badge>
                  {e.updateAvailable && <Badge tone="accent">{t('有更新')}</Badge>}
                </div>
                <div className={styles.creditMeta}>
                  {e.author} · VRM {e.vrmVersion} · {mb(e.size)}
                </div>
                {e.licenseTerms && (
                  <div className={styles.creditMeta} data-testid={`store-terms-${e.id}`}>
                    {conditionsText(e.licenseTerms)}
                  </div>
                )}
                {busy && (
                  <div
                    className={styles.progress}
                    role="progressbar"
                    aria-valuenow={pct}
                    data-testid={`store-progress-${e.id}`}
                  >
                    <div style={{ width: `${pct}%` }} />
                  </div>
                )}
                {p?.state === 'error' && (
                  <ErrorState
                    compact
                    data-testid={`store-download-error-${e.id}`}
                    title={t('下载失败')}
                    detail={p.error}
                    onRetry={() => void install(e)}
                    retryTestId={`store-retry-${e.id}`}
                  />
                )}
              </div>
              <div className={styles.storeActions}>
                {busy ? (
                  <Button size="sm" variant="ghost" onClick={() => void api.cancel(e.id)}>
                    {t('取消')}
                  </Button>
                ) : e.installedVersion ? (
                  <>
                    {e.updateAvailable && (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void install(e)}
                        data-testid={`store-update-${e.id}`}
                      >
                        {t('更新')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => selectModel(e.id)}
                      data-testid={`store-use-${e.id}`}
                    >
                      {t('使用')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void api.remove(e.id)}
                      data-testid={`store-remove-${e.id}`}
                    >
                      {t('删除')}
                    </Button>
                  </>
                ) : installed ? (
                  <Badge tone="neutral">{t('已内置')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void install(e)}
                    data-testid={`store-install-${e.id}`}
                  >
                    {t('下载')}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
