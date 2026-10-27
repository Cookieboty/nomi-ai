/**
 * Restart-to-update control: visible only when an update is downloaded and ready to install.
 * Used next to the workbench Settings entry and in the settings nav footer.
 */
import { Button, Icon, t, useLocale } from '@nomi-ai/ui';
import { RefreshCw } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { useUpdateState } from '../SettingsView/UpdateSettings';

import styles from './index.module.css';

export interface RestartUpdateButtonProps {
  /** Compact icon-only look (collapsed sidebar / collapsed settings nav). */
  collapsed?: boolean;
  /** Visual placement for styling hooks / tests. */
  placement: 'sidebar' | 'settings-nav';
  className?: string;
}

function updatesApi() {
  const w = window as unknown as {
    electronAPI?: { updates?: { install: () => Promise<unknown> } };
  };
  return w.electronAPI?.updates ?? null;
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

  if (placement === 'sidebar') {
    return (
      <button
        type="button"
        className={[styles.sidebarBtn, collapsed ? '' : styles.sidebarExpanded, className]
          .filter(Boolean)
          .join(' ')}
        onClick={onClick}
        disabled={busy}
        title={label}
        aria-label={label}
        data-testid="restart-update-sidebar"
      >
        <Icon icon={RefreshCw} size={16} />
        {!collapsed && <span>{label}</span>}
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
        title={label}
        className={styles.navBtn}
      >
        <Icon icon={RefreshCw} size={14} />
        {!collapsed && <span>{label}</span>}
      </Button>
    </div>
  );
};
