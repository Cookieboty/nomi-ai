/** 第三方供应商单独成行；同名模型直接换供应商，否则先到目标供应商选模型。 */
import { BrandIcon, t, type PickerProvider } from '@nomi-ai/ui';
import React from 'react';

import { splitRef } from '../../services/nomiModel';

import type { ProviderPageSource } from './ModelEffortChip';

export function thirdPartyProviderSource(
  providers: PickerProvider[],
  ref: string | null,
  onPick: (ref: string) => 'effort' | 'close',
): ProviderPageSource | null {
  if (!providers.length) return null;
  const current = ref ? splitRef(ref) : null;
  const name =
    providers.find((p) => p.id === current?.provider)?.name ??
    current?.provider ??
    t('ui.providers-schedule.not-configured');
  return {
    title: t('ui.models.third-party-providers'),
    rowLabel: t('ui.models.third-party-providers'),
    rowValue: name,
    rowAriaLabel: t('ui.models.switch-third-party-provider', name),
    value: current?.provider ?? '',
    options: providers.map((p) => ({
      value: p.id,
      label: p.name,
      icon: <BrandIcon brand={p.brand} name={p.name} size={16} inline />,
      testId: `provider-${p.id}`,
    })),
    onChange: (id) => {
      const provider = providers.find((p) => p.id === id);
      if (!provider || id === current?.provider) return 'effort';
      if (!current || !provider.models.some((m) => m.id === current.model)) return 'model';
      return onPick(`${id}/${current.model}`);
    },
  };
}
