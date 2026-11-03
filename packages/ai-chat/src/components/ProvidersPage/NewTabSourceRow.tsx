/**
 * 编程助手详情里的「新会话默认用」：新建这个助手的标签时默认用本机登录、某个官方账号，还是某家第三方供应商
 * （原来在「模型」页的编程助手表格里；那里现在只设第三方模型）。选项与写入规则在 services/cliSource.ts。
 */
import { Select, SettingRow, t } from '@nomi-ai/ui';
import React from 'react';

import { useCliAccounts } from '../../hooks/useCliAccounts';
import {
  newTabOptions,
  newTabPatch,
  newTabSelectValue,
  type CliKind,
} from '../../services/cliSource';
import { gatewayClient } from '../../services/gatewayClient';
import { useGatewayState } from '../../services/nomiModel';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

export const NewTabSourceRow: React.FC<{ kind: CliKind }> = ({ kind }) => {
  const gateway = useGatewayState();
  const { accounts, error } = useCliAccounts(kind);
  const [saveErr, setSaveErr] = React.useState<string | null>(null);
  if (!gateway) return null;
  const name = t(ENDPOINT_NAME[kind]);
  const client = gateway.clients[kind];
  const ctx = { kind, client, gateway, accounts };
  const pick = (value: string) => {
    const patch = newTabPatch(value, ctx);
    if (!patch) return;
    setSaveErr(null);
    gatewayClient
      .setAssignment(kind, patch as Parameters<typeof gatewayClient.setAssignment>[1])
      .catch((e: unknown) => setSaveErr(e instanceof Error ? e.message : String(e)));
  };
  const problem = saveErr ?? (error ? t('ui.models.failed-to-load-accounts', error) : null);
  return (
    <SettingRow
      title={t('ui.models.new-sessions-use')}
      description={
        <>
          {t('ui.providers-schedule.new-tab-source-hint', name)}
          {problem && (
            <span className={styles.rowError} data-testid={`cli-accounts-error-${kind}`}>
              {problem}
            </span>
          )}
        </>
      }
    >
      <Select
        size="sm"
        options={newTabOptions(ctx)}
        value={newTabSelectValue(client, kind)}
        onChange={(e) => pick(e.target.value)}
        aria-label={t('ui.models.new-sessions-use-named', ENDPOINT_NAME[kind])}
        data-testid={`cli-source-${kind}`}
        menuMinWidth={240}
      />
    </SettingRow>
  );
};
