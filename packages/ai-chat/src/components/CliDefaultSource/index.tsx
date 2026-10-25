/**
 * 编程助手的供应商（docs/design/unified-gateway.md §4.3）：侧栏底部信息卡里的「新标签默认」
 * （CliDefaultSource）——这个编程助手以后新开的标签默认用什么：默认（本机登录）/ 官方账号（可指定账号）/ 第三方供应商。
 * 已有会话单独换供应商用 `/model`（services/cliSource 的 switchTabSource，主进程执行切换规则）；
 * 模型在输入栏的模型按钮里换（第三方时只列当前供应商的模型）。
 */
import { Select, t } from '@nomi-ai/ui';
import React, { useState } from 'react';

import { useCliAccounts } from '../../hooks/useCliAccounts';
import {
  newTabOptions,
  newTabPatch,
  newTabSelectValue,
  type CliKind,
} from '../../services/cliSource';
import { gatewayClient, gatewayClientAvailable } from '../../services/gatewayClient';
import { useGatewayState } from '../../services/nomiModel';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

/**
 * 侧栏底部编程助手信息卡里的「新标签默认」：这个编程助手以后新开的标签默认用本机登录 / 哪个官方账号 / 哪个第三方供应商
 * （网关 clients[kind]，与「模型」页同一份设置）。只影响新标签，已有会话不变。
 */
export const CliDefaultSource: React.FC<{ backend: CliKind }> = ({ backend }) => {
  const gateway = useGatewayState();
  const { accounts, error: accountsError } = useCliAccounts(backend);
  const [err, setErr] = useState('');
  if (!gatewayClientAvailable() || !gateway) return null;
  const client = gateway.clients[backend];
  const ctx = { kind: backend, client, gateway, accounts };
  const options = newTabOptions(ctx);
  const value = newTabSelectValue(client, backend);
  const pick = async (next: string) => {
    setErr('');
    const patch = newTabPatch(next, ctx);
    if (!patch) return;
    try {
      await gatewayClient.setAssignment(backend, patch);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const name = ENDPOINT_NAME[backend];
  return (
    <span className={styles.defaultSource} data-testid="cli-default-source" data-backend={backend}>
      <span className={styles.defaultLabel}>{t('ui.chat-settings.new-tabs-use')}</span>
      <Select
        size="sm"
        variant="ghost"
        className={styles.select}
        data-testid="cli-default-source-switch"
        aria-label={t('ui.models.new-tabs-use-named', name)}
        title={
          err ||
          (accountsError
            ? t('ui.models.failed-to-load-accounts', accountsError)
            : t('ui.chat-settings.only-affects-tabs-opened-from-now-on-existing', name))
        }
        value={value}
        onChange={(e) => void pick(e.target.value)}
        menuMinWidth={240}
        options={options}
      />
      {accountsError ? (
        <span
          className={styles.defaultError}
          data-testid="cli-default-accounts-error"
          role="status"
        >
          {t('ui.models.failed-to-load-accounts', accountsError)}
        </span>
      ) : null}
    </span>
  );
};
