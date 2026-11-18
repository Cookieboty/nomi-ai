/**
 * 两栏复合执行器选择器：左栏选 agent（CLI），右栏按实际可用来源展示本机/官方账号，
 * 第三方与本地模型统一复用 @nomi-ai/ui 的 ModelPicker，底部选思考深度。
 */
import { cliName } from '@nomi-ai/cli-catalog';
import { Button, Icon, Input, Modal, ModalHostContext, ModelPicker, Select, t } from '@nomi-ai/ui';
import {
  IconCheck as Check,
  IconTerminal2 as Terminal,
  IconUser as User,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useCliAccounts } from '../../hooks/useCliAccounts';
import {
  accountDisplayLabel,
  accountSubtitle,
  isDefaultAccountLabel,
} from '../../services/cliAccountClient';
import { useHasLocalLogin } from '../../services/cliLauncherClient';
import {
  CLI_KINDS,
  codingProviders,
  preferredThirdPartyModelForCli,
  refSlashLabel,
} from '../../services/cliSource';
import type { DelegateCli, RunnerEffort, RunnerSource } from '../../services/delegateClient';
import type { GatewayState } from '../../services/gatewayClient';
import {
  harnessClient,
  type BackendModelCatalog,
  type ReasoningEffort,
} from '../../services/harnessClient';
import { pickerProviders } from '../../services/nomiModel';
import { thinkingProfileOf } from '../../services/thinkingDepth';
import { hasOfficialAccount, thirdPartyOnly } from '../../utils/cliCaps';
import { EndpointIcon } from '../EndpointIcon';
import { thinkingLevelLabel } from '../ModelControls/effortLabel';

import styles from './index.module.css';

export interface RunnerSpecValue {
  cli: DelegateCli;
  source: RunnerSource;
  accountId?: string | null;
  model?: string | null;
  reasoningEffort?: RunnerEffort | null;
}

export interface RunnerModelPickerProps {
  open: boolean;
  title?: string;
  value: RunnerSpecValue;
  installed?: readonly DelegateCli[];
  localAvailable?: Partial<Record<DelegateCli, boolean>>;
  gateway: GatewayState | null;
  onConfirm: (next: RunnerSpecValue) => void;
  onClose: () => void;
  onOpenProviders?: () => void;
}

const NO_REASONING_BACKENDS = new Set(['gemini', 'dsh']);
const EFFORT_ORDER: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

interface ModelEffortSpec {
  supported: boolean;
  levels: readonly RunnerEffort[];
  defaultLevel: RunnerEffort | null;
  hint: string | null;
}

function resolveModelEffortSpec(params: {
  draft: RunnerSpecValue;
  gateway: GatewayState | null;
  catalog: BackendModelCatalog | null;
}): ModelEffortSpec {
  const { draft, gateway, catalog } = params;
  if (draft.source === 'thirdParty') {
    if (!draft.model) {
      return { supported: false, levels: [], defaultLevel: null, hint: null };
    }
    const profile = thinkingProfileOf(gateway, draft.model);
    if (!profile) {
      return {
        supported: false,
        levels: [],
        defaultLevel: null,
        hint: t('ui.chat-settings.this-model-has-no-reasoning-effort'),
      };
    }
    return {
      supported: true,
      levels: profile.levels as RunnerEffort[],
      defaultLevel: profile.default as RunnerEffort,
      hint: null,
    };
  }
  if (NO_REASONING_BACKENDS.has(draft.cli)) {
    return {
      supported: false,
      levels: [],
      defaultLevel: null,
      hint: t(
        'ui.chat-settings.has-no-documented-reasoning-effort-control-nomi-will',
        cliName(draft.cli),
      ),
    };
  }
  const info = draft.model
    ? (catalog?.models.find((m) => m.id === draft.model) ?? null)
    : (catalog?.defaultModel ?? null);
  if (info && !info.reasoning) {
    return {
      supported: false,
      levels: [],
      defaultLevel: null,
      hint: t('ui.chat-settings.this-model-has-no-reasoning-effort'),
    };
  }
  if (info && info.efforts.length > 0) {
    const def =
      info.defaultEffort && info.efforts.includes(info.defaultEffort) ? info.defaultEffort : null;
    return {
      supported: true,
      levels: info.efforts as RunnerEffort[],
      defaultLevel: def as RunnerEffort | null,
      hint: null,
    };
  }
  const unionLevels = EFFORT_ORDER.filter((e) =>
    catalog?.models.some((m) => m.efforts.includes(e)),
  );
  return {
    supported: true,
    levels: unionLevels.length > 0 ? unionLevels : (['low', 'medium', 'high'] as const),
    defaultLevel: null,
    hint: null,
  };
}

const ModelEffortRow: React.FC<{
  spec: ModelEffortSpec;
  value: RunnerEffort | null;
  onChange: (next: RunnerEffort | null) => void;
}> = ({ spec, value, onChange }) => {
  if (!spec.supported) {
    if (!spec.hint) return null;
    return (
      <div className={styles.modelEffortRow} data-testid="runner-picker-effort-unavailable">
        <span className={styles.effortLabel}>{t('ui.chat-settings.reasoning-effort')}</span>
        <span className={styles.effortUnavailableHint}>{spec.hint}</span>
      </div>
    );
  }
  const autoLabel = spec.defaultLevel
    ? `${t('ui.providers-schedule.default')} (${thinkingLevelLabel(spec.defaultLevel)})`
    : t('ui.providers-schedule.default');
  return (
    <div
      className={styles.modelEffortRow}
      role="group"
      aria-label={t('ui.chat-settings.reasoning-effort')}
      data-testid="runner-picker-effort-group"
    >
      <span className={styles.effortLabel}>{t('ui.chat-settings.reasoning-effort')}</span>
      <div className={styles.effortPills}>
        <button
          type="button"
          className={styles.effortBtn}
          aria-pressed={value === null}
          data-testid="runner-picker-effort-auto"
          onClick={() => onChange(null)}
        >
          {autoLabel}
        </button>
        {spec.levels.map((lv) => (
          <button
            key={lv}
            type="button"
            className={styles.effortBtn}
            aria-pressed={value === lv}
            data-testid={`runner-picker-effort-${lv}`}
            onClick={() => onChange(lv)}
          >
            {thinkingLevelLabel(lv)}
          </button>
        ))}
      </div>
    </div>
  );
};

export const RunnerModelPicker: React.FC<RunnerModelPickerProps> = ({
  open,
  title,
  value,
  installed,
  localAvailable,
  gateway,
  onConfirm,
  onClose,
  onOpenProviders,
}) => {
  const [draft, setDraft] = useState<RunnerSpecValue>(value);
  const [catalogState, setCatalogState] = useState<{
    cli: DelegateCli;
    /** 目录按来源缓存：官方与本机登录的模型目录不同 */
    source: 'official' | 'local';
    catalog: BackendModelCatalog | null;
  } | null>(null);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const providers = useMemo(() => codingProviders(gateway), [gateway]);
  const picker = useMemo(() => pickerProviders(gateway?.providers ?? []), [gateway]);
  const supportsOfficial = hasOfficialAccount(draft.cli);
  const launcherLocal = useHasLocalLogin(open ? draft.cli : null);
  const hasLocal =
    supportsOfficial &&
    (localAvailable && draft.cli in localAvailable
      ? Boolean(localAvailable[draft.cli])
      : launcherLocal);
  const { accounts, ready: accountsReady } = useCliAccounts(open ? draft.cli : null);
  const loggedInAccounts = useMemo(() => accounts.filter((a) => a.loggedIn), [accounts]);
  const hasOfficial = supportsOfficial && loggedInAccounts.length > 0;

  const defaultTpModel = useCallback(
    (cli: DelegateCli) => preferredThirdPartyModelForCli(gateway, cli),
    [gateway],
  );
  const defaultOfficialId = useMemo(
    () => (loggedInAccounts.find((a) => a.active) ?? loggedInAccounts[0])?.id ?? null,
    [loggedInAccounts],
  );

  useEffect(() => {
    if (!open || !accountsReady) return;
    setDraft((prev) => {
      const tpFallback = defaultTpModel(prev.cli);
      if (!supportsOfficial || (!hasLocal && !hasOfficial)) {
        const nextModel = (prev.source === 'thirdParty' ? prev.model : null) || tpFallback;
        if (prev.source === 'thirdParty' && (prev.model ?? null) === (nextModel ?? null)) {
          return prev;
        }
        return { ...prev, source: 'thirdParty', accountId: null, model: nextModel };
      }
      if (prev.source === 'local' && !hasLocal) {
        if (hasOfficial) return { ...prev, source: 'official', accountId: defaultOfficialId };
        return { ...prev, source: 'thirdParty', accountId: null, model: tpFallback };
      }
      if (prev.source === 'official') {
        if (!hasOfficial) {
          if (hasLocal) return { ...prev, source: 'local', accountId: null };
          return { ...prev, source: 'thirdParty', accountId: null, model: tpFallback };
        }
        if (!prev.accountId || !loggedInAccounts.some((a) => a.id === prev.accountId)) {
          if (defaultOfficialId && prev.accountId !== defaultOfficialId) {
            return { ...prev, accountId: defaultOfficialId };
          }
        }
      }
      return prev;
    });
  }, [
    open,
    accountsReady,
    supportsOfficial,
    hasLocal,
    hasOfficial,
    defaultOfficialId,
    loggedInAccounts,
    defaultTpModel,
  ]);

  const isThirdParty = draft.source === 'thirdParty';
  const canConfirm = !isThirdParty || Boolean(draft.model);

  useEffect(() => {
    if (!open || !supportsOfficial || (!hasLocal && !hasOfficial) || !harnessClient.available()) {
      return;
    }
    let alive = true;
    const cli = draft.cli;
    // 按草稿当前来源取目录（不是「有没有官方账号」）：两个登录都在时，本机登录与官方账号的模型目录不同
    const source: 'official' | 'local' = draft.source === 'local' ? 'local' : 'official';
    void harnessClient
      .modelCatalog(cli, { source })
      .then((catalog) => {
        // 期间切了来源或 CLI：迟到的结果丢掉，不覆盖当前草稿的目录
        if (alive) setCatalogState({ cli, source, catalog });
      })
      .catch(() => {
        if (alive) setCatalogState({ cli, source, catalog: null });
      });
    return () => {
      alive = false;
    };
  }, [open, supportsOfficial, hasLocal, hasOfficial, draft.cli, draft.source]);

  const officialModels = useMemo(
    () =>
      catalogState?.cli === draft.cli &&
      catalogState.source === (draft.source === 'local' ? 'local' : 'official')
        ? (catalogState.catalog?.models ?? [])
        : [],
    [catalogState, draft.cli, draft.source],
  );
  const officialModelOptions = useMemo(() => {
    if (!officialModels.length) return [];
    const opts = [
      { value: '', label: t('ui.models.runner-picker-default-model') },
      ...officialModels.map((m) => ({ value: m.id, label: m.label ?? m.id })),
    ];
    if (draft.model && !officialModels.some((m) => m.id === draft.model)) {
      opts.push({ value: draft.model, label: draft.model });
    }
    return opts;
  }, [officialModels, draft.model]);

  const switchCli = (nextCli: DelegateCli) => {
    if (nextCli === draft.cli) return;
    if (thirdPartyOnly(nextCli)) {
      setDraft((d) => ({
        ...d,
        cli: nextCli,
        source: 'thirdParty',
        accountId: null,
        model: defaultTpModel(nextCli),
      }));
      return;
    }
    const nextLocalKnownFalse =
      localAvailable && nextCli in localAvailable && !localAvailable[nextCli];
    setDraft((d) => ({
      ...d,
      cli: nextCli,
      source: nextLocalKnownFalse && d.source === 'local' ? 'official' : d.source,
      accountId: d.source === 'official' ? null : d.accountId,
      model: d.source === 'thirdParty' ? d.model : null,
    }));
  };

  const selectLocal = () =>
    setDraft((d) => ({
      ...d,
      source: 'local',
      accountId: null,
      model: d.source === 'thirdParty' ? null : d.model,
    }));

  const selectOfficial = (accountId: string) =>
    setDraft((d) => ({
      ...d,
      source: 'official',
      accountId,
      model: d.source === 'thirdParty' ? null : d.model,
    }));

  const selectThirdParty = (ref: string) =>
    setDraft((d) => ({
      ...d,
      source: 'thirdParty',
      accountId: null,
      model: ref,
    }));

  const activeCatalog =
    catalogState?.cli === draft.cli &&
    catalogState.source === (draft.source === 'local' ? 'local' : 'official')
      ? catalogState.catalog
      : null;
  const effortSpec = useMemo(
    () => resolveModelEffortSpec({ draft, gateway, catalog: activeCatalog }),
    [draft, gateway, activeCatalog],
  );
  const effectiveEffort: RunnerEffort | null =
    effortSpec.supported &&
    draft.reasoningEffort &&
    effortSpec.levels.includes(draft.reasoningEffort)
      ? draft.reasoningEffort
      : null;

  const showAccountGroup = hasLocal || hasOfficial;
  const officialTitle = t('ui.chat-settings.official-accounts');
  const selectedOfficialId =
    draft.source === 'official' && hasOfficial
      ? draft.accountId && loggedInAccounts.some((a) => a.id === draft.accountId)
        ? draft.accountId
        : defaultOfficialId
      : null;

  const footer = (
    <div className={styles.footer}>
      <div className={styles.footerActions}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="runner-picker-cancel"
          onClick={onClose}
        >
          {t('ui.foundation.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canConfirm}
          data-testid="runner-picker-confirm"
          onClick={() => onConfirm({ ...draft, reasoningEffort: effectiveEffort })}
        >
          {t('ui.foundation.ok')}
        </Button>
      </div>
    </div>
  );

  return (
    <ModalHostContext.Provider value={null}>
      <Modal
        open={open}
        onClose={onClose}
        size="lg"
        title={title ?? t('ui.models.runner-picker-title')}
        footer={footer}
        data-testid="runner-model-picker"
      >
        <div className={styles.body}>
          <div className={styles.cliList} data-testid="runner-picker-clis">
            <div className={styles.colHeading}>{t('ui.models.runner-picker-clis')}</div>
            {CLI_KINDS.map((k) => {
              const selected = draft.cli === k;
              const isInstalled = installed ? installed.includes(k) : true;
              return (
                <button
                  key={k}
                  type="button"
                  className={styles.cliBtn}
                  data-selected={selected || undefined}
                  aria-pressed={selected}
                  data-testid={`runner-picker-cli-${k}`}
                  onClick={() => switchCli(k)}
                >
                  <EndpointIcon backend={k} size={18} decorative />
                  <span className={styles.cliBtnName}>{cliName(k)}</span>
                  <span className={styles.cliBadge}>
                    {t(
                      isInstalled
                        ? 'ui.knowledge-local.installed'
                        : 'ui.mascot-theme.not-installed',
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <div className={styles.sourcesCol} data-testid="runner-picker-sources">
            <div className={styles.colHeading}>{t('ui.models.runner-picker-sources')}</div>
            {showAccountGroup && (
              <div className={styles.group}>
                <div className={styles.groupTitle}>
                  {t('ui.models.runner-picker-local-official')}
                </div>
                {hasLocal && (
                  <button
                    type="button"
                    className={styles.optionRow}
                    data-selected={draft.source === 'local' || undefined}
                    data-testid="runner-picker-local"
                    onClick={selectLocal}
                  >
                    <Icon icon={Terminal} size={16} />
                    <span className={styles.optionMain}>
                      <span className={styles.optionTitle}>
                        {t('ui.chat-settings.cli-launcher-local')}
                      </span>
                      <span className={styles.optionHint}>
                        {t('ui.models.local-sign-in-detected')}
                      </span>
                    </span>
                    <span className={styles.okBadge}>{t('ui.models.local-sign-in-detected')}</span>
                    {draft.source === 'local' && <Icon icon={Check} size={14} />}
                  </button>
                )}

                {hasOfficial &&
                  loggedInAccounts.map((acc) => {
                    const active = selectedOfficialId === acc.id;
                    const titleText = accountDisplayLabel(acc);
                    const hintText =
                      accountSubtitle(acc) ||
                      (!isDefaultAccountLabel(titleText) &&
                      !acc.identity?.name &&
                      !acc.identity?.email
                        ? officialTitle
                        : '');
                    return (
                      <button
                        key={acc.id}
                        type="button"
                        className={styles.optionRow}
                        data-selected={active || undefined}
                        data-testid={`runner-picker-official-${acc.id}`}
                        onClick={() => selectOfficial(acc.id)}
                      >
                        <Icon icon={User} size={16} />
                        <span className={styles.optionMain}>
                          <span className={styles.optionTitle}>{titleText}</span>
                          {hintText && <span className={styles.optionHint}>{hintText}</span>}
                        </span>
                        {loggedInAccounts.length > 1 && acc.active && (
                          <span className={styles.okBadge}>
                            {t('ui.providers-schedule.default')}
                          </span>
                        )}
                        {active && <Icon icon={Check} size={14} />}
                      </button>
                    );
                  })}

                {((hasLocal && draft.source === 'local') ||
                  (hasOfficial && draft.source === 'official')) && (
                  <div className={styles.officialModelBox}>
                    <label className={styles.officialModelLabel} htmlFor="runner-official-model">
                      {t('ui.models.runner-picker-official-model')}
                    </label>
                    {officialModelOptions.length > 0 ? (
                      <Select
                        id="runner-official-model"
                        size="sm"
                        value={draft.model ?? ''}
                        options={officialModelOptions}
                        data-testid="runner-picker-official-model"
                        onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || null }))}
                      />
                    ) : (
                      <Input
                        id="runner-official-model"
                        size="sm"
                        value={draft.model ?? ''}
                        placeholder={t('ui.models.runner-picker-official-model-placeholder')}
                        data-testid="runner-picker-official-model"
                        onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || null }))}
                      />
                    )}
                    <ModelEffortRow
                      spec={effortSpec}
                      value={effectiveEffort}
                      onChange={(next) => setDraft((d) => ({ ...d, reasoningEffort: next }))}
                    />
                  </div>
                )}
              </div>
            )}

            <div className={styles.group}>
              <div className={styles.groupTitle}>
                {t('ui.models.runner-picker-third-party-local')}
              </div>
              {picker.length === 0 ? (
                <div className={styles.emptyBox}>
                  <p className={styles.emptyNote}>{t('ui.models.runner-picker-no-third-party')}</p>
                  {onOpenProviders && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      data-testid="runner-picker-add-provider"
                      onClick={onOpenProviders}
                    >
                      {t('ui.models.add-third-party-provider')}
                    </Button>
                  )}
                </div>
              ) : (
                <div className={styles.tpPickerBox} data-selected={isThirdParty || undefined}>
                  {isThirdParty && draft.model && (
                    <div className={styles.tpSelectedHead}>
                      <div className={styles.tpSelectedBar} data-testid="runner-picker-tp-selected">
                        <Icon icon={Check} size={14} />
                        <span className={styles.tpSelectedText}>
                          {refSlashLabel(gateway, draft.model)}
                        </span>
                      </div>
                      <ModelEffortRow
                        spec={effortSpec}
                        value={effectiveEffort}
                        onChange={(next) => setDraft((d) => ({ ...d, reasoningEffort: next }))}
                      />
                    </div>
                  )}
                  <ModelPicker
                    inline
                    browse
                    purpose="coding"
                    inlineMaxHeight={showAccountGroup ? 240 : 320}
                    providers={picker}
                    value={isThirdParty ? (draft.model ?? null) : null}
                    onChange={selectThirdParty}
                    optionTestId={(ref) => `runner-picker-tp-${ref}`}
                    aria-label={t('ui.models.runner-picker-third-party-local')}
                    data-testid="runner-picker-tp-picker"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </ModalHostContext.Provider>
  );
};
