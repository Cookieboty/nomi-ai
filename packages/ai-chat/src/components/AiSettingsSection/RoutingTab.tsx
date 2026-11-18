import { cliName } from '@nomi-ai/cli-catalog';
import { brand } from '@nomi-ai/types';
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  ModelPicker,
  Select,
  SettingRow,
  SettingsGroup,
  Switch,
  t,
} from '@nomi-ai/ui';
import {
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconFlame as Flame,
  IconLayersSubtract as CustomPresetIcon,
  IconLeaf as Leaf,
  IconPlus as Plus,
  IconScale as Scale,
  IconTrash as Trash,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';

import { useAccountLabels } from '../../services/cliAccountClient';
import {
  codingModelChoices,
  preferredThirdPartyModelForCli,
  refSlashLabel,
} from '../../services/cliSource';
import {
  DELEGATE_CLIS,
  delegateClient,
  formatRunnerSourceLabel,
  formatRunnerSummary,
  presetDisplayLabel,
  ROUTABLE_TASK_KINDS,
  routableTaskKindLabel,
  type DelegateCli,
  type DelegateSettingsView,
  type RoutableTaskKind,
  type RouteTarget,
  type RunnerPreset,
} from '../../services/delegateClient';
import { gatewayClient, type ClientModels, type GatewayState } from '../../services/gatewayClient';
import { pickerProviders, useGatewayState } from '../../services/nomiModel';
import { thinkingProfileOf } from '../../services/thinkingDepth';
import { thirdPartyOnly } from '../../utils/cliCaps';
import { EndpointIcon } from '../EndpointIcon';
import { thinkingLevelLabel } from '../ModelControls/effortLabel';
import { RunnerModelPicker, type RunnerSpecValue } from '../RunnerModelPicker';

import styles from './index.module.css';

const BUILTIN_PRESET_IDS = new Set(['high', 'balanced', 'low']);
const CUSTOM_OPTION = '__custom__';
const CURRENT_CUSTOM_OPTION = '__current_custom__';
const DEFAULT_NOMI_OPTION = '__default_nomi__';
const UNSET = 'unset';
const FOLLOW = 'follow';
const UNSET_HELPER_OPTIONS = [{ value: UNSET, label: 'ui.models.helper-unset' }];
const SAME_AS_CHAT = [{ value: FOLLOW, label: 'ui.models.same-as-chat' }];
const AUTO_IMAGE = [
  { value: UNSET, label: 'ui.models.image-auto', hint: 'ui.models.image-auto-hint' },
];

type PickerSession =
  | { mode: 'edit-preset'; presetId: string; initial: RunnerSpecValue }
  | { mode: 'add-preset'; initial: RunnerSpecValue }
  | { mode: 'route-custom'; taskKind: RoutableTaskKind; initial: RunnerSpecValue };

function presetIcon(p: RunnerPreset) {
  if (p.id === 'high' || p.costTier === 'high') return Flame;
  if (p.id === 'balanced' || p.costTier === 'medium') return Scale;
  if (p.id === 'low' || p.costTier === 'low') return Leaf;
  return CustomPresetIcon;
}

const NO_REASONING_BACKENDS = new Set(['gemini', 'dsh']);

function presetEffortText(p: RunnerPreset, gateway: GatewayState | null): string | null {
  if (p.source === 'thirdParty') {
    if (!gateway) {
      return p.reasoningEffort ? thinkingLevelLabel(p.reasoningEffort) : null;
    }
    const prof = thinkingProfileOf(gateway, p.model ?? null);
    if (!prof) return null;
    const eff =
      p.reasoningEffort && prof.levels.includes(p.reasoningEffort) ? p.reasoningEffort : null;
    return eff
      ? thinkingLevelLabel(eff)
      : `${t('ui.providers-schedule.default')} (${thinkingLevelLabel(prof.default)})`;
  }
  if (NO_REASONING_BACKENDS.has(p.cli)) return null;
  return p.reasoningEffort
    ? thinkingLevelLabel(p.reasoningEffort)
    : t('ui.providers-schedule.default');
}

export const RoutingTab: React.FC<{ onOpenProviders: () => void }> = ({ onOpenProviders }) => {
  const gateway = useGatewayState();
  useAccountLabels();
  const [delegateState, setDelegateState] = useState<DelegateSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerSession, setPickerSession] = useState<PickerSession | null>(null);
  const [showNomiMore, setShowNomiMore] = useState(false);

  useEffect(() => {
    if (!delegateClient.available()) return;
    let alive = true;
    delegateClient
      .settings()
      .then((v) => {
        if (alive) setDelegateState(v);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const providers = useMemo(() => gateway?.providers ?? [], [gateway]);
  const picker = useMemo(() => pickerProviders(providers), [providers]);
  const imagePicker = useMemo(() => pickerProviders(providers, 'image'), [providers]);
  const tpChoices = useMemo(() => codingModelChoices(gateway), [gateway]);
  const nomiModels = gateway?.clients.nomi?.models ?? {};

  const defaultSpecForAdd = useMemo((): RunnerSpecValue => {
    const first = delegateState?.presets?.[0];
    if (first) {
      return {
        cli: first.cli,
        source: first.source,
        accountId: first.accountId ?? null,
        model: first.model ?? null,
        reasoningEffort: first.reasoningEffort ?? 'medium',
      };
    }
    const cli = (delegateState?.installed?.[0] ?? DELEGATE_CLIS[0]) as DelegateCli;
    const tp = preferredThirdPartyModelForCli(gateway, cli);
    if (thirdPartyOnly(cli)) {
      return { cli, source: 'thirdParty', model: tp, reasoningEffort: 'medium' };
    }
    return { cli, source: 'official', accountId: null, model: null, reasoningEffort: 'medium' };
  }, [delegateState, gateway]);

  const saveDelegate = (
    next: Partial<
      Pick<
        DelegateSettingsView,
        'enabled' | 'autoComplexity' | 'presets' | 'routes' | 'defaults' | 'defaultProfileId'
      >
    >,
  ) => {
    if (!delegateState) return;
    const prev = delegateState;
    const optimistic: DelegateSettingsView = { ...delegateState, ...next };
    setDelegateState(optimistic);
    setError(null);
    delegateClient
      .setSettings({
        enabled: optimistic.enabled,
        defaults: optimistic.defaults,
        defaultProfileId: optimistic.defaultProfileId ?? 'default',
        ...(optimistic.cheapModel ? { cheapModel: optimistic.cheapModel } : {}),
        ...(optimistic.profiles ? { profiles: optimistic.profiles } : {}),
        autoComplexity: optimistic.autoComplexity ?? true,
        presets: optimistic.presets ?? [],
        routes: optimistic.routes ?? {},
      })
      .then(() => delegateClient.settings())
      .then((fresh) => setDelegateState(fresh))
      .catch((e: unknown) => {
        setDelegateState(prev);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const presets = useMemo(() => delegateState?.presets ?? [], [delegateState]);
  const routes = useMemo(() => delegateState?.routes ?? {}, [delegateState]);
  const delegateEnabled = delegateState ? delegateState.enabled : false;
  const autoComplexity = delegateState?.autoComplexity ?? true;

  const openEditPreset = (p: RunnerPreset) => {
    setPickerSession({
      mode: 'edit-preset',
      presetId: p.id,
      initial: {
        cli: p.cli,
        source: p.source,
        accountId: p.accountId ?? null,
        model: p.model ?? null,
        reasoningEffort: p.reasoningEffort ?? null,
      },
    });
  };

  const openAddPreset = () => {
    setPickerSession({
      mode: 'add-preset',
      initial: defaultSpecForAdd,
    });
  };

  const openRouteCustomPicker = (taskKind: RoutableTaskKind, cur?: RouteTarget) => {
    let initial: RunnerSpecValue = defaultSpecForAdd;
    if (cur?.kind === 'custom') {
      initial = {
        cli: cur.cli,
        source: cur.source,
        accountId: cur.accountId ?? null,
        model: cur.model ?? null,
        reasoningEffort: cur.reasoningEffort ?? null,
      };
    } else if (cur?.kind === 'preset') {
      const matched = presets.find((p) => p.id === cur.presetId);
      if (matched) {
        initial = {
          cli: matched.cli,
          source: matched.source,
          accountId: matched.accountId ?? null,
          model: matched.model ?? null,
          reasoningEffort: matched.reasoningEffort ?? null,
        };
      }
    }
    setPickerSession({ mode: 'route-custom', taskKind, initial });
  };

  const handlePickerConfirm = (spec: RunnerSpecValue) => {
    if (!pickerSession) return;
    if (pickerSession.mode === 'edit-preset') {
      const nextPresets = presets.map((p) =>
        p.id === pickerSession.presetId
          ? {
              ...p,
              cli: spec.cli,
              source: spec.source,
              accountId: spec.source === 'official' ? (spec.accountId ?? null) : null,
              model: spec.model ?? null,
              reasoningEffort: spec.reasoningEffort ?? null,
            }
          : p,
      );
      saveDelegate({ presets: nextPresets });
    } else if (pickerSession.mode === 'add-preset') {
      const baseIds = new Set(presets.map((p) => p.id));
      let n = 1;
      while (baseIds.has(`custom-${n}`)) n++;
      const id = `custom-${n}`;
      const newPreset: RunnerPreset = {
        id,
        label: `${cliName(spec.cli)} ${n}`,
        cli: spec.cli,
        source: spec.source,
        accountId: spec.source === 'official' ? (spec.accountId ?? null) : null,
        model: spec.model ?? null,
        reasoningEffort: spec.reasoningEffort ?? null,
        costTier: 'medium',
      };
      saveDelegate({ presets: [...presets, newPreset] });
    } else if (pickerSession.mode === 'route-custom') {
      const nextRoutes: Partial<Record<RoutableTaskKind, RouteTarget>> = {
        ...routes,
        [pickerSession.taskKind]: {
          kind: 'custom',
          cli: spec.cli,
          source: spec.source,
          accountId: spec.source === 'official' ? (spec.accountId ?? null) : null,
          model: spec.model ?? null,
          reasoningEffort: spec.reasoningEffort ?? null,
        },
      };
      saveDelegate({ routes: nextRoutes });
    }
    setPickerSession(null);
  };

  const deleteCustomPreset = (presetId: string) => {
    const nextPresets = presets.filter((p) => p.id !== presetId);
    const fallbackPreset = nextPresets[0]?.id ?? 'balanced';
    const nextRoutes: Partial<Record<RoutableTaskKind, RouteTarget>> = { ...routes };
    for (const k of ROUTABLE_TASK_KINDS) {
      const rt = nextRoutes[k];
      if (rt?.kind === 'preset' && rt.presetId === presetId) {
        nextRoutes[k] = { kind: 'preset', presetId: fallbackPreset };
      }
    }
    saveDelegate({ presets: nextPresets, routes: nextRoutes });
  };

  const updatePresetLabel = (presetId: string, nextLabel: string) => {
    const trimmed = nextLabel.trim();
    if (!trimmed) return;
    const target = presets.find((p) => p.id === presetId);
    if (!target || target.label === trimmed) return;
    saveDelegate({
      presets: presets.map((p) => (p.id === presetId ? { ...p, label: trimmed } : p)),
    });
  };

  const assignNomi = (patch: Partial<Record<keyof ClientModels, string | null>>) => {
    setError(null);
    gatewayClient
      .setAssignment('nomi', { models: patch as ClientModels })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const setHelperModel = (v: string) => {
    setError(null);
    gatewayClient
      .setOptions({ helperModel: v === UNSET ? null : v })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className={styles.stack} data-testid="ai-routing-tab">
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {delegateState && (
        <>
          <SettingsGroup
            title={t('ui.chat-settings.routing-presets-title')}
            description={t('ui.chat-settings.routing-presets-desc')}
            data-testid="routing-presets-group"
            actions={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="routing-preset-add"
                onClick={openAddPreset}
              >
                <Icon icon={Plus} size={14} />
                {t('ui.chat-settings.routing-preset-add')}
              </Button>
            }
          >
            {presets.length === 0 ? (
              <div className={styles.defaultAgentBox} data-testid="routing-preset-nomi-default">
                <div className={styles.presetCard}>
                  <div className={styles.presetHead}>
                    <EndpointIcon backend="nomi" size={16} decorative />
                    <span className={styles.presetTitle}>
                      {t('ui.models.routing-default-agent-option', brand.appName)}
                    </span>
                  </div>
                  <p className={styles.defaultAgentDesc}>
                    {t('ui.models.routing-default-agent-desc', brand.appName)}
                  </p>
                </div>
              </div>
            ) : (
              <div className={styles.presetGrid}>
                {presets.map((p) => {
                  const isBuiltin = BUILTIN_PRESET_IDS.has(p.id);
                  const PIcon = presetIcon(p);
                  const sourceText = formatRunnerSourceLabel(p.source, p.accountId);
                  const cliMissing =
                    (delegateState?.installed?.length ?? 0) > 0 &&
                    !delegateState!.installed.includes(p.cli);
                  const modelMissing =
                    p.source === 'thirdParty' &&
                    (!p.model || !tpChoices.some((c) => c.ref === p.model));
                  const warnText = cliMissing
                    ? t('ui.models.preset-warn-cli-missing')
                    : modelMissing
                      ? t('ui.models.preset-warn-model-missing')
                      : null;
                  return (
                    <div
                      key={p.id}
                      className={styles.presetCard}
                      data-testid={`routing-preset-${p.id}`}
                    >
                      <div className={styles.presetHead}>
                        <Icon icon={PIcon} size={16} />
                        {isBuiltin ? (
                          <span className={styles.presetTitle}>{presetDisplayLabel(p)}</span>
                        ) : (
                          <Input
                            size="sm"
                            className={styles.presetLabelInput}
                            defaultValue={p.label}
                            aria-label={t('ui.chat-settings.routing-preset-label')}
                            data-testid={`routing-preset-label-${p.id}`}
                            onBlur={(e) => updatePresetLabel(p.id, e.target.value)}
                          />
                        )}
                        {warnText && (
                          <Badge tone="warning" data-testid={`routing-preset-warn-${p.id}`}>
                            {warnText}
                          </Badge>
                        )}
                      </div>
                      <div className={styles.presetMeta}>
                        <EndpointIcon backend={p.cli} size={15} decorative />
                        <span>{cliName(p.cli)}</span>
                      </div>
                      <div className={styles.presetSub}>
                        {p.source === 'thirdParty'
                          ? p.model
                            ? refSlashLabel(gateway, p.model)
                            : t('ui.cli-monitor.third-party')
                          : `${sourceText} · ${p.model || t('ui.models.runner-picker-default-model')}`}
                      </div>
                      <div className={styles.presetFoot}>
                        {(() => {
                          const effText = presetEffortText(p, gateway);
                          return effText ? (
                            <span className={styles.presetBadge}>
                              {t('ui.chat-settings.reasoning-effort')}: {effText}
                            </span>
                          ) : (
                            <span />
                          );
                        })()}
                        <span className={styles.presetActions}>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            data-testid={`routing-preset-edit-${p.id}`}
                            onClick={() => openEditPreset(p)}
                          >
                            {t('ui.foundation.edit')}
                          </Button>
                          {!isBuiltin && (
                            <IconButton
                              size="sm"
                              label={t('ui.chat-settings.routing-preset-delete')}
                              data-testid={`routing-preset-delete-${p.id}`}
                              onClick={() => deleteCustomPreset(p.id)}
                              icon={<Icon icon={Trash} size={14} />}
                            />
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsGroup>

          <SettingsGroup
            title={t('ui.chat-settings.routing-table-title')}
            description={t('ui.chat-settings.routing-table-desc')}
            data-testid="routing-routes-group"
          >
            <SettingRow
              title={t('ui.chat-settings.let-nomi-hand-off-tasks-to-coding-assistants')}
              description={t('ui.chat-settings.when-off-nomi-won-t-hand-off-subtasks')}
            >
              <Switch
                checked={delegateEnabled}
                onChange={(v) => saveDelegate({ enabled: v })}
                aria-label={t('ui.chat-settings.let-nomi-hand-off-tasks-to-coding-assistants')}
                data-testid="delegate-enabled"
              />
            </SettingRow>
            <SettingRow
              title={t('ui.chat-settings.routing-auto-complexity')}
              description={t('ui.chat-settings.routing-auto-complexity-desc')}
            >
              <Switch
                checked={autoComplexity}
                disabled={!delegateEnabled}
                onChange={(v) => saveDelegate({ autoComplexity: v })}
                aria-label={t('ui.chat-settings.routing-auto-complexity')}
                data-testid="routing-auto-complexity"
              />
            </SettingRow>
            {ROUTABLE_TASK_KINDS.map((kind) => {
              const target = routes[kind];
              const isCustom = target?.kind === 'custom';
              const selectValue = isCustom
                ? CURRENT_CUSTOM_OPTION
                : presets.length === 0
                  ? DEFAULT_NOMI_OPTION
                  : `preset:${target?.kind === 'preset' ? target.presetId : presets[0]!.id}`;
              const options = [
                ...(isCustom
                  ? [
                      {
                        value: CURRENT_CUSTOM_OPTION,
                        label: t(
                          'ui.chat-settings.routing-custom-summary',
                          formatRunnerSummary(target, gateway),
                        ),
                      },
                    ]
                  : []),
                ...(presets.length === 0
                  ? [
                      {
                        value: DEFAULT_NOMI_OPTION,
                        label: t('ui.models.routing-default-agent-option', brand.appName),
                      },
                    ]
                  : []),
                ...presets.map((p) => ({
                  value: `preset:${p.id}`,
                  label: `${presetDisplayLabel(p)} · ${formatRunnerSummary(p, gateway)}`,
                })),
                {
                  value: CUSTOM_OPTION,
                  label: t('ui.chat-settings.routing-custom-option'),
                },
              ];
              return (
                <SettingRow
                  key={kind}
                  title={routableTaskKindLabel(kind)}
                  className={delegateEnabled ? undefined : styles.routeOff}
                >
                  <div className={styles.routeControl}>
                    {isCustom && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!delegateEnabled}
                        data-testid={`routing-custom-edit-${kind}`}
                        onClick={() => openRouteCustomPicker(kind, target)}
                      >
                        {t('ui.chat-settings.routing-custom-edit')}
                      </Button>
                    )}
                    <Select
                      size="sm"
                      disabled={!delegateEnabled}
                      value={selectValue}
                      options={options}
                      aria-label={routableTaskKindLabel(kind)}
                      data-testid={`routing-target-${kind}`}
                      menuMinWidth={240}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === CUSTOM_OPTION) {
                          openRouteCustomPicker(kind, target);
                          return;
                        }
                        if (v === DEFAULT_NOMI_OPTION) {
                          const nextRoutes = { ...routes };
                          delete nextRoutes[kind];
                          saveDelegate({ routes: nextRoutes });
                          return;
                        }
                        if (v.startsWith('preset:')) {
                          const presetId = v.slice('preset:'.length);
                          saveDelegate({
                            routes: {
                              ...routes,
                              [kind]: { kind: 'preset', presetId },
                            },
                          });
                        }
                      }}
                    />
                  </div>
                </SettingRow>
              );
            })}
          </SettingsGroup>
        </>
      )}

      <SettingsGroup
        title={t('ui.models.nomi-and-helper-title')}
        description={t('ui.models.nomi-and-helper-desc')}
        data-testid="routing-nomi-helper-group"
        actions={
          !picker.length ? (
            <Button size="sm" variant="secondary" onClick={onOpenProviders}>
              {t('ui.models.add-third-party-provider')}
            </Button>
          ) : undefined
        }
      >
        <SettingRow title={t('ui.models.nomi-ai')} description={t('ui.models.model-for-nomi-chat')}>
          <div className={styles.routeControl}>
            <ModelPicker
              providers={picker}
              size="sm"
              browse
              value={nomiModels.main ?? null}
              onChange={(v) => assignNomi({ main: v })}
              placeholder={
                picker.length
                  ? t('ui.models.choose-a-model')
                  : t('ui.models.add-a-third-party-provider-first')
              }
              disabled={!picker.length}
              aria-label={t('ui.models.model-for-nomi-chat')}
              data-testid="routing-nomi-main"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={showNomiMore}
              data-testid="routing-nomi-more"
              onClick={() => setShowNomiMore((v) => !v)}
            >
              {t('ui.models.more-purposes')}
              <Icon icon={showNomiMore ? ChevronDown : ChevronRight} size={14} />
            </Button>
          </div>
        </SettingRow>
        {showNomiMore && (
          <>
            <SettingRow title={t('ui.models.tool-calls')}>
              <ModelPicker
                providers={picker}
                size="sm"
                browse
                extraOptions={SAME_AS_CHAT}
                value={nomiModels.tools ?? FOLLOW}
                onChange={(v) => assignNomi({ tools: v === FOLLOW ? null : v })}
                disabled={!picker.length}
                aria-label={t('ui.models.model-for-tool-calls')}
                data-testid="routing-nomi-tools"
              />
            </SettingRow>
            <SettingRow title={t('ui.models.summaries')}>
              <ModelPicker
                providers={picker}
                size="sm"
                browse
                extraOptions={SAME_AS_CHAT}
                value={nomiModels.summary ?? FOLLOW}
                onChange={(v) => assignNomi({ summary: v === FOLLOW ? null : v })}
                disabled={!picker.length}
                aria-label={t('ui.models.model-for-summaries')}
                data-testid="routing-nomi-summary"
              />
            </SettingRow>
            <SettingRow title={t('ui.models.image-generation')}>
              <ModelPicker
                providers={imagePicker}
                size="sm"
                browse
                extraOptions={AUTO_IMAGE}
                value={nomiModels.image ?? UNSET}
                onChange={(v) => assignNomi({ image: v === UNSET ? null : v })}
                disabled={!imagePicker.length}
                placeholder={t('ui.models.no-image-models')}
                aria-label={t('ui.models.model-for-image-generation')}
                data-testid="routing-nomi-image"
              />
            </SettingRow>
          </>
        )}
        <SettingRow
          title={t('ui.models.global-helper-model')}
          description={t('ui.models.global-helper-model-desc')}
        >
          <ModelPicker
            providers={picker}
            size="sm"
            browse
            extraOptions={UNSET_HELPER_OPTIONS}
            value={gateway?.helperModel ?? UNSET}
            onChange={setHelperModel}
            disabled={!gateway}
            aria-label={t('ui.models.global-helper-model')}
            data-testid="routing-helper-model"
          />
        </SettingRow>
      </SettingsGroup>

      {pickerSession && (
        <RunnerModelPicker
          open
          value={pickerSession.initial}
          installed={delegateState?.installed}
          localAvailable={delegateState?.localAvailable}
          gateway={gateway}
          onConfirm={handlePickerConfirm}
          onClose={() => setPickerSession(null)}
          onOpenProviders={() => {
            setPickerSession(null);
            onOpenProviders();
          }}
        />
      )}
    </div>
  );
};
