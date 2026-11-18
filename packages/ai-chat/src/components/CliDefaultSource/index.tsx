/**
 * Agents 的供应商（docs/development/gateway.md）：侧栏底部信息卡里的「新标签默认」
 * （CliDefaultSource）——这个 agent 以后新开的标签默认用什么：官方账号（跟随默认或指定账号）/ 第三方供应商。
 * 已有会话单独换供应商用 `/model`（services/cliSource 的 switchTabSource，主进程执行切换规则）；
 * 模型在输入栏的模型按钮里换（第三方时按供应商分标签，也能直接换到别的供应商）。
 */
import { ModelPicker, Select, t } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import { useCliAccounts } from '../../hooks/useCliAccounts';
import { useHasLocalLogin } from '../../services/cliLauncherClient';
import {
  newTabOptions,
  newTabPatch,
  newTabSelectValue,
  singleCodingProvider,
  type CliKind,
} from '../../services/cliSource';
import { gatewayClient, gatewayClientAvailable } from '../../services/gatewayClient';
import { pickerProviders, useGatewayState } from '../../services/nomiModel';
import { thirdPartyOnly } from '../../utils/cliCaps';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

/**
 * 侧栏底部 agent 信息卡里的「新标签默认」：这个 agent 以后新开的标签默认用哪个官方账号 / 哪个第三方供应商
 * （网关 clients[kind]，与「模型」页同一份设置）。只影响新标签，已有会话不变。
 */
export const CliDefaultSource: React.FC<{ backend: CliKind }> = ({ backend }) => {
  const gateway = useGatewayState();
  const { accounts, error: accountsError } = useCliAccounts(backend);
  const localAvailable = useHasLocalLogin(backend);
  const picker = useMemo(() => pickerProviders(gateway?.providers ?? []), [gateway]);
  const [err, setErr] = useState('');
  if (!gatewayClientAvailable() || !gateway) return null;
  const client = gateway.clients[backend];
  const ctx = { kind: backend, client, gateway, accounts, localAvailable };
  const options = newTabOptions(ctx);
  const value = newTabSelectValue(client, backend, ctx);
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
  const pickThirdPartyModel = async (ref: string) => {
    setErr('');
    try {
      await gatewayClient.setAssignment(backend, {
        models: { main: ref },
        newTabSource: 'thirdParty',
        newTabAccountId: null,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const name = ENDPOINT_NAME[backend];
  const tpOnly = thirdPartyOnly(backend);
  const pickerValue = client?.models.main ?? singleCodingProvider(gateway)?.models[0]?.ref ?? null;
  return (
    <span className={styles.defaultSource} data-testid="cli-default-source" data-backend={backend}>
      <span className={styles.defaultLabel}>{t('ui.chat-settings.new-sessions-use')}</span>
      {tpOnly && picker.length > 0 ? (
        <ModelPicker
          providers={picker}
          purpose="coding"
          size="sm"
          browse
          value={pickerValue}
          onChange={(v) => void pickThirdPartyModel(v)}
          placeholder={t('ui.models.choose-a-model')}
          aria-label={t('ui.models.new-sessions-use-named', name)}
          data-testid="cli-default-source-switch"
        />
      ) : (
        <Select
          size="sm"
          variant="ghost"
          className={styles.select}
          data-testid="cli-default-source-switch"
          aria-label={t('ui.models.new-sessions-use-named', name)}
          title={
            err ||
            (accountsError
              ? t('ui.models.failed-to-load-accounts', accountsError)
              : t('ui.chat-settings.only-affects-sessions-opened-from-now-on', name))
          }
          value={value}
          onChange={(e) => void pick(e.target.value)}
          menuMinWidth={240}
          options={options}
        />
      )}
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
