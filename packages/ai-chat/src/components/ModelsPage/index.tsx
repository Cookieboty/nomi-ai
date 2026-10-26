/**
 * 设置 →「模型」页（docs/design/unified-gateway.md §4.1）：第三方供应商与模型分配，数据来自网关（ai:gateway:*）。
 * - 分配：Nomi 对话（main / tools / summary）；各编程助手的第三方模型（标签选「第三方」时用）与「新标签默认用」；
 * - 官方账号不在这里：仍在「编程助手」页原位置（安装、账号也在那里）。
 */
import { BrandIcon, Button, Icon, Input, ModelPicker, Select, Switch, t } from '@nomi-ai/ui';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Boxes,
  Info,
  MoreHorizontal,
  Plus,
  SquareTerminal,
  Waypoints,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { useCliAccounts } from '../../hooks/useCliAccounts';
import {
  CLI_KINDS,
  newTabOptions,
  newTabPatch,
  newTabSelectValue,
  providerOfRef,
  type CliKind,
} from '../../services/cliSource';
import {
  gatewayClient,
  WIRE_LABEL,
  WIRES,
  type ClientModels,
  type GatewayState,
  type ProviderView,
} from '../../services/gatewayClient';
import { pickerProviders, useGatewayState } from '../../services/nomiModel';
import { providerDisplayName } from '../../services/providerClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';
import { MediaAssignRow, MediaProvidersCard } from '../Media/MediaSettings';

import { AddProviderDialog } from './AddProviderDialog';
import styles from './index.module.css';
import { ModelsDataSyncCard } from './ModelsDataSyncCard';
import { keyName, ProviderDetailDialog } from './ProviderDetailDialog';
import { TerminalCommandsCard } from './TerminalCommandsCard';
import { useCliInstall } from './useCliInstall';

const FOLLOW = 'follow';
const UNSET = 'unset';
/** 选择器最前面的特殊选项：模块级常量（label 是翻译 key，由 Select 翻译）。
 *  内联数组每次渲染都是新的，会让 ModelPicker 每次都重建几百个选项 */
const SAME_AS_CHAT = [{ value: FOLLOW, label: 'ui.models.same-as-chat' }];
const FOLLOW_MAIN = [{ value: FOLLOW, label: 'ui.models.follow-main-model' }];
const NOT_SET = [{ value: UNSET, label: 'ui.cli-monitor.not-set' }];

type ModelsPatch = Partial<Omit<Record<keyof ClientModels, string | null>, 'tiers'>> & {
  tiers?: Partial<Record<TierId, string | null>>;
};
/** 编程助手一行的设置：第三方模型（部分）与「新标签默认用」 */
type CliAssignPatch = {
  models?: ModelsPatch;
  newTabSource?: 'official' | 'thirdParty';
  newTabAccountId?: string | null;
};
type TierId = keyof NonNullable<ClientModels['tiers']>;

/**
 * Claude Code 可单独指定的档位（不展开时都跟随主模型）。
 * Haiku 档就是 Claude Code 跑后台任务（起标题、摘要等）用的快速模型，旧版本的「小模型」已并入这里。
 */
const CLAUDE_TIERS: ReadonlyArray<{ id: TierId; label: string }> = [
  { id: 'opus', label: 'ui.models.opus-tier' },
  { id: 'sonnet', label: 'ui.models.sonnet-tier' },
  { id: 'haiku', label: 'ui.models.haiku-tier-background-tasks' },
  { id: 'fable', label: 'ui.models.fable-tier' },
];

export const ModelsPage: React.FC = () => {
  const state = useGatewayState();
  const [adding, setAdding] = useState(false);
  const [showWire, setShowWire] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** 展开了「各档模型 / 更多」的编程助手 */
  const [openCli, setOpenCli] = useState<CliKind | null>(null);
  const [offer, setOffer] = useState<ProviderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeSeen, setRevokeSeen] = useState(false);
  /** 模型页顶部「高级」：请求体上限等 */
  const [showAdvanced, setShowAdvanced] = useState(false);

  const providers = useMemo(() => state?.providers ?? [], [state]);
  const picker = useMemo(() => pickerProviders(providers), [providers]);
  const nomi = state?.clients.nomi?.models ?? {};
  const common = { providers: picker, showWire, size: 'sm' as const };

  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e: Error) => setError(e.message));
  };
  const cli = useCliInstall(setError);
  const editingProvider = providers.find((p) => p.id === editing) ?? null;
  /** null 表示清除（跟随对话） */
  const assign = (patch: Partial<Record<keyof ClientModels, string | null>>) =>
    run(gatewayClient.setAssignment('nomi', { models: patch as ClientModels }));

  /** 编程助手的第三方模型 / 新标签默认用；null 表示清除 */
  const assignCli = (kind: CliKind, patch: CliAssignPatch) =>
    run(
      gatewayClient.setAssignment(kind, patch as Parameters<typeof gatewayClient.setAssignment>[1]),
    );

  const onSaved = (p: ProviderView) => {
    setAdding(false);
    if (!nomi.main && p.models.some((m) => m.enabled)) setOffer(p);
  };

  /** 一键把新供应商的第一个模型设为 Nomi 对话的模型 */
  const applyOffer = (p: ProviderView) => {
    const first = p.models.find((x) => x.enabled && x.toolCalling !== false);
    if (first) assign({ main: `${p.id}/${first.id}` });
    setOffer(null);
  };

  const status = state?.status;
  return (
    <div className={styles.page} data-testid="models-page">
      <div className={styles.head}>
        <label className={styles.inlineSwitch}>
          <Switch checked={showWire} onChange={setShowWire} aria-label={t('ui.models.show-apis')} />
          <span>{t('ui.models.show-apis')}</span>
        </label>
        <label
          className={styles.inlineSwitch}
          title={t('ui.models.when-on-parameters-the-model-doesn-t-support')}
        >
          <Switch
            checked={state?.strictParams === true}
            onChange={(v) => run(gatewayClient.setOptions({ strictParams: v }))}
            disabled={!state}
            aria-label={t('ui.models.strict-mode')}
            data-testid="models-strict"
          />
          <span>{t('ui.models.strict-mode')}</span>
        </label>
        <button
          type="button"
          className={styles.advancedToggle}
          aria-expanded={showAdvanced}
          data-testid="models-advanced-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <Icon icon={showAdvanced ? ChevronDown : ChevronRight} size={14} />
          <span>{t('ui.models.advanced')}</span>
        </button>
      </div>
      {showAdvanced && (
        <div className={styles.advanced} data-testid="models-advanced">
          <label
            className={styles.inlineField}
            title={t('ui.models.posts-over-the-limit-get-413-default-32')}
          >
            <span>{t('ui.models.request-body-limit')}</span>
            <Input
              size="sm"
              type="number"
              min={1}
              max={256}
              step={1}
              inputMode="numeric"
              className={styles.bodyLimitInput}
              disabled={!state}
              value={Math.round((state?.maxRequestBodyBytes ?? 32 * 1024 * 1024) / (1024 * 1024))}
              onChange={(e) => {
                const mib = Number(e.target.value);
                if (!Number.isFinite(mib)) return;
                run(
                  gatewayClient.setOptions({
                    maxRequestBodyBytes: Math.round(mib * 1024 * 1024),
                  }),
                );
              }}
              aria-label={t('ui.models.request-body-limit')}
              data-testid="models-body-limit"
            />
            <span className={styles.muted}>{t('ui.models.mib')}</span>
          </label>
          <p className={styles.sub}>{t('ui.models.posts-over-the-limit-get-413-default-32')}</p>
        </div>
      )}

      {status?.state === 'failed' && (
        <div className={styles.offer} role="alert" data-testid="gateway-failed">
          <Icon icon={AlertCircle} size={14} />
          <span>{t('ui.models.the-model-gateway-isn-t-running', status.error)}</span>
          <Button size="sm" variant="secondary" onClick={() => run(gatewayClient.retry())}>
            {t('ui.mascot-theme.retry')}
          </Button>
        </div>
      )}
      {state?.legacyRevoke?.revoked.length && !revokeSeen ? (
        <div
          className={`${styles.offer} ${styles.notice}`}
          role="status"
          data-testid="legacy-revoked"
        >
          <Icon icon={Info} size={16} />
          <span>{t('ui.models.clis-in-your-terminal-are-back-to-your')}</span>
          <Button size="sm" variant="ghost" onClick={() => setRevokeSeen(true)}>
            {t('ui.models.got-it')}
            <Icon icon={X} size={14} />
          </Button>
        </div>
      ) : null}
      {state?.legacyRevoke?.failed.map((f) => (
        <p
          key={f.kind}
          className={styles.error}
          role="alert"
          data-testid={`legacy-revoke-failed-${f.kind}`}
        >
          {t('ui.models.couldn-t-undo-the-third-party-settings-an', f.kind, f.error)}
        </p>
      ))}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {offer && (
        <div className={styles.offer} role="status" data-testid="models-offer">
          <span>{t('ui.models.use-for-nomi-chat', offer.name)}</span>
          <Button size="sm" variant="primary" onClick={() => applyOffer(offer)}>
            {t('ui.models.fill-in')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOffer(null)}>
            {t('ui.models.no-thanks')}
          </Button>
        </div>
      )}

      <ModelsDataSyncCard gateway={state ?? null} />

      <section className={styles.card} aria-labelledby="models-assign">
        <h3 id="models-assign" className={styles.cardTitle}>
          <Icon icon={Waypoints} size={16} />
          {t('ui.models.assignments')}
        </h3>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t('ui.usage-tools.nomi-chat')}</span>
          <ModelPicker
            {...common}
            className={styles.picker}
            value={nomi.main ?? null}
            onChange={(v) => assign({ main: v })}
            placeholder={
              picker.length
                ? t('ui.models.choose-a-model')
                : t('ui.models.add-a-third-party-provider-first')
            }
            disabled={!picker.length}
            aria-label={t('ui.models.model-for-nomi-chat')}
            data-testid="assign-chat"
          />
        </div>
        <div className={styles.row}>
          <span className={`${styles.rowLabel} ${styles.rowLabelSub}`}>
            {t('ui.models.tool-calls')}
          </span>
          <ModelPicker
            {...common}
            className={styles.picker}
            extraOptions={SAME_AS_CHAT}
            value={nomi.tools ?? FOLLOW}
            onChange={(v) => assign({ tools: v === FOLLOW ? null : v })}
            disabled={!picker.length}
            aria-label={t('ui.models.model-for-tool-calls')}
            data-testid="assign-tools"
          />
        </div>
        <div className={styles.row}>
          <span className={`${styles.rowLabel} ${styles.rowLabelSub}`}>
            {t('ui.models.summaries')}
          </span>
          <ModelPicker
            {...common}
            className={styles.picker}
            extraOptions={SAME_AS_CHAT}
            value={nomi.summary ?? FOLLOW}
            onChange={(v) => assign({ summary: v === FOLLOW ? null : v })}
            disabled={!picker.length}
            aria-label={t('ui.models.model-for-summaries')}
            data-testid="assign-summary"
          />
        </div>
        <MediaAssignRow rowClassName={styles.row} labelClassName={styles.rowLabel} />
      </section>

      <section className={styles.card} aria-labelledby="models-cli" data-testid="models-cli">
        <h3 id="models-cli" className={styles.cardTitle}>
          <Icon icon={SquareTerminal} size={16} />
          {t('ui.providers-schedule.coding-agents')}
        </h3>
        <p className={styles.sub}>
          {t('ui.models.each-coding-assistant-tab-can-choose-official-account')}
        </p>
        <div className={`${styles.cliRow} ${styles.cliHead}`}>
          <span />
          <span>{t('ui.models.third-party-models')}</span>
          <span />
          <span>{t('ui.models.new-tabs-use')}</span>
        </div>
        {CLI_KINDS.map((kind) => (
          <CliRow
            key={kind}
            kind={kind}
            client={state?.clients[kind]}
            gateway={state ?? null}
            common={common}
            disabled={!picker.length}
            open={openCli === kind}
            onToggle={() => setOpenCli((x) => (x === kind ? null : kind))}
            onAssign={(patch) => assignCli(kind, patch)}
            missing={cli.missing(kind)}
            installBusy={cli.busy}
            onInstall={() => cli.install(kind)}
          />
        ))}
      </section>
      {cli.dialog}

      <MediaProvidersCard className={styles.card} titleClassName={styles.cardTitle} />

      <section className={styles.card} aria-labelledby="models-providers">
        <div className={styles.cardHeadRow}>
          <h3 id="models-providers" className={styles.cardTitle}>
            <Icon icon={Boxes} size={16} />
            {t('ui.models.third-party-providers')}
          </h3>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAdding(true)}
            disabled={!state}
            data-testid="add-provider"
          >
            <Icon icon={Plus} size={14} />
            {t('ui.foundation.add')}
          </Button>
        </div>
        {state && !providers.length && (
          <p className={styles.muted} data-testid="models-empty">
            {t('ui.models.no-third-party-providers-yet-add-one-and')}
          </p>
        )}
        {providers.map((p) => (
          <ProviderRow key={p.id} p={p} onOpen={() => setEditing(p.id)} />
        ))}
      </section>

      <TerminalCommandsCard />

      <AddProviderDialog open={adding} onClose={() => setAdding(false)} onSaved={onSaved} />
      <ProviderDetailDialog
        provider={editingProvider}
        providers={providers}
        allowedPrivateHosts={state?.allowedPrivateHosts ?? []}
        showWire={showWire}
        onClose={() => setEditing(null)}
        onRemove={(p) => {
          if (!window.confirm(t('ui.models.delete-provider-and-all-its-keys', p.name))) return;
          setEditing(null);
          run(gatewayClient.removeProvider(p.id));
        }}
      />
    </div>
  );
};

/* ------------------------------ 编程助手一行 ------------------------------ */

const CliRow: React.FC<{
  kind: CliKind;
  client: GatewayState['clients'][CliKind];
  gateway: GatewayState | null;
  common: Pick<React.ComponentProps<typeof ModelPicker>, 'providers' | 'showWire' | 'size'>;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onAssign: (patch: CliAssignPatch) => void;
  /** 没安装：整行变灰，只显示「安装」 */
  missing: boolean;
  installBusy: string | null;
  onInstall: () => void;
}> = ({
  kind,
  client,
  gateway,
  common,
  disabled,
  open,
  onToggle,
  onAssign,
  missing,
  installBusy,
  onInstall,
}) => {
  const m = client?.models ?? {};
  const name = ENDPOINT_NAME[kind];
  const { accounts, error: accountsError } = useCliAccounts(kind);
  if (missing)
    return (
      <div className={`${styles.cliRow} ${styles.cliMissing}`} data-testid={`cli-row-${kind}`}>
        <span className={styles.cliName}>
          <EndpointIcon backend={kind} size={16} decorative />
          {name}
        </span>
        <span className={styles.muted}>{t('ui.mascot-theme.not-installed')}</span>
        <span />
        <Button
          size="sm"
          variant="secondary"
          disabled={installBusy !== null}
          title={
            installBusy && installBusy !== kind
              ? t('ui.foundation.another-install-update-is-already-in-progress')
              : undefined
          }
          onClick={onInstall}
          aria-label={t('ui.cli-monitor.install-named', name)}
          data-testid={`cli-install-${kind}`}
        >
          <Icon icon={Download} size={14} />
          {installBusy === kind ? t('ui.cli-monitor.working') : t('ui.models.install')}
        </Button>
      </div>
    );
  const source = client?.newTabSource ?? 'official';
  // eslint-disable-next-line nomi/no-cli-literal -- 各档模型（opus / sonnet / haiku / fable）是 Claude Code 独有的配置
  const claude = kind === 'claude';
  const newTabCtx = { kind, client, gateway, accounts };
  const sourceOptions = newTabOptions(newTabCtx);
  const sourceValue = newTabSelectValue(client, kind);
  const pickSource = (value: string) => {
    const patch = newTabPatch(value, newTabCtx);
    if (patch) onAssign(patch as CliAssignPatch);
  };
  const setMain = (v: string) => {
    if (v !== UNSET) {
      // 主模型本身带有供应商；选模型就同时把「新标签默认」切到该供应商，
      // 避免出现默认供应商与模型属于不同供应商的无效组合。
      const providerId = providerOfRef(v);
      return onAssign({
        models: { main: v },
        ...(providerId ? { newTabSource: 'thirdParty' as const, newTabAccountId: null } : {}),
      });
    }
    // 清掉主模型后「第三方」不能再作新标签默认
    onAssign({
      models: { main: null },
      ...(source === 'thirdParty' ? { newTabSource: 'official' as const } : {}),
    });
  };
  /** 旧配置只设了「小模型」时，Haiku 档显示它；改 Haiku 档时一并清掉旧字段 */
  const tierValue = (id: TierId) => m.tiers?.[id] ?? (id === 'haiku' ? m.small : undefined);
  const setTier = (id: TierId, v: string) =>
    onAssign({
      models: {
        tiers: { ...m.tiers, [id]: v === FOLLOW ? null : v },
        ...(id === 'haiku' && m.small ? { small: null } : {}),
      },
    });
  return (
    <>
      <div className={styles.cliRow} data-testid={`cli-row-${kind}`}>
        <span className={styles.cliName}>
          <EndpointIcon backend={kind} size={16} decorative />
          {name}
        </span>
        <ModelPicker
          {...common}
          purpose="coding"
          className={styles.picker}
          extraOptions={NOT_SET}
          value={m.main ?? UNSET}
          onChange={setMain}
          disabled={disabled}
          aria-label={t('ui.models.third-party-model', name)}
          data-testid={`cli-main-${kind}`}
        />
        <button
          type="button"
          className={styles.expand}
          aria-expanded={open}
          data-testid={claude ? 'cli-tiers-toggle' : `cli-more-${kind}`}
          onClick={onToggle}
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
          {claude ? t('ui.models.per-tier-models') : t('ui.voice-mascot.more')}
        </button>
        <Select
          size="sm"
          className={styles.source}
          options={sourceOptions}
          value={sourceValue}
          onChange={(e) => pickSource(e.target.value)}
          aria-label={t('ui.models.new-tabs-use-named', name)}
          data-testid={`cli-source-${kind}`}
          menuMinWidth={240}
          title={accountsError ? t('ui.models.failed-to-load-accounts', accountsError) : undefined}
        />
      </div>
      {accountsError ? (
        <div
          className={`${styles.cliRow} ${styles.tierRow}`}
          data-testid={`cli-accounts-error-${kind}`}
        >
          <span className={styles.muted}>
            {t('ui.models.failed-to-load-accounts', accountsError)}
          </span>
        </div>
      ) : null}
      {open && (
        <>
          {claude &&
            CLAUDE_TIERS.map((tier) => (
              <div key={tier.id} className={`${styles.cliRow} ${styles.tierRow}`}>
                <span className={styles.cliName}>{t(tier.label)}</span>
                <ModelPicker
                  {...common}
                  purpose="coding"
                  className={styles.picker}
                  extraOptions={FOLLOW_MAIN}
                  value={tierValue(tier.id) ?? FOLLOW}
                  onChange={(v) => setTier(tier.id, v)}
                  disabled={disabled}
                  aria-label={t('ui.models.claude-code', t(tier.label))}
                  data-testid={`cli-tier-${tier.id}`}
                />
              </div>
            ))}
          {claude && (
            <div className={`${styles.cliRow} ${styles.tierRow}`}>
              <span className={styles.cliName}>{t('ui.usage-tools.subagent')}</span>
              <ModelPicker
                {...common}
                purpose="coding"
                className={styles.picker}
                extraOptions={FOLLOW_MAIN}
                value={m.subagent ?? FOLLOW}
                onChange={(v) => onAssign({ models: { subagent: v === FOLLOW ? null : v } })}
                disabled={disabled}
                aria-label={t('ui.models.claude-code-subagent-model')}
                data-testid="cli-subagent"
              />
            </div>
          )}
          <div className={`${styles.cliRow} ${styles.tierRow}`}>
            <span
              className={styles.cliName}
              title={t('ui.models.used-for-helper-requests-such-as-titles-summaries')}
            >
              {t('ui.usage-tools.helper-model')}
            </span>
            <ModelPicker
              {...common}
              purpose="coding"
              className={styles.picker}
              extraOptions={FOLLOW_MAIN}
              value={m.summary ?? FOLLOW}
              onChange={(v) => onAssign({ models: { summary: v === FOLLOW ? null : v } })}
              disabled={disabled}
              aria-label={t('ui.models.helper-model-titles-summaries-etc', name)}
              data-testid={`cli-helper-${kind}`}
            />
          </div>
        </>
      )}
    </>
  );
};

/* ------------------------------ 供应商一行 ------------------------------ */

const ProviderRow: React.FC<{ p: ProviderView; onOpen: () => void }> = ({ p, onOpen }) => {
  const enabledCount = p.models.filter((x) => x.enabled).length;
  const fromEnv = p.source === 'env';
  const wires = WIRES.filter((w) => p.detected?.[w]?.ok ?? Boolean(p.urls[w]));
  const fi = p.keys.findIndex((k) => k.enabled && (k.lastError || !k.decryptable));
  const failing = fi >= 0 ? p.keys[fi]! : undefined;
  const warning = failing
    ? failing.decryptable
      ? t('ui.models.the-last-request-failed', keyName(failing, fi), failing.lastError ?? '')
      : t('ui.models.can-t-be-decrypted-please-enter-it-again', keyName(failing, fi))
    : undefined;
  const name = providerDisplayName(p.name);
  return (
    <div className={styles.provider} data-testid={`provider-${p.id}`}>
      <div className={styles.providerRow}>
        <button
          type="button"
          className={styles.providerMain}
          onClick={onOpen}
          aria-haspopup="dialog"
          data-testid={`provider-open-${p.id}`}
        >
          <span className={styles.providerName}>
            <BrandIcon brand={p.presetId ?? p.id} name={p.name} size={20} />
            <span className={styles.providerLabel}>{name}</span>
            {warning && (
              <span className={styles.warnDot} title={warning} aria-label={warning}>
                <Icon icon={AlertCircle} size={14} />
              </span>
            )}
            {fromEnv && (
              <span className={styles.badgeMuted}>
                {t('ui.chat-settings.environment-variable')}
              </span>
            )}
          </span>
          <span className={styles.wires}>
            {wires.map((w) => (
              <span key={w} className={styles.wireTag}>
                <Icon icon={Check} size={12} />
                {WIRE_LABEL[w]}
              </span>
            ))}
          </span>
          <span className={styles.count}>{t('ui.models.keys', String(p.keys.length))}</span>
          <span className={styles.count}>{t('ui.models.models', String(enabledCount))}</span>
          <Icon icon={ChevronRight} size={14} />
        </button>
        <button
          type="button"
          className={styles.more}
          aria-haspopup="dialog"
          aria-label={fromEnv ? t('ui.models.view', name) : t('ui.models.edit', name)}
          onClick={onOpen}
        >
          <Icon icon={MoreHorizontal} size={16} />
        </button>
      </div>
    </div>
  );
};
