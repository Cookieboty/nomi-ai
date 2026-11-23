import { BUILTIN_MANIFESTS, isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { brand } from '@nomi-ai/types';
import { t, type SelectOption } from '@nomi-ai/ui';
import React from 'react';

import type { ManagedRuntimeContextValue } from '../../contexts/ManagedRuntimeContext';
import type { EndpointKey } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';
import { CapabilityMatrix } from '../ManagedRuntimeDock/CapabilityMatrix';
import { backendName } from '../ManagedRuntimeDock/panel';
import type { RuntimeChoiceView } from '../ManagedRuntimeDock/types';
import { thinkingLevelLabel } from '../ModelControls/effortLabel';
import menuStyles from '../ModelControls/index.module.css';
import type { ModelEffortSource, RuntimePageSource } from '../ModelControls/ModelEffortChip';
import { ProjectPicker } from '../ProjectPicker';

const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export function endpointKeyOf(backend: string): EndpointKey {
  if (!backend || backend === 'api' || backend === 'nomi') return 'nomi';
  return isBuiltinCliId(backend) ? backend : 'other';
}

function runtimeChoiceDesc(choice: RuntimeChoiceView, hasApiProviders: boolean): string {
  if (choice.id === 'api') {
    return hasApiProviders
      ? t('ui.chat-settings.managed-runtime-api-desc')
      : t('ui.providers-schedule.not-configured');
  }
  switch (choice.status) {
    case 'ready':
      return t('ui.foundation.local');
    case 'no-project':
      return t('ui.chat-settings.managed-runtime-needs-project');
    case 'missing-executable':
      return t('ui.mascot-theme.not-installed');
    case 'unsupported-platform':
      return t('ui.slash-commands.unsupported');
    default:
      return '';
  }
}

function sortRuntimeChoices(choices: readonly RuntimeChoiceView[]): RuntimeChoiceView[] {
  const api = choices.filter((c) => c.id === 'api');
  const clis = choices.filter((c) => c.id !== 'api');
  const rank = (c: RuntimeChoiceView) => (c.available ? 0 : c.status === 'no-project' ? 1 : 2);
  clis.sort((a, b) => rank(a) - rank(b));
  return [...api, ...clis];
}

export function buildRuntimePageSource(args: {
  managed: ManagedRuntimeContextValue;
  hasApiProviders: boolean;
  projectId: string | undefined;
}): RuntimePageSource | null {
  const { managed, hasApiProviders, projectId } = args;
  const view = managed.view;
  if (!view?.supported || !view.choices.length) return null;

  const activeId = managed.activeBackend;
  const activeLabel = activeId === 'api' ? brand.appName : backendName(activeId);
  const options: SelectOption[] = sortRuntimeChoices(view.choices).map((c) => {
    const isApi = c.id === 'api';
    const needsProjectAdopt = c.status === 'no-project' && !view.managed;
    const disabled = isApi ? false : !c.available && !needsProjectAdopt;
    return {
      value: c.id,
      label: isApi ? brand.appName : backendName(c.id),
      icon: <EndpointIcon backend={endpointKeyOf(c.id)} size={16} decorative />,
      description: runtimeChoiceDesc(c, hasApiProviders),
      disabled,
      testId: `runtime-option-${c.id}`,
    };
  });

  const pendingBackend = managed.pendingProjectBackend;
  const header =
    pendingBackend && !view.managed
      ? ({ toEffort }: { toEffort: () => void }) => (
          <div className={menuStyles.runtimeInlineBar} data-testid="runtime-project-prompt">
            <p className={menuStyles.runtimeInlineHint}>
              {t(
                'ui.chat-settings.managed-runtime-select-project-hint',
                backendName(pendingBackend),
              )}
            </p>
            <ProjectPicker
              value={projectId}
              onChange={(pid) => {
                void managed.bindProjectAndAdopt(pid).then((ok) => {
                  if (ok) toEffort();
                });
              }}
              size="sm"
              variant="ghost"
              testId="runtime-project-picker"
            />
          </div>
        )
      : undefined;

  return {
    title: t('ui.chat-settings.managed-runtime-label'),
    rowLabel: t('ui.chat-settings.managed-runtime-label'),
    rowValue: activeLabel,
    rowIcon: <EndpointIcon backend={endpointKeyOf(activeId)} size={15} decorative />,
    rowAriaLabel: t('ui.chat-settings.managed-runtime-switch', activeLabel),
    disabled: !managed.idle,
    searchable: false,
    header,
    footer: (
      <div className={menuStyles.runtimePageFoot}>
        {t('ui.chat-settings.managed-runtime-login-short')}
      </div>
    ),
    value: activeId,
    options,
    onChange: async (id) => {
      const ok = await managed.selectBackend(id);
      return ok ? 'effort' : 'stay';
    },
  };
}

export function buildCliManagedSource(args: {
  managed: ManagedRuntimeContextValue;
  runtime: RuntimePageSource;
  menuKey: string;
}): ModelEffortSource {
  const { managed, runtime, menuKey } = args;
  const view = managed.view!;
  const backend = view.backend;
  const cliTitle = backendName(backend);
  const activeChoice = view.choices.find((c) => c.id === backend);
  const models = activeChoice?.models ?? [];
  const accounts = activeChoice?.accounts ?? [];
  const bridges = view.capabilities?.bridges ?? activeChoice?.bridges;

  const modelValue = view.model || models[0]?.id || 'cli-default';
  const rawModel = models.find((m) => m.id === modelValue);
  const hasExplicitModel = Boolean(rawModel && rawModel.id !== 'cli-default');
  const modelDisplay = hasExplicitModel
    ? rawModel!.label
    : t('ui.providers-schedule.default-model');

  const effortValue = view.effort || null;
  const baseLabel = hasExplicitModel ? rawModel!.label : cliTitle;
  const chipLabel = effortValue ? `${baseLabel} · ${thinkingLevelLabel(effortValue)}` : baseLabel;

  const effortSupported = !(
    isBuiltinCliId(backend) && BUILTIN_MANIFESTS[backend].transport === 'exec'
  );

  const modelOptions: SelectOption[] = models.map((m) => ({
    value: m.id,
    label: m.id === 'cli-default' ? t('ui.providers-schedule.default-model') : m.label,
    testId: `managed-model-${m.id}`,
  }));

  const accountValue = view.accountId || accounts[0]?.id || '';
  const accountDisplay =
    accounts.find((a) => a.id === accountValue)?.label || accountValue || 'default';

  return {
    label: chipLabel,
    muted: false,
    triggerIcon: <EndpointIcon backend={endpointKeyOf(backend)} size={16} decorative />,
    ariaLabel: effortValue
      ? t('ui.chat-settings.model-and-reasoning-effort', chipLabel)
      : t('ui.chat-settings.model', cliTitle, chipLabel),
    menuLabel: t('ui.chat-settings.model-and-reasoning-effort-label'),
    initialView: 'effort',
    menuCommandView: models.length > 1 ? 'model' : 'effort',
    menuKey,
    runtime,
    showModelRow: models.length > 1,
    simpleModelChoice:
      models.length > 1
        ? {
            title: t('ui.foundation.model'),
            rowLabel: t('ui.foundation.model'),
            rowValue: modelDisplay,
            rowAriaLabel: t('ui.chat-settings.switch-model', modelDisplay),
            searchable: false,
            value: modelValue,
            options: modelOptions,
            onChange: (val) => {
              if (val && val !== modelValue) {
                void managed.updateConfig({ model: val });
              }
              return 'effort';
            },
          }
        : null,
    effort: {
      supported: effortSupported,
      levels: [...EFFORT_LEVELS],
      value: effortValue,
      explicit: Boolean(view.effort),
      defaultUnknownNote: t('ui.providers-schedule.default'),
      unavailableHint: t(
        'ui.chat-settings.has-no-documented-reasoning-effort-control-nomi-will',
        cliTitle,
      ),
      onCommit: (next) => {
        if (next && next !== view.effort) {
          void managed.updateConfig({ effort: next });
        }
      },
      onRestore: () => {
        if (view.effort) {
          void managed.updateConfig({ effort: 'default' });
        }
      },
    },
    model: {
      providers: [],
      value: null,
      showBack: true,
      wide: false,
      onPick: () => 'effort',
    },
    account:
      accounts.length > 1
        ? {
            title: t('ui.chat-settings.managed-config-account'),
            rowLabel: t('ui.chat-settings.managed-config-account'),
            rowValue: accountDisplay,
            rowAriaLabel: t('ui.models.switch-official-account', accountDisplay),
            searchable: false,
            value: accountValue,
            options: accounts.map((a) => ({
              value: a.id,
              label: a.label,
              testId: `managed-account-${a.id}`,
            })),
            onChange: (id) => {
              const nextId = id || 'default';
              if (nextId !== view.accountId) {
                void managed.updateConfig({ accountId: nextId });
              }
            },
          }
        : null,
    details: bridges
      ? {
          title: t('ui.chat-settings.managed-cap-title'),
          note: t('ui.chat-settings.managed-runtime-login-short'),
          linkLabel: t('ui.chat-settings.managed-runtime-capabilities'),
          linkAriaLabel: t('ui.chat-settings.managed-runtime-capabilities-aria'),
          content: <CapabilityMatrix bridges={bridges} embedded />,
        }
      : null,
    modelLabel: modelDisplay,
    modelRowAria: t('ui.chat-settings.switch-model', modelDisplay),
  };
}
