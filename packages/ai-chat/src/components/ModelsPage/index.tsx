/**
 * 设置 →「模型」页（docs/development/gateway.md）：第三方供应商与模型分配，数据来自网关（ai:gateway:*）。
 * - 分配：Nomi 对话（main；tools / summary / image 收在「更多用途」里）；各编程助手的第三方模型（标签选「第三方」时用）；
 *   「新会话默认用」在「编程助手」页各助手的详情里；
 * - 「显示协议」「上下文档位」「严格模式」「请求体上限」都在页底的「高级」里；
 * - 官方账号不在这里：仍在「编程助手」页原位置（安装、账号也在那里）。
 */
import {
  BrandIcon,
  Button,
  Icon,
  IconButton,
  Input,
  Modal,
  Select,
  ModalHostContext,
  ModelPicker,
  Switch,
  t,
} from '@nomi-ai/ui';
import {
  AlertCircle,
  GripVertical,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Boxes,
  Info,
  Plus,
  Waypoints,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { CLI_KINDS, providerOfRef, type CliKind } from '../../services/cliSource';
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
import { confirmDialog, promptDialog } from '../ConfirmDialog';
import { EndpointIcon } from '../EndpointIcon';
import { linkCallErrorText, providerLinkClient } from '../ProviderLink/client';

import styles from './index.module.css';
import { keyName, ProviderDetailDialog } from './ProviderDetailDialog';
import { ProviderForm } from './ProviderForm';
import { TerminalCommandsCard } from './TerminalCommandsCard';
import { useCliInstall } from './useCliInstall';

/** 「网页授权」：填第三方供应商的网址，读它的授权说明后在浏览器里授权（docs/integrations/provider-link.md B） */
async function connectByAuthorization(setError: (e: string | null) => void): Promise<void> {
  const site = await promptDialog({
    title: t('ui.provider-link.connect-title'),
    message: t('ui.provider-link.connect-message'),
    label: t('ui.provider-link.connect-label'),
    confirmLabel: t('ui.provider-link.go-authorize'),
  });
  if (!site?.trim()) return;
  setError(null);
  try {
    await providerLinkClient.connect(site.trim());
  } catch (e) {
    setError(linkCallErrorText(e));
  }
}

const FOLLOW = 'follow';
const UNSET = 'unset';
/** 选择器最前面的特殊选项：模块级常量（label 是翻译 key，由 Select 翻译）。
 *  内联数组每次渲染都是新的，会让 ModelPicker 每次都重建几百个选项 */
const SAME_AS_CHAT = [{ value: FOLLOW, label: 'ui.models.same-as-chat' }];
const FOLLOW_MAIN = [{ value: FOLLOW, label: 'ui.models.follow-main-model' }];
const NOT_SET = [{ value: UNSET, label: 'ui.cli-monitor.not-set' }];
/** 图片生成没指定时按对话模型自动匹配（内核 media/auto.ts） */
const AUTO_IMAGE = [
  { value: UNSET, label: 'ui.models.image-auto', hint: 'ui.models.image-auto-hint' },
];

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
  const [openCli, setOpenCli] = useState<CliKind | 'nomi' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeSeen, setRevokeSeen] = useState(false);
  /** 页底「高级」：显示协议、严格模式、请求体上限 */
  const [showAdvanced, setShowAdvanced] = useState(false);

  const providers = useMemo(() => state?.providers ?? [], [state]);
  const picker = useMemo(() => pickerProviders(providers), [providers]);
  const nomi = state?.clients.nomi?.models ?? {};
  // 与对话里的模型选择器同形：按供应商分标签、按厂商筛选 / 分组
  const common = { providers: picker, showWire, size: 'sm' as const, browse: true };
  const imagePicker = useMemo(() => pickerProviders(providers, 'image'), [providers]);

  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e: Error) => setError(e.message));
  };
  const cli = useCliInstall(setError);
  const editingProvider = providers.find((p) => p.id === editing) ?? null;
  /** 能排序的供应商（环境变量提供的不在存储里，始终排在后面） */
  const sortable = providers.filter((p) => p.source !== 'env');
  /** 拖动（或手柄上 Alt+↑/↓）调整顺序：排在前面的优先；某家停用或失败时按这个顺序换到同一个模型的下一家 */
  const [dragging, setDragging] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const moveProvider = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= sortable.length) return;
    const ids = sortable.map((p) => p.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    run(gatewayClient.reorderProviders(ids));
    setLive(
      t('ui.chat-settings.moved-to-position', providerDisplayName(sortable[from]!.name), to + 1),
    );
  };
  /** null 表示清除（跟随对话） */
  const assign = (patch: Partial<Record<keyof ClientModels, string | null>>) =>
    run(gatewayClient.setAssignment('nomi', { models: patch as ClientModels }));

  /** 编程助手的第三方模型 / 新标签默认用；null 表示清除 */
  const assignCli = (kind: CliKind, patch: CliAssignPatch) =>
    run(
      gatewayClient.setAssignment(kind, patch as Parameters<typeof gatewayClient.setAssignment>[1]),
    );

  /** 保存后：Nomi 对话还没模型时先填上推荐的（第一个启用的对话模型），在下面的「Nomi 对话」里可改 */
  const onSaved = (p: ProviderView) => {
    setAdding(false);
    const first = p.models.find((x) => x.enabled && x.toolCalling !== false);
    if (!nomi.main && first) assign({ main: `${p.id}/${first.id}` });
  };
  /** 还没有供应商：表单直接铺在卡片里（这时它就是页面的主要内容）；已有供应商时「添加」打开弹窗 */
  const showForm = Boolean(state) && !providers.length;
  const noModels = !picker.length;
  /** 还没有供应商：卡片标题带步骤编号（1 加供应商 → 2 分配）；配好以后不再显示 */
  const onboarding = Boolean(state) && !providers.length;

  const status = state?.status;
  return (
    <div className={styles.page} data-testid="models-page">
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

      <section className={styles.card} aria-labelledby="models-providers">
        <div className={styles.cardHeadRow}>
          <h3 id="models-providers" className={styles.cardTitle}>
            {onboarding && <span className={styles.stepNo}>1</span>}
            <Icon icon={Boxes} size={16} />
            {t('ui.models.third-party-providers')}
          </h3>
          <span className={styles.headActions}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAdding(true)}
              disabled={!state || showForm || adding}
              data-testid="add-provider"
            >
              <Icon icon={Plus} size={14} />
              {t('ui.foundation.add')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void connectByAuthorization(setError)}
              disabled={!state}
              title={t('ui.provider-link.connect-hint')}
              data-testid="connect-provider"
            >
              {t('ui.provider-link.connect')}
            </Button>
          </span>
        </div>
        {state && !providers.length && (
          <p className={styles.sub} data-testid="models-empty">
            {t('ui.models.no-third-party-providers-yet-add-one-and')}
          </p>
        )}
        {showForm && <ProviderForm idPrefix="models" onSaved={onSaved} />}
        {sortable.length > 1 && (
          <p className={styles.sub} data-testid="providers-order-hint">
            {t('ui.models.provider-order-hint')}
          </p>
        )}
        {providers.map((p) => {
          const i = sortable.findIndex((x) => x.id === p.id);
          return (
            <ProviderRow
              key={p.id}
              p={p}
              onOpen={() => setEditing(p.id)}
              showWire={showWire}
              onToggle={(on) => run(gatewayClient.setProviderEnabled(p.id, on))}
              order={
                i >= 0 && sortable.length > 1
                  ? {
                      index: i,
                      dragging: dragging === p.id,
                      onDragStart: () => setDragging(p.id),
                      onDragEnd: () => setDragging(null),
                      canDrop: () => dragging !== null,
                      onDrop: () => {
                        if (dragging)
                          moveProvider(
                            sortable.findIndex((x) => x.id === dragging),
                            i,
                          );
                        setDragging(null);
                      },
                      onMove: (dir) => moveProvider(i, i + dir),
                    }
                  : undefined
              }
            />
          );
        })}
        <span className={styles.srOnly} aria-live="polite">
          {live}
        </span>
      </section>

      <section
        className={`${styles.card} ${noModels ? styles.cardOff : ''}`}
        aria-labelledby="models-assign"
        aria-disabled={noModels}
        data-testid="models-assign"
        data-state={noModels ? 'disabled' : 'ready'}
      >
        <h3 id="models-assign" className={styles.cardTitle}>
          {onboarding && <span className={styles.stepNo}>2</span>}
          <Icon icon={Waypoints} size={16} />
          {t('ui.models.assignments')}
        </h3>
        {noModels && (
          <p className={styles.sub} data-testid="models-assign-off">
            {t('ui.models.configure-a-provider-first')}
          </p>
        )}
        <p className={styles.sub}>{t('ui.models.assign-hint')}</p>
        {/* Nomi 与各编程助手一样一张卡片：主模型在卡片上，箭头展开附加用途（Nomi：工具调用 / 摘要 / 图片生成） */}
        <div className={styles.cliGrid} data-testid="models-cli">
          <div
            className={styles.cliCard}
            data-testid="nomi-card"
            data-open={openCli === 'nomi' || undefined}
          >
            <div className={styles.cliCardHead}>
              <span className={styles.cliName}>
                <EndpointIcon backend="nomi" size={16} decorative />
                {t('ui.models.nomi-ai')}
              </span>
              <IconButton
                size="sm"
                className={styles.expand}
                aria-expanded={openCli === 'nomi'}
                label={`${t('ui.models.nomi-ai')} · ${t('ui.voice-mascot.more')}`}
                data-testid="nomi-more"
                onClick={() => setOpenCli((x) => (x === 'nomi' ? null : 'nomi'))}
                icon={<Icon icon={openCli === 'nomi' ? ChevronDown : ChevronRight} size={14} />}
              />
            </div>
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
            {openCli === 'nomi' && (
              <div className={styles.cliTiers}>
                <div className={styles.tierField}>
                  <span className={styles.tierLabel}>{t('ui.models.tool-calls')}</span>
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
                <div className={styles.tierField}>
                  <span className={styles.tierLabel}>{t('ui.models.summaries')}</span>
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
                <div className={styles.tierField}>
                  <span className={styles.tierLabel}>{t('ui.models.image-generation')}</span>
                  <ModelPicker
                    {...common}
                    providers={imagePicker}
                    className={styles.picker}
                    extraOptions={AUTO_IMAGE}
                    value={nomi.image ?? UNSET}
                    onChange={(v) => assign({ image: v === UNSET ? null : v })}
                    disabled={!imagePicker.length}
                    placeholder={t('ui.models.no-image-models')}
                    aria-label={t('ui.models.model-for-image-generation')}
                    data-testid="assign-image"
                  />
                </div>
              </div>
            )}
          </div>
          {CLI_KINDS.map((kind) => (
            <CliRow
              key={kind}
              kind={kind}
              client={state?.clients[kind]}
              common={common}
              disabled={!picker.length}
              open={openCli === kind}
              onToggle={() => setOpenCli((x) => (x === kind ? null : kind))}
              onAssign={(patch) => assignCli(kind, patch)}
              missing={cli.missing(kind)}
              installBusy={cli.busy(kind)}
              onInstall={() => cli.install(kind)}
            />
          ))}
        </div>
      </section>
      {cli.dialog}

      <section className={styles.card} data-testid="models-advanced-card">
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
        {showAdvanced && (
          <div className={styles.advanced} data-testid="models-advanced">
            <label className={styles.inlineSwitch}>
              <Switch
                checked={showWire}
                onChange={setShowWire}
                aria-label={t('ui.models.show-apis')}
                data-testid="models-show-wire"
              />
              <span>{t('ui.models.show-apis')}</span>
            </label>
            <label className={styles.inlineField}>
              <span>{t('ui.models.context-tier')}</span>
              <Select
                size="sm"
                disabled={!state}
                value={String(state?.contextTier ?? 0)}
                options={[
                  { value: '0', label: t('ui.models.context-tier-model') },
                  { value: '262144', label: t('ui.models.context-tier-256k') },
                  { value: '200000', label: t('ui.models.context-tier-200k') },
                  { value: '128000', label: t('ui.models.context-tier-128k') },
                ]}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) return;
                  run(gatewayClient.setOptions({ contextTier: n }));
                }}
                aria-label={t('ui.models.context-tier')}
                data-testid="models-context-tier"
              />
            </label>
            <p className={styles.sub}>{t('ui.models.context-tier-hint')}</p>
            <label className={styles.inlineSwitch}>
              <Switch
                checked={state?.strictParams === true}
                onChange={(v) => run(gatewayClient.setOptions({ strictParams: v }))}
                disabled={!state}
                aria-label={t('ui.models.strict-mode')}
                data-testid="models-strict"
              />
              <span>{t('ui.models.strict-mode')}</span>
            </label>
            <p className={styles.sub}>
              {t('ui.models.when-on-parameters-the-model-doesn-t-support')}
            </p>
            <label className={styles.inlineField}>
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
      </section>

      <TerminalCommandsCard />

      {adding && providers.length > 0 && (
        <ModalHostContext.Provider value={null}>
          <Modal
            open
            onClose={() => setAdding(false)}
            size="lg"
            title={t('ui.models.add-third-party-provider')}
            data-testid="models-add-provider-dialog"
          >
            <ProviderForm idPrefix="models" onSaved={onSaved} onCancel={() => setAdding(false)} />
          </Modal>
        </ModalHostContext.Provider>
      )}

      <ProviderDetailDialog
        provider={editingProvider}
        allowedPrivateHosts={state?.allowedPrivateHosts ?? []}
        onClose={() => setEditing(null)}
        onRemove={async (p) => {
          const ok = await confirmDialog({
            message: t('ui.models.delete-provider-and-all-its-keys', p.name),
            danger: true,
          });
          if (!ok) return;
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
  common: Pick<React.ComponentProps<typeof ModelPicker>, 'providers' | 'showWire' | 'size'>;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onAssign: (patch: CliAssignPatch) => void;
  /** 没安装：整行变灰，只显示「安装」 */
  missing: boolean;
  /** 这一行的编程助手正在安装（其他行不受影响） */
  installBusy: boolean;
  onInstall: () => void;
}> = ({
  kind,
  client,
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
  if (missing)
    return (
      <div className={`${styles.cliCard} ${styles.cliMissing}`} data-testid={`cli-row-${kind}`}>
        <div className={styles.cliCardHead}>
          <span className={styles.cliName}>
            <EndpointIcon backend={kind} size={16} decorative />
            {name}
          </span>
          <span className={styles.muted}>{t('ui.mascot-theme.not-installed')}</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={installBusy}
          onClick={onInstall}
          aria-label={t('ui.cli-monitor.install-named', name)}
          data-testid={`cli-install-${kind}`}
        >
          <Icon icon={Download} size={14} />
          {installBusy ? t('ui.cli-monitor.working') : t('ui.models.install')}
        </Button>
      </div>
    );
  const source = client?.newTabSource ?? 'official';
  // eslint-disable-next-line nomi/no-cli-literal -- 各档模型（opus / sonnet / haiku / fable）是 Claude Code 独有的配置
  const claude = kind === 'claude';
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
  /** 卡片里展开的一个附加模型：标签在上，选择框在下 */
  const field = (label: string, picker: React.ReactNode, title?: string) => (
    <div className={styles.tierField} key={label}>
      <span className={styles.tierLabel} title={title}>
        {label}
      </span>
      {picker}
    </div>
  );
  return (
    <div className={styles.cliCard} data-testid={`cli-row-${kind}`} data-open={open || undefined}>
      <div className={styles.cliCardHead}>
        <span className={styles.cliName}>
          <EndpointIcon backend={kind} size={16} decorative />
          {name}
        </span>
        {/* 只放箭头：名字长时不挤；「各档模型 / 更多」只作为无障碍名（图标按钮不加原生 title） */}
        <IconButton
          size="sm"
          className={styles.expand}
          aria-expanded={open}
          label={`${t(name)} · ${claude ? t('ui.models.per-tier-models') : t('ui.voice-mascot.more')}`}
          data-testid={claude ? 'cli-tiers-toggle' : `cli-more-${kind}`}
          onClick={onToggle}
          icon={<Icon icon={open ? ChevronDown : ChevronRight} size={14} />}
        />
      </div>
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
      {open && (
        <div className={styles.cliTiers}>
          {claude &&
            CLAUDE_TIERS.map((tier) =>
              field(
                t(tier.label),
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
                />,
              ),
            )}
          {claude &&
            field(
              t('ui.usage-tools.subagent'),
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
              />,
            )}
          {field(
            t('ui.usage-tools.helper-model'),
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
            />,
            t('ui.models.used-for-helper-requests-such-as-titles-summaries'),
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------ 供应商一行 ------------------------------ */

const ProviderRow: React.FC<{
  p: ProviderView;
  onOpen: () => void;
  /** 拖动排序（只有两家以上可排序的供应商时才有） */
  order?: {
    index: number;
    dragging: boolean;
    onDragStart: () => void;
    onDragEnd: () => void;
    canDrop: () => boolean;
    onDrop: () => void;
    /** 键盘：手柄上 Alt+↑/↓ */
    onMove: (dir: -1 | 1) => void;
  };
  /** 列表上直接启用 / 停用（环境变量供应商没有） */
  onToggle?: (enabled: boolean) => void;
  /** 「高级 → 显示协议」：列出各协议名 */
  showWire?: boolean;
}> = ({ p, onOpen, order, onToggle, showWire }) => {
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
    <div
      className={styles.provider}
      data-off={p.enabled ? undefined : ''}
      data-dragging={order?.dragging || undefined}
      data-testid={`provider-${p.id}`}
      draggable={Boolean(order)}
      onDragStart={
        order &&
        ((e) => {
          order.onDragStart();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.id);
        })
      }
      onDragEnd={order?.onDragEnd}
      onDragOver={
        order &&
        ((e) => {
          if (!order.canDrop()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        })
      }
      onDrop={
        order &&
        ((e) => {
          e.preventDefault();
          order.onDrop();
        })
      }
    >
      <div className={styles.providerRow}>
        {order && (
          <span className={styles.providerOrder}>
            <button
              type="button"
              className={styles.providerGrip}
              aria-label={t('ui.chat-settings.position-alt-to-reorder', name, order.index + 1)}
              data-testid={`provider-grip-${p.id}`}
              onKeyDown={(e) => {
                if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                order.onMove(e.key === 'ArrowUp' ? -1 : 1);
              }}
            >
              <Icon icon={GripVertical} size={14} />
            </button>
            <span className={styles.providerRank} aria-hidden>
              {order.index + 1}
            </span>
          </span>
        )}
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
              <span className={styles.warnDot} role="img" aria-label={warning}>
                <Icon icon={AlertCircle} size={14} />
              </span>
            )}
            {fromEnv && (
              <span className={styles.badgeMuted}>
                {t('ui.chat-settings.environment-variable')}
              </span>
            )}
            {!p.enabled && (
              <span className={styles.badgeMuted}>{t('ui.slash-commands.disabled')}</span>
            )}
          </span>
          {/* 协议：平时只显示几种（悬停看名字），「高级 → 显示协议」打开时列出来 */}
          {showWire ? (
            <span className={styles.wires}>
              {wires.map((w) => (
                <span key={w} className={styles.wireTag}>
                  <Icon icon={Check} size={12} />
                  {WIRE_LABEL[w]}
                </span>
              ))}
            </span>
          ) : (
            <span
              className={styles.count}
              title={wires.map((w) => WIRE_LABEL[w]).join(' · ')}
              data-testid={`provider-wires-${p.id}`}
            >
              {wires.length ? t('ui.models.wires-count', String(wires.length)) : ''}
            </span>
          )}
          <span className={styles.count}>
            {t('ui.models.keys', String(p.keys.length))} ·{' '}
            {t('ui.models.models', String(enabledCount))}
          </span>
          <Icon icon={ChevronRight} size={14} />
        </button>
        {!fromEnv && onToggle && (
          <span className={styles.providerSwitch}>
            <Switch
              checked={p.enabled}
              onChange={onToggle}
              aria-label={t('ui.foundation.enable', name)}
              data-testid={`provider-enabled-${p.id}`}
            />
          </span>
        )}
      </div>
    </div>
  );
};
