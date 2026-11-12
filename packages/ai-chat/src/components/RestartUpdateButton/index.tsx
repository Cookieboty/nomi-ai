/**
 * Restart-to-update control: visible only when an update is downloaded and ready to install.
 * Used in the title bar (outside Settings) and in the settings nav footer.
 */
import { Button, Icon, t, useLocale } from '@nomi-ai/ui';
import { RefreshCw } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { api, hasTransport } from '../../services/api';
import { useUpdateState } from '../SettingsView/UpdateSettings';

import styles from './index.module.css';

export interface RestartUpdateButtonProps {
  /** Compact icon-only look (collapsed sidebar / collapsed settings nav). */
  collapsed?: boolean;
  /** Visual placement for styling hooks / tests. */
  placement: 'titlebar' | 'settings-nav';
  className?: string;
}

/** 主进程更新服务（`updates.install`）；没有契约传输时为 null */
function updatesApi(): { install: () => Promise<unknown> } | null {
  return hasTransport() ? { install: () => api.updates.install() } : null;
}

/** True when quitAndInstall can run (update file already on disk). */
export function isUpdateReadyToInstall(status: string | undefined): boolean {
  return status === 'downloaded';
}

export const RestartUpdateButton: React.FC<RestartUpdateButtonProps> = ({
  collapsed = false,
  placement,
  className,
}) => {
  useLocale();
  const [state, setState] = useUpdateState();
  const [busy, setBusy] = useState(false);
  const label = t('ui.mascot-theme.restart-to-update');
  const ready = isUpdateReadyToInstall(state?.status);
  const api = updatesApi();

  const onClick = useCallback(() => {
    if (!api || busy) return;
    setBusy(true);
    void api
      .install()
      .then((s) => {
        if (s && typeof s === 'object' && 'status' in (s as object)) {
          setState(s as Parameters<typeof setState>[0]);
        }
      })
      .finally(() => setBusy(false));
  }, [api, busy, setState]);

  if (!api || !ready) return null;

  if (placement === 'titlebar') {
    const version = state?.availableVersion;
    return (
      <button
        type="button"
        className={[styles.titlebarBtn, 'cd-motion-pop', className].filter(Boolean).join(' ')}
        onClick={onClick}
        disabled={busy}
        // 版本号进无障碍名，不用原生 title（图标按钮不加悬停提示，见 docs/development/frontend-standards.md）
        aria-label={version ? `${label} · v${version}` : label}
        data-testid="restart-update-titlebar"
      >
        <Icon icon={RefreshCw} size={14} />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div
      className={[styles.navWrap, collapsed ? styles.navCollapsed : '', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="restart-update-settings-wrap"
    >
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={onClick}
        data-testid="restart-update-settings"
        aria-label={label}
        className={styles.navBtn}
      >
        <Icon icon={RefreshCw} size={14} />
        {!collapsed && <span>{label}</span>}
      </Button>
    </div>
  );
};
