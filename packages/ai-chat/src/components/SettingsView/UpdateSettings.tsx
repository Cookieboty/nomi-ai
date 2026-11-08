/**
 * 更新相关的共享部分：主进程更新服务（`updates.*`）、状态文案、订阅 hook，以及「关于」页里
 * 「更新设置」二次弹窗（启动时检查更新、更新后显示更新日志）。版本卡与检查 / 安装在 AboutSection。
 */
import { Modal, ModalHostContext, SettingRow, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';
import {
  getShowReleaseNotesAfterUpdate,
  setShowReleaseNotesAfterUpdate,
  subscribeShowReleaseNotesAfterUpdate,
} from '../../services/releaseNotesPrefs';

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
  /** 新版本还在发布（最新 Release 还没有本平台的更新文件）：按暂无更新显示，提示稍后再检查 */
  releasePending?: boolean;
}

export interface UpdatesApi {
  get: () => Promise<UpdateState>;
  check: () => Promise<UpdateState>;
  download: () => Promise<UpdateState>;
  install: () => Promise<UpdateState>;
  setAutoCheck: (on: boolean) => Promise<UpdateState>;
  onChanged: (cb: (s: UpdateState) => void) => () => void;
}

/** 主进程更新服务；没有契约传输（浏览器预览）时为 null */
export function updatesApi(): UpdatesApi | null {
  if (!hasTransport()) return null;
  const u = api.updates;
  return {
    get: () => u.get() as Promise<UpdateState>,
    check: () => u.check() as Promise<UpdateState>,
    download: () => u.download() as Promise<UpdateState>,
    install: () => u.install() as Promise<UpdateState>,
    setAutoCheck: (on) => u.setAutoCheck({ on }) as Promise<UpdateState>,
    onChanged: (cb) => api.on('updates.changed', (s) => cb(s as UpdateState)),
  };
}

export function statusLabel(s: UpdateState): string {
  switch (s.status) {
    case 'checking':
      return t('ui.mascot-theme.checking-for-updates');
    case 'available':
      return t('ui.mascot-theme.update-is-available').replace('{0}', s.availableVersion ?? '');
    case 'not-available':
      return s.releasePending
        ? t('ui.mascot-theme.new-version-still-publishing')
        : t('ui.mascot-theme.you-are-up-to-date');
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
    const a = updatesApi();
    if (!a) return undefined;
    void a.get().then(setState);
    return a.onChanged(setState);
  }, []);
  return [state, setState];
}

/** 主动操作（检查 / 安装 / 切换自动检查）：忙碌时禁用按钮，返回值写回状态 */
export function useUpdateRunner(setState: (s: UpdateState) => void) {
  const [busy, setBusy] = useState(false);
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
  return [busy, run] as const;
}

/** 「更新设置」二次弹窗：设置页内嵌的 ModalHost 在这里清掉，让它真的弹出来 */
export const UpdatePrefsModal: React.FC<{
  open: boolean;
  onClose: () => void;
  state: UpdateState | null;
  setState: (s: UpdateState) => void;
}> = ({ open, onClose, state, setState }) => {
  const [, run] = useUpdateRunner(setState);
  const [showReleaseNotes, setShowReleaseNotes] = useState(getShowReleaseNotesAfterUpdate);
  useEffect(
    () =>
      subscribeShowReleaseNotesAfterUpdate(() =>
        setShowReleaseNotes(getShowReleaseNotesAfterUpdate()),
      ),
    [],
  );
  const u = updatesApi();
  return (
    <ModalHostContext.Provider value={null}>
      <Modal
        open={open}
        onClose={onClose}
        title={t('ui.chat-settings.about-update-settings')}
        data-testid="updates-prefs-modal"
      >
        {u && (
          <SettingRow
            data-testid="updates-auto-check"
            title={t('ui.mascot-theme.check-for-updates-on-launch-and-periodically')}
            description={t('ui.mascot-theme.updates-come-from-github-releases-cookieboty-nomi-ai')}
          >
            <Switch
              checked={state?.autoCheck ?? true}
              disabled={!state || state.status === 'unavailable'}
              onChange={(on) => void run(() => u.setAutoCheck(on))}
              aria-label={t('ui.mascot-theme.check-for-updates-on-launch-and-periodically')}
            />
          </SettingRow>
        )}
        <SettingRow
          data-testid="updates-show-release-notes"
          title={t('ui.mascot-theme.show-release-notes-after-update')}
          description={t('ui.mascot-theme.show-release-notes-after-update-hint')}
        >
          <Switch
            checked={showReleaseNotes}
            onChange={(on) => {
              setShowReleaseNotesAfterUpdate(on);
              setShowReleaseNotes(on);
            }}
            aria-label={t('ui.mascot-theme.show-release-notes-after-update')}
          />
        </SettingRow>
      </Modal>
    </ModalHostContext.Provider>
  );
};
