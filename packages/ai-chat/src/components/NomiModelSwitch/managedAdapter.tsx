import { BUILTIN_MANIFESTS, BUILTIN_RENDERER, isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { brand } from '@nomi-ai/types';
import {
  BrandIcon,
  Icon,
  IconButton,
  modelBrandIsNative,
  modelBrandOf,
  t,
  type PickerModel,
  type PickerProvider,
  type SelectOption,
} from '@nomi-ai/ui';
import { IconRefresh as RefreshCw } from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { ManagedRuntimeContextValue } from '../../contexts/ManagedRuntimeContext';
import { useCliAccounts } from '../../hooks/useCliAccounts';
import { accountDisplayLabel, type AccountKind } from '../../services/cliAccountClient';
import {
  codingModelChoices,
  codingProviders,
  isCliKind,
  providerOfRef,
} from '../../services/cliSource';
import {
  gatewayClient,
  gatewayClientAvailable,
  type GatewayState,
} from '../../services/gatewayClient';
import {
  harnessClient,
  type BackendModelCatalog,
  type HarnessTabMeta,
  type ReasoningEffort,
} from '../../services/harnessClient';
import { longContextForRef } from '../../services/longContext';
import { pickerProviders, providerBrand, splitRef } from '../../services/nomiModel';
import {
  isNativeThirdPartyModel,
  resolveThinkingLevel,
  thinkingProfileOf,
} from '../../services/thinkingDepth';
import {
  hasOfficialAccount,
  hasThirdParty,
  isInteractiveOnly,
  thirdPartyOnly,
} from '../../utils/cliCaps';
import type { EndpointKey } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';
import { backendName } from '../ManagedRuntimeDock/panel';
import type { ManagedRuntimeSource, RuntimeChoiceView } from '../ManagedRuntimeDock/types';
import { validCatalog } from '../ModelControls/cliSource';
import { effortLabel, thinkingLevelLabel } from '../ModelControls/effortLabel';
import menuStyles from '../ModelControls/index.module.css';
import type {
  EffortPageSource,
  ModelEffortSource,
  ModelPageSource,
  RuntimePageSource,
  SimpleModelChoiceSource,
} from '../ModelControls/ModelEffortChip';
import { thirdPartyProviderSource } from '../ModelControls/providerSource';
import { ProjectPicker } from '../ProjectPicker';

const OWN_TAB = '__cli';
const CUSTOM = '__custom';
const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
/**
 * 胶囊里要不要再画模型图标（同品牌不重复展示双图标）：底座自家模型品牌来自 cli-catalog 的清单
 * （`branding.modelBrand`，与 `modelBrandOf` 同一套品牌 id：Claude Code → claude、Codex → openai、
 * Grok → xai、Gemini → gemini、dsh → deepseek、Kimi / MiniMax → 同名），与模型认出的品牌相同就只留底座图标；
 * 别家的模型、认不出厂商的模型、没有自家品牌的底座（`nomi` / `other` / Antigravity）照样画。
 */
export function chipBrandOf(
  endpoint: EndpointKey,
  modelBrand: string | undefined,
): string | undefined {
  return modelBrand && !modelBrandIsNative(modelBrand, nativeModelBrand(endpoint))
    ? modelBrand
    : undefined;
}

/** 底座自家模型的品牌（cli-catalog 清单里的 `branding.modelBrand`）：不是内置 agent 或没写时为 undefined */
function nativeModelBrand(endpoint: EndpointKey): string | undefined {
  return isBuiltinCliId(endpoint) ? BUILTIN_RENDERER[endpoint].brand?.modelBrand : undefined;
}
const EFFORT_ORDER: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

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
  const isInteractiveLocked = isInteractiveOnly(activeId);
  const options: SelectOption[] = sortRuntimeChoices(view.choices).map((c) => {
    const isApi = c.id === 'api';
    const targetInteractive = isInteractiveOnly(c.id);
    const blockedSwitch =
      c.id !== activeId &&
      (isInteractiveLocked || (targetInteractive && (activeId !== 'api' || managed.hasMessages)));
    const needsProjectAdopt = c.status === 'no-project' && !view.managed && !blockedSwitch;
    const disabled = blockedSwitch || (isApi ? false : !c.available && !needsProjectAdopt);
    return {
      value: c.id,
      label: isApi ? brand.appName : backendName(c.id),
      icon: <EndpointIcon backend={endpointKeyOf(c.id)} size={16} decorative />,
      description: blockedSwitch
        ? t('ui.chat-settings.managed-runtime-new-chat-only')
        : runtimeChoiceDesc(c, hasApiProviders),
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
    rowAriaLabel: isInteractiveLocked
      ? t('ui.chat-settings.managed-runtime-locked', activeLabel)
      : t('ui.chat-settings.managed-runtime-switch', activeLabel),
    disabled: !managed.idle || isInteractiveLocked,
    searchable: false,
    header,
    value: activeId,
    options,
    onChange: async (id) => {
      const ok = await managed.selectBackend(id);
      return ok ? 'effort' : 'stay';
    },
  };
}

function fetchManagedCatalog(
  backend: string,
  refresh: boolean,
  source: ManagedRuntimeSource,
): Promise<BackendModelCatalog | null> {
  const opts = {
    ...(refresh ? { refresh: true } : {}),
    ...(source === 'thirdParty' ? { source: 'thirdParty' as const } : {}),
  };
  return harnessClient
    .modelCatalog(backend as HarnessTabMeta['backend'], opts)
    .then(validCatalog)
    .catch(() => null);
}

function useManagedCatalog(backend: string | null, source: ManagedRuntimeSource) {
  const key = backend ? `${backend}|${source}` : '';
  const [st, setSt] = useState<{ key: string; catalog: BackendModelCatalog | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const catalog = key && st?.key === key ? st.catalog : undefined;

  useEffect(() => {
    if (!backend) return;
    let alive = true;
    const load = () =>
      void fetchManagedCatalog(backend, false, source).then((c) => {
        if (alive) setSt({ key: `${backend}|${source}`, catalog: c });
      });
    load();
    const off =
      source === 'thirdParty' && gatewayClientAvailable()
        ? gatewayClient.onChanged(load)
        : () => undefined;
    return () => {
      alive = false;
      off();
    };
  }, [backend, source]);

  const refresh = useCallback(() => {
    if (!backend) return;
    setRefreshing(true);
    void fetchManagedCatalog(backend, true, source).then((c) => {
      if (c) setSt({ key: `${backend}|${source}`, catalog: c });
      setRefreshing(false);
    });
  }, [backend, source]);

  return { catalog, refreshing, refresh };
}

function catalogEfforts(catalog: BackendModelCatalog): ReasoningEffort[] {
  const set = new Set(catalog.models.flatMap((m) => m.efforts));
  return EFFORT_ORDER.filter((e) => set.has(e));
}

export interface ManagedCliInput {
  managed: ManagedRuntimeContextValue | null;
  runtime: RuntimePageSource | null;
  menuKey: string;
  open: boolean;
  gateway: GatewayState | null;
}

export function useCliManagedSource({
  managed,
  runtime,
  menuKey,
  open,
  gateway,
}: ManagedCliInput): ModelEffortSource | null {
  const isCliActive = Boolean(managed?.isCliBackend && managed.view && runtime);
  const view = isCliActive ? managed!.view! : null;
  const backend = view?.backend ?? '';
  const cliTitle = backend ? backendName(backend) : '';

  const activeSource: ManagedRuntimeSource =
    view?.source === 'official' || view?.source === 'thirdParty' || view?.source === 'local'
      ? view.source
      : 'local';

  const { catalog, refreshing, refresh } = useManagedCatalog(
    isCliActive && backend ? backend : null,
    activeSource,
  );

  const supportsOfficial = Boolean(backend && hasOfficialAccount(backend));
  const supportsThirdParty = Boolean(backend && hasThirdParty(backend));
  const listKind = isCliActive && open && supportsOfficial ? (backend as AccountKind) : null;
  const { accounts, ready: accountsReady } = useCliAccounts(listKind);

  const loggedInAccounts = useMemo(() => accounts.filter((a) => a.loggedIn), [accounts]);
  const selectableAccounts = useMemo(
    () => (loggedInAccounts.length > 0 ? loggedInAccounts : accounts),
    [loggedInAccounts, accounts],
  );
  const defaultAccount = useMemo(
    () =>
      loggedInAccounts.find((a) => a.active) ??
      selectableAccounts.find((a) => a.active) ??
      selectableAccounts[0],
    [loggedInAccounts, selectableAccounts],
  );

  const tpChoices = useMemo(() => codingModelChoices(gateway), [gateway]);
  const gwMetaMap = useMemo(() => {
    const out = new Map<string, PickerModel>();
    for (const p of pickerProviders(gateway?.providers ?? [])) {
      for (const m of p.models) out.set(`${p.id}/${m.id}`, m);
    }
    return out;
  }, [gateway]);

  const { tpProviders, tpCatalogMap } = useMemo(() => {
    const baseProviders = codingProviders(gateway);
    const catalogMap = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
    const hasCatalogModels = Boolean(activeSource === 'thirdParty' && catalog?.models.length);

    const mappedProviders: PickerProvider[] = [];
    for (const p of baseProviders) {
      const models: PickerModel[] = [];
      for (const m of p.models) {
        const cm = hasCatalogModels ? catalogMap.get(m.ref) : undefined;
        if (hasCatalogModels && !cm) continue;
        const gm = gwMetaMap.get(m.ref);
        models.push({
          ...gm,
          id: m.model,
          label: cm?.label ?? gm?.label ?? m.model,
          reasoning: gm?.reasoning ?? cm?.reasoning,
        });
      }
      if (models.length > 0) {
        mappedProviders.push({
          id: p.id,
          name: p.name,
          brand: providerBrand(gateway, p.id),
          models,
        });
      }
    }

    // 若第三方目录全部不在当前 codingProviders 内，保留 codingProviders 避免空态
    const tpProviders: PickerProvider[] =
      mappedProviders.length > 0
        ? mappedProviders
        : baseProviders.map((p) => ({
            id: p.id,
            name: p.name,
            brand: providerBrand(gateway, p.id),
            models: p.models.map((m) => ({
              ...gwMetaMap.get(m.ref),
              id: m.model,
              label: gwMetaMap.get(m.ref)?.label ?? m.model,
            })),
          }));

    const tpCatalogMap = new Map<string, string>();
    for (const p of tpProviders) {
      for (const m of p.models) {
        tpCatalogMap.set(`${p.id}/${m.id}`, `${p.id}/${m.id}`);
      }
    }
    return { tpProviders, tpCatalogMap };
  }, [gateway, gwMetaMap, catalog, activeSource]);

  const pickManagedConfig = useCallback(
    (patch: Parameters<ManagedRuntimeContextValue['updateConfig']>[0]) => {
      if (!managed) return;
      void managed.updateConfig(patch);
    },
    [managed],
  );

  if (!isCliActive || !view || !runtime || !managed) return null;

  const endpointKey = endpointKeyOf(backend);
  const thirdParty = activeSource === 'thirdParty';
  const idle = managed.idle;
  const activeChoice = view.choices.find((c) => c.id === backend);
  const hasLocalLogin = activeChoice?.hasLocalLogin !== false;
  const currentModel = view.model && view.model !== 'cli-default' ? view.model : null;

  // 来源分段条：按能力位构建（local 始终存在，未检测到本机登录时置灰；official 依赖 officialAccount；thirdParty 依赖 thirdParty）
  const sources: Array<{ id: ManagedRuntimeSource; label: string; disabled: boolean }> = [
    { id: 'local', label: t('ui.foundation.local'), disabled: !hasLocalLogin },
  ];
  if (supportsOfficial) {
    sources.push({
      id: 'official',
      label: t('ui.chat-settings.official-accounts'),
      disabled: accountsReady && loggedInAccounts.length === 0 && activeSource !== 'official',
    });
  }
  if (supportsThirdParty) {
    sources.push({
      id: 'thirdParty',
      label: t('ui.cli-monitor.third-party'),
      disabled: tpChoices.length === 0 && activeSource !== 'thirdParty',
    });
  }

  const sourceBar =
    sources.length >= 2 ? (
      <div className={menuStyles.managedSourceBar}>
        <div className={menuStyles.sourceTabs} data-testid="managed-source-tabs">
          {sources.map((src) => {
            const active = activeSource === src.id;
            return (
              <button
                key={src.id}
                type="button"
                className={menuStyles.sourceTab}
                aria-pressed={active}
                disabled={src.disabled || !idle}
                data-testid={`managed-source-${src.id}`}
                onClick={() => {
                  if (active) return;
                  if (src.id === 'local') {
                    pickManagedConfig({ source: 'local' });
                    return;
                  }
                  if (src.id === 'official') {
                    pickManagedConfig({
                      source: 'official',
                      ...(defaultAccount ? { accountId: defaultAccount.id } : {}),
                    });
                    return;
                  }
                  const mainRef = isCliKind(backend)
                    ? gateway?.clients[backend]?.models.main
                    : undefined;
                  const initRef =
                    (mainRef && tpChoices.some((c) => c.ref === mainRef)
                      ? mainRef
                      : tpChoices[0]?.ref) ?? undefined;
                  pickManagedConfig({
                    source: 'thirdParty',
                    ...(initRef ? { model: initRef } : {}),
                  });
                }}
              >
                {src.label}
              </button>
            );
          })}
        </div>
      </div>
    ) : null;

  const sourceNameForRefresh = thirdParty ? t('ui.models.third-party-models') : cliTitle;
  const refreshButton = (
    <IconButton
      size="sm"
      data-testid="model-refresh"
      disabled={refreshing}
      label={t('ui.chat-settings.reload-the-model-list-from', sourceNameForRefresh)}
      onClick={refresh}
      icon={
        <span className={refreshing ? menuStyles.spin : undefined}>
          <Icon icon={RefreshCw} size={13} />
        </span>
      }
    />
  );

  // ========================== 第三方来源（网关） ==========================
  if (thirdParty) {
    const gatewayMainRef = isCliKind(backend) ? gateway?.clients[backend]?.models.main : undefined;
    const validGatewayMain =
      gatewayMainRef && tpChoices.some((c) => c.ref === gatewayMainRef) ? gatewayMainRef : null;
    const validCatalogDefault =
      catalog?.defaultModel?.id && tpCatalogMap.has(catalog.defaultModel.id)
        ? catalog.defaultModel.id
        : null;
    const defaultThirdPartyRef = validGatewayMain ?? validCatalogDefault;
    const effectiveRef = currentModel ?? defaultThirdPartyRef ?? null;

    const parts = effectiveRef ? splitRef(effectiveRef) : null;
    const gwProv =
      parts && gateway ? gateway.providers.find((p) => p.id === parts.provider) : undefined;
    const gwModel = parts && gwProv ? gwProv.models.find((m) => m.id === parts.model) : undefined;
    const catalogEntry = effectiveRef
      ? catalog?.models.find((m) => m.id === effectiveRef)
      : undefined;

    const catalogLabel = (() => {
      const raw = catalogEntry?.label;
      if (!raw) return undefined;
      const sepIdx = raw.indexOf(' / ');
      return sepIdx >= 0 ? raw.slice(sepIdx + 3).trim() || raw : raw;
    })();
    const modelDisplay = effectiveRef
      ? (gwModel?.label ?? catalogLabel ?? (parts ? parts.model : effectiveRef))
      : t('ui.models.choose-a-model');
    const modelBrand = effectiveRef
      ? modelBrandOf(
          parts ? parts.model : effectiveRef,
          parts && gateway ? providerBrand(gateway, parts.provider) : undefined,
        )
      : undefined;
    const chipModelBrand = chipBrandOf(endpointKey, modelBrand);

    const profile = effectiveRef ? thinkingProfileOf(gateway, effectiveRef) : null;
    const levels = (profile?.levels ?? []) as ReasoningEffort[];
    const reasoningSupported = levels.length > 0;
    const storedEffort = (view.effort ?? null) as ReasoningEffort | null;
    const effort =
      reasoningSupported && storedEffort && levels.includes(storedEffort) ? storedEffort : null;
    const nativeThirdParty = isNativeThirdPartyModel(backend, gateway, effectiveRef);
    const defaultEffort =
      reasoningSupported && !nativeThirdParty
        ? ((resolveThinkingLevel(undefined, profile) ?? null) as ReasoningEffort | null)
        : null;
    const chipEffort = effectiveRef ? (effort ?? defaultEffort) : null;
    const chipLabel = chipEffort
      ? `${modelDisplay} · ${thinkingLevelLabel(chipEffort)}`
      : modelDisplay;

    const extraOptions: SelectOption[] = [
      ...(defaultThirdPartyRef
        ? [
            {
              value: '',
              label: t('ui.providers-schedule.default-model'),
              description: splitRef(defaultThirdPartyRef)?.model ?? defaultThirdPartyRef,
              hint: t('ui.chat-settings.follows-s-own-choice', t('ui.models.third-party-models')),
              testId: 'model-default',
            },
          ]
        : []),
      ...(currentModel && !tpCatalogMap.has(currentModel)
        ? [
            {
              value: CUSTOM,
              label: currentModel,
              description: t('ui.providers-schedule.custom'),
              testId: 'model-current-custom',
            },
          ]
        : []),
    ];

    const pickerValue = currentModel
      ? tpCatalogMap.has(currentModel)
        ? currentModel
        : CUSTOM
      : null;

    const afterThirdPartyPick = (ref: string | null): 'effort' | 'close' =>
      ref && thinkingProfileOf(gateway, ref) ? 'effort' : 'close';

    const modelPage: ModelPageSource = {
      providers: tpProviders,
      value: pickerValue,
      extraOptions,
      notice: catalog?.error ? (
        <div className="cd-model-picker__notice" role="status" data-testid="model-error">
          {t(
            'ui.chat-settings.couldn-t-read-the-model-list-from',
            sourceNameForRefresh,
            catalog.error,
          )}
        </div>
      ) : null,
      headerEnd: refreshButton,
      showBack: true,
      wide: true,
      purpose: 'coding',
      focusProvider:
        (effectiveRef ? providerOfRef(effectiveRef) : null) ?? tpProviders[0]?.id ?? undefined,
      optionTestId: (v) => `model-${v}`,
      onPick: (v) => {
        if (v === '') {
          if (view.model !== 'cli-default') {
            pickManagedConfig({ model: 'cli-default' });
          }
          return afterThirdPartyPick(defaultThirdPartyRef);
        }
        if (v === CUSTOM) {
          return afterThirdPartyPick(currentModel);
        }
        const ref = tpCatalogMap.get(v) ?? v;
        if (ref !== view.model) {
          pickManagedConfig({ model: ref });
        }
        return afterThirdPartyPick(ref);
      },
    };

    const effortPage: EffortPageSource = {
      supported: reasoningSupported,
      levels,
      value: chipEffort,
      explicit: Boolean(effort),
      defaultUnknownNote:
        nativeThirdParty && !effort && !defaultEffort
          ? t('ui.chat-settings.effort-default-set-by-cli', cliTitle)
          : null,
      onCommit: (next) => {
        if (next === effort || (!effort && next === defaultEffort)) return;
        if (next && next !== view.effort) {
          pickManagedConfig({ effort: next });
        }
      },
      onRestore: () => {
        if (view.effort) {
          pickManagedConfig({ effort: 'default' });
        }
      },
    };

    const providerSource = thirdPartyProviderSource(tpProviders, effectiveRef, (ref) => {
      if (ref !== view.model) {
        pickManagedConfig({ model: ref });
      }
      return afterThirdPartyPick(ref);
    });
    const long = longContextForRef(effectiveRef, view.longContext, gateway);

    return {
      label: chipLabel,
      muted: !effectiveRef,
      brand: chipModelBrand,
      runtimeIcon: <EndpointIcon backend={endpointKey} size={16} decorative />,
      ariaLabel: chipEffort
        ? t('ui.chat-settings.model-and-reasoning-effort', chipLabel)
        : t('ui.chat-settings.model', cliTitle, chipLabel),
      menuLabel: t('ui.chat-settings.model-and-reasoning-effort-label'),
      longBadge: Boolean(long?.on),
      longContext: long
        ? {
            standard: long.standard,
            full: long.full,
            on: long.on,
            note: long.priceNote,
            disabled: !idle,
            onChange: (on) => {
              if (!idle || on === long.on) return;
              pickManagedConfig({
                longContext: on === long.modelDefault ? 'default' : on ? 'on' : 'off',
              });
            },
          }
        : null,
      initialView: 'effort',
      menuCommandView: 'model',
      menuKey,
      runtime,
      sourceBar,
      showModelRow: true,
      effort: effortPage,
      model: modelPage,
      provider: providerSource,
      account: null,
      modelIcon: modelBrand ? (
        <BrandIcon brand={modelBrand} name={modelDisplay} size={15} inline />
      ) : null,
      modelLabel: modelDisplay,
      modelRowAria: t('ui.chat-settings.switch-model', modelDisplay),
    };
  }

  // ===================== 本机 / 官方账号来源 =====================
  const staticModels = activeChoice?.models ?? [];
  const hasCatalog = Boolean(catalog && (catalog.models.length > 0 || catalog.error));
  const catalogModels = hasCatalog ? (catalog?.models ?? []) : [];

  const matchedCatalogModel = currentModel
    ? (catalogModels.find((m) => m.id === currentModel) ?? null)
    : null;
  const matchedStaticModel = currentModel
    ? (staticModels.find((m) => m.id === currentModel) ?? null)
    : null;

  const rawModelLabel =
    matchedCatalogModel?.label ?? matchedStaticModel?.label ?? (currentModel || undefined);
  const modelDisplay = currentModel
    ? (rawModelLabel ?? currentModel)
    : t('ui.providers-schedule.default-model');
  const baseLabel = currentModel ? (rawModelLabel ?? currentModel) : cliTitle;
  const effectiveModelId = currentModel ?? catalog?.defaultModel?.id ?? null;
  const modelBrand = effectiveModelId ? modelBrandOf(effectiveModelId) : undefined;
  const chipModelBrand = chipBrandOf(endpointKey, modelBrand);

  const backendBlocksEffort =
    thirdPartyOnly(backend) ||
    (isBuiltinCliId(backend) && BUILTIN_MANIFESTS[backend].transport === 'exec');

  const modelInfo = hasCatalog
    ? currentModel
      ? matchedCatalogModel
      : (catalog?.defaultModel ?? null)
    : null;

  let levels: ReasoningEffort[] = [];
  if (!backendBlocksEffort) {
    if (hasCatalog) {
      if (modelInfo && !modelInfo.reasoning) {
        levels = [];
      } else if (modelInfo?.efforts.length) {
        levels = modelInfo.efforts;
      } else {
        levels = catalog ? catalogEfforts(catalog) : [];
      }
      if (!levels.length && !catalog?.error && (!modelInfo || modelInfo.reasoning)) {
        levels = [...EFFORT_LEVELS];
      }
    } else {
      levels = [...EFFORT_LEVELS];
    }
  }

  const reasoningSupported = levels.length > 0;
  const storedEffort = (view.effort ?? null) as ReasoningEffort | null;
  const effort = reasoningSupported && storedEffort ? storedEffort : null;
  const defaultEffort =
    reasoningSupported && modelInfo?.defaultEffort && levels.includes(modelInfo.defaultEffort)
      ? modelInfo.defaultEffort
      : null;
  const chipEffort = reasoningSupported ? (effort ?? defaultEffort) : null;
  const chipLabel = chipEffort ? `${baseLabel} · ${effortLabel(chipEffort)}` : baseLabel;

  let simpleModelChoice: SimpleModelChoiceSource | null = null;
  let modelPage: ModelPageSource = {
    providers: [],
    value: null,
    showBack: true,
    wide: false,
    onPick: () => 'effort',
  };
  let showModelRow = false;

  if (hasCatalog && catalog) {
    const toCatalog = new Map<string, string>();
    const ownProvider: PickerProvider = {
      id: OWN_TAB,
      name: cliTitle,
      vendors: false,
      models: catalog.models.map((m) => {
        toCatalog.set(`${OWN_TAB}/${m.id}`, m.id);
        return { id: m.id, label: m.label, reasoning: m.reasoning };
      }),
    };
    const defaultLabel = catalog.defaultModel?.label ?? catalog.defaultModel?.id;
    const extraOptions: SelectOption[] = [
      {
        value: '',
        label: t('ui.providers-schedule.default-model'),
        description: defaultLabel ?? cliTitle,
        hint: t('ui.chat-settings.follows-s-own-choice', cliTitle),
        testId: 'model-default',
      },
      ...(currentModel && !matchedCatalogModel
        ? [
            {
              value: CUSTOM,
              label: currentModel,
              description: t('ui.providers-schedule.custom'),
              testId: 'model-current-custom',
            },
          ]
        : []),
    ];
    const pickerValue = currentModel
      ? matchedCatalogModel
        ? `${OWN_TAB}/${matchedCatalogModel.id}`
        : CUSTOM
      : null;

    modelPage = {
      providers: [ownProvider],
      value: pickerValue,
      extraOptions,
      notice: catalog.error ? (
        <div className="cd-model-picker__notice" role="status" data-testid="model-error">
          {t('ui.chat-settings.couldn-t-read-the-model-list-from', cliTitle, catalog.error)}
        </div>
      ) : null,
      backEnd: refreshButton,
      showBack: true,
      wide: false,
      focusProvider: OWN_TAB,
      optionTestId: (v) => `model-${toCatalog.get(v) ?? v}`,
      onPick: (v) => {
        if (v === '') {
          if (view.model && view.model !== 'cli-default') {
            pickManagedConfig({ model: 'cli-default' });
          }
          return 'effort';
        }
        if (v === CUSTOM) return 'effort';
        const id = toCatalog.get(v);
        if (id && id !== view.model) {
          pickManagedConfig({ model: id });
        }
        return 'effort';
      },
    };
    showModelRow = catalog.models.length > 0 || Boolean(catalog.error);
  } else if (staticModels.length > 1) {
    const modelValue = view.model || staticModels[0]?.id || 'cli-default';
    simpleModelChoice = {
      title: t('ui.foundation.model'),
      rowLabel: t('ui.foundation.model'),
      rowValue: modelDisplay,
      rowAriaLabel: t('ui.chat-settings.switch-model', modelDisplay),
      searchable: false,
      value: modelValue,
      options: staticModels.map((m) => ({
        value: m.id,
        label: m.id === 'cli-default' ? t('ui.providers-schedule.default-model') : m.label,
        testId: `managed-model-${m.id}`,
      })),
      onChange: (val) => {
        if (val && val !== modelValue) {
          pickManagedConfig({ model: val });
        }
        return 'effort';
      },
    };
    showModelRow = true;
  }

  // 官方账号行：仅当 source === 'official' 且存在多账号时展示；local 模式不展示
  const pinnedAccount = view.accountId
    ? selectableAccounts.find((a) => a.id === view.accountId)
    : undefined;
  const accountLabel = view.accountId
    ? pinnedAccount
      ? accountDisplayLabel(pinnedAccount)
      : t('ui.models.removed-account')
    : defaultAccount
      ? accountDisplayLabel(defaultAccount)
      : t('ui.chat-settings.official-accounts');
  const accountValue =
    (view.accountId && selectableAccounts.some((a) => a.id === view.accountId)
      ? view.accountId
      : defaultAccount?.id) ?? '';

  const accountSource: ModelEffortSource['account'] =
    activeSource === 'official' && supportsOfficial && selectableAccounts.length > 1
      ? {
          title: t('ui.chat-settings.official-accounts'),
          rowLabel: t('ui.models.account'),
          rowValue: accountLabel,
          rowAriaLabel: t('ui.models.switch-official-account', accountLabel),
          searchable: false,
          value: accountValue,
          options: selectableAccounts.map((a) => {
            const display = accountDisplayLabel(a);
            return {
              value: a.id,
              label: display,
              description: a.identity?.plan ?? '',
              hint: [a.identity?.name, a.identity?.email].find(
                (x) => x && x.trim().toLowerCase() !== display.toLowerCase(),
              ),
              testId: `account-${a.id}`,
            };
          }),
          onChange: (id) => {
            const nextId = id || 'default';
            if (nextId !== (view.accountId ?? '')) {
              pickManagedConfig({ accountId: nextId });
            }
          },
        }
      : null;

  return {
    label: chipLabel,
    muted: false,
    brand: chipModelBrand,
    runtimeIcon: <EndpointIcon backend={endpointKey} size={16} decorative />,
    ariaLabel: chipEffort
      ? t('ui.chat-settings.model-and-reasoning-effort', chipLabel)
      : t('ui.chat-settings.model', cliTitle, chipLabel),
    menuLabel: t('ui.chat-settings.model-and-reasoning-effort-label'),
    initialView: 'effort',
    menuCommandView: showModelRow ? 'model' : 'effort',
    menuKey,
    runtime,
    sourceBar,
    showModelRow,
    simpleModelChoice,
    effort: {
      supported: reasoningSupported,
      levels,
      value: chipEffort,
      explicit: Boolean(view.effort),
      defaultUnknownNote:
        !view.effort && !defaultEffort
          ? t('ui.chat-settings.effort-default-set-by-cli', cliTitle)
          : null,
      onCommit: (next) => {
        if (next === effort || (!effort && next === defaultEffort)) return;
        if (next && next !== view.effort) {
          pickManagedConfig({ effort: next });
        }
      },
      onRestore: () => {
        if (view.effort) {
          pickManagedConfig({ effort: 'default' });
        }
      },
    },
    model: modelPage,
    provider: null,
    account: accountSource,
    modelIcon: modelBrand ? (
      <BrandIcon brand={modelBrand} name={modelDisplay} size={15} inline />
    ) : null,
    modelLabel: modelDisplay,
    modelRowAria: t('ui.chat-settings.switch-model', modelDisplay),
  };
}
