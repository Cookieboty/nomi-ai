/**
 * 编程助手的供应商（docs/design/unified-gateway.md §4.3）：侧栏底部信息卡里的「新标签默认」
 * （CliDefaultSource）——这个编程助手以后新开的标签用官方账号还是哪个第三方供应商。
 * 已有会话单独换供应商用 `/model`（services/cliSource 的 switchTabSource，主进程执行切换规则）；
 * 模型在输入栏的模型按钮里换（第三方时只列当前供应商的模型）。
 */
import { Select, t, type SelectOption } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import {
  codingProviders,
  providerEntryRef,
  providerLabel,
  providerOfRef,
  type CliKind,
} from '../../services/cliSource';
import { gatewayClient, gatewayClientAvailable } from '../../services/gatewayClient';
import { useGatewayState } from '../../services/nomiModel';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

const OFFICIAL = 'official';
const PROVIDER_PREFIX = 'provider:';

/**
 * 侧栏底部编程助手信息卡里的「新标签默认」：这个编程助手以后新开的标签用官方还是哪个第三方供应商
 * （网关 clients[kind].newTabSource + models.main，与「模型」页同一份设置）。只影响新标签，已有会话不变。
 */
export const CliDefaultSource: React.FC<{ backend: CliKind }> = ({ backend }) => {
  const gateway = useGatewayState();
  const [err, setErr] = useState('');
  const providers = useMemo(() => codingProviders(gateway), [gateway]);
  if (!gatewayClientAvailable() || !gateway) return null;
  const main = gateway.clients[backend]?.models.main ?? null;
  const third = gateway.clients[backend]?.newTabSource === 'thirdParty' && !!main;
  const current = third ? providerOfRef(main) : null;
  const options: SelectOption[] = [
    { value: OFFICIAL, label: backend === 'dsh' ? t('dsh 自带配置') : t('官方账号') },
    ...providers.map((p) => ({
      value: `${PROVIDER_PREFIX}${p.id}`,
      group: t('第三方供应商'),
      label: p.name,
    })),
  ];
  if (current && !providers.some((p) => p.id === current))
    options.push({
      value: `${PROVIDER_PREFIX}${current}`,
      group: t('第三方供应商'),
      label: providerLabel(gateway, current),
    });
  const pick = async (value: string) => {
    setErr('');
    try {
      if (value === OFFICIAL) {
        await gatewayClient.setAssignment(backend, { newTabSource: 'official' });
        return;
      }
      const ref = providerEntryRef(gateway, value.slice(PROVIDER_PREFIX.length), backend, main);
      if (!ref) return;
      await gatewayClient.setAssignment(backend, {
        newTabSource: 'thirdParty',
        ...(ref !== main ? { models: { main: ref } } : {}),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const name = ENDPOINT_NAME[backend];
  return (
    <span className={styles.defaultSource} data-testid="cli-default-source" data-backend={backend}>
      <span className={styles.defaultLabel}>{t('新标签默认')}</span>
      <Select
        size="sm"
        variant="ghost"
        className={styles.select}
        data-testid="cli-default-source-switch"
        aria-label={t('{0} 新标签默认用', name)}
        title={err || t('只影响以后新开的 {0} 标签，已有会话不变', name)}
        value={current ? `${PROVIDER_PREFIX}${current}` : OFFICIAL}
        onChange={(e) => void pick(e.target.value)}
        menuMinWidth={220}
        options={options}
      />
    </span>
  );
};
