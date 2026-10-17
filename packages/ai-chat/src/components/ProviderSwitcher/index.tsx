/**
 * 工具栏上的 provider 一键切换（与托盘菜单、面板共享主进程状态，实时同步）。
 */
import { t, Icon } from '@nomi-ai/ui';
import { IconButton, Select } from '@nomi-ai/ui';
import { KeyRound } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import {
  providerClient,
  providerClientAvailable,
  selectableModels,
  selectableProviders,
  type ProviderState,
} from '../../services/providerClient';
import { Monogram } from '../ProviderPanel/shared';

const SWITCHER_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--cd-space-1)',
};

export const ProviderSwitcher: React.FC<{ onManage: () => void; className?: string }> = ({
  onManage,
  className,
}) => {
  const [state, setState] = useState<ProviderState | null>(null);
  const available = providerClientAvailable();

  useEffect(() => {
    if (!available) return;
    providerClient
      .state()
      .then(setState)
      .catch(() => setState(null));
    return providerClient.onChanged(setState);
  }, [available]);

  if (!available || !state) return null;
  const options = selectableProviders(state);
  const current = state.effectiveProviderId;
  const models = selectableModels(state, current);
  const model = state.effectiveModel ?? models[0] ?? '';
  const defaultModel = state.providers.find((p) => p.id === current)?.defaultModel;
  return (
    <span className={className} data-testid="provider-switcher" style={SWITCHER_STYLE}>
      <Select
        size="sm"
        style={{ width: 'auto', maxWidth: 200 }}
        data-testid="provider-switch"
        aria-label={t('供应商')}
        value={current ?? ''}
        disabled={Boolean(state.overrideId)}
        title={state.overrideId ? t('已被 NOMI_PROVIDER 锁定') : t('切换供应商（立即生效）')}
        onChange={(e) =>
          void providerClient.setActive(e.target.value || null).catch(() => undefined)
        }
        placeholder={t('（未配置）')}
        menuMinWidth={220}
        options={options.map((o) => ({
          value: o.id,
          label: o.label,
          disabled: o.disabled,
          group: o.group,
          icon: <Monogram name={t(o.label)} brand={o.brand} size={18} />,
        }))}
      />
      <Select
        size="sm"
        style={{ width: 'auto', maxWidth: 220 }}
        data-testid="model-switch"
        aria-label={t('模型')}
        title={t('切换模型（立即生效）')}
        value={model}
        disabled={!current || Boolean(state.overrideId) || models.length === 0}
        onChange={(e) =>
          current && void providerClient.setActive(current, e.target.value).catch(() => undefined)
        }
        placeholder={t('（默认）')}
        menuMinWidth={240}
        options={models.map((m) => ({
          value: m,
          label: m,
          description: m === defaultModel ? t('默认') : undefined,
        }))}
      />
      <IconButton
        size="sm"
        data-testid="open-provider-panel"
        onClick={onManage}
        label={t('供应商与 Token 管理')}
        icon={<Icon icon={KeyRound} />}
      />
    </span>
  );
};
