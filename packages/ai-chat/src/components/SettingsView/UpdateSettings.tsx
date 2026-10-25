/**
 * Settings → General → 关于与更新: version + check / download / install (with consent) + auto-check,
 * plus extra rows passed as children (onboarding). Talks to main-process UpdateService over
 * window.electronAPI.updates. `useUpdateState` is shared with the hero card's version cell.
 */
import { Button, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
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

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string | null;
  percent?: number;
  error?: string;
  /** 失败在哪一步：检查 / 下载 / 安装 */
  errorStage?: 'check' | 'download' | 'install';
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

export function statusLabel(s: UpdateState): string {
  switch (s.status) {
    case 'checking':
      return t('ui.mascot-theme.checking-for-updates');
    case 'available':
      return t('ui.mascot-theme.update-is-available').replace('{0}', s.availableVersion ?? '');
    case 'not-available':
      return t('ui.mascot-theme.you-are-up-to-date');
    case 'downloading':
      return t('ui.mascot-theme.downloading-update').replace(
        '{0}',
        String(Math.round(s.percent ?? 0)),
      );
    case 'downloaded':
      return t('ui.mascot-theme.update-downloaded-restart-to-install');
    case 'error':
      return (
        s.errorStage === 'download'
          ? t('ui.mascot-theme.update-download-failed-detail')
          : s.errorStage === 'install'
            ? t('ui.mascot-theme.update-install-failed-detail')
            : t('ui.mascot-theme.update-check-failed')
      ).replace('{0}', s.error ?? '');
    case 'unavailable':
      return t('ui.mascot-theme.auto-update-is-only-available-in-installed-builds');
    default:
      return t('ui.mascot-theme.not-checked-yet');
  }
}

/** 主进程更新状态（订阅变化）；没有桌面桥时为 null。第二项用来写入主动操作的返回值 */
export function useUpdateState(): [UpdateState | null, (s: UpdateState) => void] {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const a = api();
    if (!a) return undefined;
    void a.get().then(setState);
    return a.onChanged(setState);
  }, []);
  return [state, setState];
}

export const UpdateSettings: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useUpdateState();
  const [busy, setBusy] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<UpdateState>) => {
      setBusy(true);
      try {
        setState(await fn());
      } finally {
        setBusy(false);
      }
    },
    [setState],
  );

  if (!api()) {
    return (
      <SettingsGroup title={t('ui.chat-settings.about-updates')} data-testid="settings-updates">
        <p className={styles.muted}>
          {t('ui.mascot-theme.updates-are-only-available-in-the-desktop-app')}
        </p>
        {children}
      </SettingsGroup>
    );
  }

  const s = state;
  const canCheck = !busy && s && s.status !== 'checking' && s.status !== 'downloading';
  const canInstall = !busy && s?.status === 'downloaded';

  return (
    <SettingsGroup
      title={t('ui.chat-settings.about-updates')}
      data-testid="settings-updates"
      id="settings-updates"
    >
      <SettingRow
        title={
          <>
            {t('ui.mascot-theme.current-version')}{' '}
            <strong data-testid="updates-current-version">{s?.currentVersion ?? '…'}</strong>
            {s?.availableVersion ? (
              <>
                {' · '}
                {t('ui.mascot-theme.latest')}{' '}
                <strong data-testid="updates-available-version">{s.availableVersion}</strong>
              </>
            ) : null}
          </>
        }
        description={
          <span data-testid="updates-status">
            {s ? statusLabel(s) : t('ui.mascot-theme.loading')}
          </span>
        }
      >
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!canCheck}
          data-testid="updates-check"
          onClick={() => void run(() => api()!.check())}
        >
          {/* 失败后重新检查会接着重新下载（主进程先取消卡住的下载） */}
          {s?.status === 'error'
            ? t('ui.mascot-theme.retry')
            : t('ui.mascot-theme.check-for-updates')}
        </Button>
        {canInstall && !confirmInstall && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="updates-install"
            onClick={() => setConfirmInstall(true)}
          >
            {t('ui.mascot-theme.restart-and-install')}
          </Button>
        )}
      </SettingRow>
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
      {confirmInstall && (
        <div className={styles.confirm} data-testid="updates-install-confirm">
          <p className={styles.note}>
            {t('ui.mascot-theme.nomi-will-quit-and-install-conversations-stay-on').replace(
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
              {t('ui.mascot-theme.install-now')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="updates-install-no"
              onClick={() => setConfirmInstall(false)}
            >
              {t('ui.foundation.cancel')}
            </Button>
          </div>
        </div>
      )}
      <SettingRow
        data-testid="updates-auto-check"
        title={t('ui.mascot-theme.check-for-updates-on-launch-and-periodically')}
        description={t('ui.mascot-theme.updates-come-from-github-releases-cookieboty-nomi-ai')}
      >
        <Switch
          checked={s?.autoCheck ?? true}
          disabled={!s || s.status === 'unavailable'}
          onChange={(on) => void run(() => api()!.setAutoCheck(on))}
          aria-label={t('ui.mascot-theme.check-for-updates-on-launch-and-periodically')}
        />
      </SettingRow>
      {children}
    </SettingsGroup>
  );
};
