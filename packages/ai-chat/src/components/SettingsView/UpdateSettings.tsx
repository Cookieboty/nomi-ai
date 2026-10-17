/**
 * Settings → General → Updates: check / download / install (with consent) + auto-check toggle.
 * Talks to main-process UpdateService over window.electronAPI.updates.
 */
import { Button, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import styles from './index.module.css';

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unavailable';

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string | null;
  percent?: number;
  error?: string;
  checkedAt?: number;
  autoCheck: boolean;
}

interface UpdatesApi {
  get: () => Promise<UpdateState>;
  check: () => Promise<UpdateState>;
  download: () => Promise<UpdateState>;
  install: () => Promise<UpdateState>;
  setAutoCheck: (on: boolean) => Promise<UpdateState>;
  onChanged: (cb: (s: UpdateState) => void) => () => void;
}

function api(): UpdatesApi | null {
  const w = window as unknown as { electronAPI?: { updates?: UpdatesApi } };
  return w.electronAPI?.updates ?? null;
}

function statusLabel(s: UpdateState): string {
  switch (s.status) {
    case 'checking':
      return t('正在检查更新…');
    case 'available':
      return t('发现新版本 {0}').replace('{0}', s.availableVersion ?? '');
    case 'not-available':
      return t('已是最新版本');
    case 'downloading':
      return t('正在下载更新… {0}%').replace('{0}', String(Math.round(s.percent ?? 0)));
    case 'downloaded':
      return t('更新已下载，重启后安装');
    case 'error':
      return t('检查更新失败：{0}').replace('{0}', s.error ?? '');
    case 'unavailable':
      return t('自动更新仅在安装版中可用（开发模式请从源码运行）');
    default:
      return t('尚未检查');
  }
}

export const UpdateSettings: React.FC = () => {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);

  useEffect(() => {
    const a = api();
    if (!a) return undefined;
    void a.get().then(setState);
    return a.onChanged(setState);
  }, []);

  const run = useCallback(async (fn: () => Promise<UpdateState>) => {
    setBusy(true);
    try {
      setState(await fn());
    } finally {
      setBusy(false);
    }
  }, []);

  if (!api()) {
    return (
      <section className={styles.block} data-testid="settings-updates">
        <h2 className={styles.h2}>{t('更新')}</h2>
        <p className={styles.muted}>{t('更新服务不可用（仅在桌面应用中提供）。')}</p>
      </section>
    );
  }

  const s = state;
  const canCheck = !busy && s && s.status !== 'checking' && s.status !== 'downloading';
  const canInstall = !busy && s?.status === 'downloaded';

  return (
    <section className={styles.block} data-testid="settings-updates">
      <h2 className={styles.h2}>{t('更新')}</h2>
      <p className={styles.muted}>
        {t('当前版本')}{' '}
        <strong data-testid="updates-current-version">{s?.currentVersion ?? '…'}</strong>
        {s?.availableVersion ? (
          <>
            {' · '}
            {t('最新')}{' '}
            <strong data-testid="updates-available-version">{s.availableVersion}</strong>
          </>
        ) : null}
      </p>
      <p className={styles.note} data-testid="updates-status">
        {s ? statusLabel(s) : t('加载中…')}
      </p>
      {s?.status === 'downloading' && (
        <div
          className={styles.updateBar}
          role="progressbar"
          aria-valuenow={Math.round(s.percent ?? 0)}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid="updates-progress"
        >
          <div className={styles.updateBarFill} style={{ width: `${s.percent ?? 0}%` }} />
        </div>
      )}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!canCheck}
          data-testid="updates-check"
          onClick={() => void run(() => api()!.check())}
        >
          {t('检查更新')}
        </Button>
        {canInstall && !confirmInstall && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="updates-install"
            onClick={() => setConfirmInstall(true)}
          >
            {t('重启并安装')}
          </Button>
        )}
      </div>
      {confirmInstall && (
        <div className={styles.confirm} data-testid="updates-install-confirm">
          <p className={styles.note}>
            {t('将退出 Nomi 并安装 {0}。未保存的对话会保留在本地，但当前窗口会关闭。').replace(
              '{0}',
              s?.availableVersion ?? '',
            )}
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              data-testid="updates-install-yes"
              onClick={() => {
                setConfirmInstall(false);
                void run(() => api()!.install());
              }}
            >
              {t('确认安装')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="updates-install-no"
              onClick={() => setConfirmInstall(false)}
            >
              {t('取消')}
            </Button>
          </div>
        </div>
      )}
      <label className={styles.row} data-testid="updates-auto-check">
        <span>{t('启动时与定期自动检查更新')}</span>
        <Switch
          checked={s?.autoCheck ?? true}
          disabled={!s || s.status === 'unavailable'}
          onChange={(on) => void run(() => api()!.setAutoCheck(on))}
          aria-label={t('启动时与定期自动检查更新')}
        />
      </label>
      <p className={styles.muted}>
        {t('更新来自 GitHub Releases（Cookieboty/nomi-ai），下载完成后需你确认才会安装。')}
      </p>
    </section>
  );
};
