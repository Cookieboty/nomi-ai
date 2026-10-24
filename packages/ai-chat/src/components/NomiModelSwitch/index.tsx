/**
 * 输入栏工具行：Nomi 对话的模型一键切换（统一网关的 clients.nomi.models.main，
 * 与托盘、斜杠命令 /model、设置 →「模型」页共享，实时同步）。
 * 与编程助手标签的模型按钮（ModelControls）同位置、同形（胶囊、ms 高）。
 */
import { ModelPicker, t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import { gatewayClientAvailable } from '../../services/gatewayClient';
import {
  nomiMainRef,
  pickerProviders,
  setNomiModel,
  useGatewayState,
} from '../../services/nomiModel';
import {
  effectiveProviderLabel,
  providerClient,
  providerClientAvailable,
  type ProviderState,
} from '../../services/providerClient';

import styles from './index.module.css';

export const NomiModelSwitch: React.FC<{ className?: string }> = ({ className }) => {
  const state = useGatewayState();
  const providers = useMemo(() => pickerProviders(state?.providers ?? []), [state]);
  // NOMI_PROVIDER 环境变量锁定时，网关的分配不生效
  const [override, setOverride] = useState<string | null>(null);
  // 网关里还没分配时，对话由旧存储路由（如环境变量供应商）：显示它，不显示「未配置」
  const [legacyLabel, setLegacyLabel] = useState<string | undefined>();
  useEffect(() => {
    if (!providerClientAvailable()) return;
    const apply = (s: ProviderState) => {
      setOverride(s.overrideId ?? null);
      setLegacyLabel(effectiveProviderLabel());
    };
    providerClient
      .state()
      .then(apply)
      .catch(() => undefined);
    return providerClient.onChanged(apply);
  }, []);

  if (!gatewayClientAvailable() || !state) return null;
  return (
    <span
      className={[styles.switch, className].filter(Boolean).join(' ')}
      data-testid="nomi-model-switch"
    >
      <ModelPicker
        variant="chip"
        className={styles.picker}
        providers={providers}
        // 锁定时不显示网关分配（实际不生效），占位显示锁定的 provider（#91）
        value={override ? null : nomiMainRef(state)}
        onChange={(ref) => void setNomiModel(ref).catch(() => undefined)}
        disabled={Boolean(override) || !providers.length}
        placeholder={legacyLabel ?? (providers.length ? t('选择模型') : t('（未配置）'))}
        aria-label={override ? t('已被 NOMI_PROVIDER 锁定') : t('Nomi 对话的模型')}
        data-testid="nomi-model-picker"
      />
    </span>
  );
};
