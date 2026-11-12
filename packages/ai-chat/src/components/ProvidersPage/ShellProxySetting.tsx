/**
 * 设置 →「编程助手」→「通用」：沿用终端里的代理（https_proxy）。
 * 对所有编程助手生效（登录与对话），所以放在「通用」，不在每个编程助手的官方账号里各放一份。
 */
import { SettingRow, Switch, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { cliAccountClient, type CliNetworkState } from '../../services/cliAccountClient';

import styles from './index.module.css';

export const ShellProxySetting: React.FC = () => {
  const [network, setNetwork] = useState<CliNetworkState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void cliAccountClient
      .network()
      .then((n) => alive && setNetwork(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!network) return null;

  const change = (on: boolean) => {
    setErr(null);
    void cliAccountClient
      .setNetwork(on)
      .then(setNetwork)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };

  return (
    <details className={styles.fold} data-testid="cli-network-shell-proxy-fold">
      <summary className={styles.foldSummary}>
        {t('ui.chat-settings.use-the-terminal-s-proxy')}
      </summary>
      <SettingRow
        data-testid="cli-network-shell-proxy"
        title={t('ui.chat-settings.use-the-terminal-s-proxy')}
        description={
          <>
            {t('ui.chat-settings.use-the-terminal-s-proxy-desc')}{' '}
            {network.shellProxy
              ? t('ui.chat-settings.terminal-proxy-detected', network.shellProxy)
              : t('ui.chat-settings.terminal-proxy-not-found')}
          </>
        }
      >
        <Switch
          checked={network.useShellProxy}
          onChange={change}
          label={t('ui.chat-settings.use-the-terminal-s-proxy')}
          data-testid="cli-network-shell-proxy-switch"
        />
      </SettingRow>
      {err && <p className={styles.sub}>{err}</p>}
    </details>
  );
};
