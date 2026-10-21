/**
 * 设置 →「模型」页（docs/design/unified-gateway.md §4.1）：第三方供应商与模型分配，数据来自网关（ai:gateway:*）。
 * - 分配：Nomi 对话（main / tools / summary）；各编程助手的第三方模型（标签选「第三方」时用）与「新标签默认用」；
 * - 官方账号不在这里：仍在「编程助手」页原位置（安装、账号也在那里）。
 */
import {
  BrandIcon,
  Button,
  Icon,
  ModelPicker,
  Select,
  Switch,
  t,
  type SelectOption,
} from '@nomi-ai/ui';
import { AlertCircle, Check, ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { CLI_KINDS, type CliKind } from '../../services/cliSource';
import {
  gatewayClient,
  WIRE_LABEL,
  WIRES,
  type ClientModels,
  type GatewayState,
  type LearnedState,
  type ProviderView,
  type Wire,
} from '../../services/gatewayClient';
import { pickerProviders, useGatewayState } from '../../services/nomiModel';
import { providerDisplayName } from '../../services/providerClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import { AddProviderDialog } from './AddProviderDialog';
import styles from './index.module.css';

const FOLLOW = 'follow';
const UNSET = 'unset';

type ModelsPatch = Partial<Omit<Record<keyof ClientModels, string | null>, 'tiers'>> & {
  tiers?: Partial<Record<TierId, string | null>>;
};
type TierId = keyof NonNullable<ClientModels['tiers']>;

/** Claude Code 可单独指定的档位（不展开时跟随主模型 / 小模型） */
const CLAUDE_TIERS: ReadonlyArray<{ id: TierId; label: string; follows: 'main' | 'small' }> = [
  { id: 'opus', label: 'Opus 档', follows: 'main' },
  { id: 'sonnet', label: 'Sonnet 档', follows: 'main' },
  { id: 'haiku', label: 'Haiku 档', follows: 'small' },
  { id: 'fable', label: 'Fable 档', follows: 'main' },
];

export const ModelsPage: React.FC = () => {
  const state = useGatewayState();
  const [adding, setAdding] = useState(false);
  const [showWire, setShowWire] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [offer, setOffer] = useState<ProviderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeSeen, setRevokeSeen] = useState(false);

  const providers = useMemo(() => state?.providers ?? [], [state]);
  const picker = useMemo(() => pickerProviders(providers), [providers]);
  const nomi = state?.clients.nomi?.models ?? {};
  const common = { providers: picker, showWire, size: 'sm' as const };

  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e: Error) => setError(e.message));
  };
  /** null 表示清除（跟随对话） */
  const assign = (patch: Partial<Record<keyof ClientModels, string | null>>) =>
    run(gatewayClient.setAssignment('nomi', { models: patch as ClientModels }));

  /** 编程助手的第三方模型 / 新标签默认用；null 表示清除 */
  const assignCli = (
    kind: CliKind,
    patch: { models?: ModelsPatch; newTabSource?: 'official' | 'thirdParty' },
  ) =>
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
        <div>
          <h2 className={styles.title}>{t('模型')}</h2>
          <p className={styles.sub}>
            {t(
              '一个第三方供应商就能同时给 Nomi 对话和各编程助手用，协议由 Nomi 自动转换。官方账号的登录与切换仍在「编程助手」页。',
            )}
          </p>
        </div>
        <label className={styles.inlineSwitch}>
          <Switch checked={showWire} onChange={setShowWire} aria-label={t('显示协议')} />
          <span>{t('显示协议')}</span>
        </label>
      </div>

      {status?.state === 'failed' && (
        <div className={styles.offer} role="alert" data-testid="gateway-failed">
          <Icon icon={AlertCircle} size={14} />
          <span>{t('模型网关没有启动：{0}', status.error)}</span>
          <Button size="sm" variant="secondary" onClick={() => run(gatewayClient.retry())}>
            {t('重试')}
          </Button>
        </div>
      )}
      {state?.legacyRevoke?.revoked.length && !revokeSeen ? (
        <div className={styles.offer} role="status" data-testid="legacy-revoked">
          <span>
            {t(
              '终端里的 CLI 已恢复为你自己的配置和官方登录；第三方模型现在在 Nomi 的标签里使用（右上角选「第三方」）。',
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setRevokeSeen(true)}>
            {t('知道了')}
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
          {t(
            '没能撤销旧版本写进 {0} 全局配置的第三方设置：{1}。请手动检查，下次启动会再试。',
            f.kind,
            f.error,
          )}
        </p>
      ))}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {offer && (
        <div className={styles.offer} role="status" data-testid="models-offer">
          <span>{t('要让 Nomi 对话用「{0}」吗？', offer.name)}</span>
          <Button size="sm" variant="primary" onClick={() => applyOffer(offer)}>
            {t('一键填好')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOffer(null)}>
            {t('不用了')}
          </Button>
        </div>
      )}

      <section className={styles.card} aria-labelledby="models-assign">
        <h3 id="models-assign" className={styles.cardTitle}>
          {t('分配')}
        </h3>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t('Nomi 对话')}</span>
          <ModelPicker
            {...common}
            className={styles.pickerWide}
            value={nomi.main ?? null}
            onChange={(v) => assign({ main: v })}
            placeholder={picker.length ? t('选择模型') : t('先添加第三方供应商')}
            disabled={!picker.length}
            aria-label={t('Nomi 对话的模型')}
            data-testid="assign-chat"
          />
        </div>
        <div className={`${styles.row} ${styles.subRow}`}>
          <span className={styles.rowLabel}>{t('工具调用')}</span>
          <ModelPicker
            {...common}
            className={styles.picker}
            extraOptions={[{ value: FOLLOW, label: t('跟随对话') }]}
            value={nomi.tools ?? FOLLOW}
            onChange={(v) => assign({ tools: v === FOLLOW ? null : v })}
            disabled={!picker.length}
            aria-label={t('工具调用的模型')}
            data-testid="assign-tools"
          />
          <span className={styles.rowLabel}>{t('摘要')}</span>
          <ModelPicker
            {...common}
            className={styles.picker}
            extraOptions={[{ value: FOLLOW, label: t('跟随对话') }]}
            value={nomi.summary ?? FOLLOW}
            onChange={(v) => assign({ summary: v === FOLLOW ? null : v })}
            disabled={!picker.length}
            aria-label={t('摘要的模型')}
            data-testid="assign-summary"
          />
        </div>
      </section>

      <section className={styles.card} aria-labelledby="models-cli" data-testid="models-cli">
        <h3 id="models-cli" className={styles.cardTitle}>
          {t('编程助手')}
        </h3>
        <p className={styles.sub}>
          {t(
            '每个编程助手的标签都可以在右上角选「官方账号」或「第三方」。这里设置选「第三方」时默认用的模型，以及新建标签默认用哪个；不会改 CLI 的全局配置。',
          )}
        </p>
        <div className={styles.cliHead}>
          <span>{t('第三方模型')}</span>
          <span>{t('新标签默认用')}</span>
        </div>
        {CLI_KINDS.map((kind) => (
          <CliRow
            key={kind}
            kind={kind}
            client={state?.clients[kind]}
            common={common}
            disabled={!picker.length}
            open={kind === 'claude' && claudeOpen}
            onToggle={() => setClaudeOpen((x) => !x)}
            onAssign={(patch) => assignCli(kind, patch)}
          />
        ))}
      </section>

      <section className={styles.card} aria-labelledby="models-providers">
        <div className={styles.cardHeadRow}>
          <h3 id="models-providers" className={styles.cardTitle}>
            {t('第三方供应商')}
          </h3>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAdding(true)}
            disabled={!state}
            data-testid="add-provider"
          >
            <Icon icon={Plus} size={14} />
            {t('添加')}
          </Button>
        </div>
        {state && !providers.length && (
          <p className={styles.muted} data-testid="models-empty">
            {t('还没有第三方供应商。添加一个，Nomi 对话就能用它的模型。')}
          </p>
        )}
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            p={p}
            open={expanded === p.id}
            onToggle={() => setExpanded((x) => (x === p.id ? null : p.id))}
            onModels={(models) =>
              run(gatewayClient.upsertProvider({ id: p.id, name: p.name, urls: p.urls, models }))
            }
            onClearLearned={() => run(gatewayClient.clearLearned(p.id))}
            onRemove={() => {
              if (window.confirm(t('删除供应商「{0}」及其所有 Key？', p.name)))
                run(gatewayClient.removeProvider(p.id));
            }}
          />
        ))}
      </section>

      <AddProviderDialog open={adding} onClose={() => setAdding(false)} onSaved={onSaved} />
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
  onAssign: (patch: { models?: ModelsPatch; newTabSource?: 'official' | 'thirdParty' }) => void;
}> = ({ kind, client, common, disabled, open, onToggle, onAssign }) => {
  const m = client?.models ?? {};
  const name = ENDPOINT_NAME[kind];
  const source = client?.newTabSource ?? 'official';
  const claude = kind === 'claude';
  const sourceOptions: SelectOption[] = [
    { value: 'official', label: kind === 'dsh' ? t('dsh 自带配置') : t('官方账号') },
    {
      value: 'thirdParty',
      label: t('第三方'),
      disabled: !m.main,
      description: m.main ? undefined : t('先选第三方模型'),
    },
  ];
  const setMain = (v: string) => {
    if (v !== UNSET) return onAssign({ models: { main: v } });
    // 清掉主模型后「第三方」不能再作新标签默认
    onAssign({
      models: { main: null },
      ...(source === 'thirdParty' ? { newTabSource: 'official' as const } : {}),
    });
  };
  const setTier = (id: TierId, v: string) =>
    onAssign({ models: { tiers: { ...m.tiers, [id]: v === FOLLOW ? null : v } } });
  return (
    <>
      <div className={styles.cliRow} data-testid={`cli-row-${kind}`}>
        <span className={styles.cliName}>
          <EndpointIcon backend={kind} size={16} decorative />
          {name}
        </span>
        <span className={styles.cliPickers}>
          {claude && <span className={styles.tierLabel}>{t('主')}</span>}
          <ModelPicker
            {...common}
            purpose="coding"
            className={styles.picker}
            extraOptions={[{ value: UNSET, label: t('未设置') }]}
            value={m.main ?? UNSET}
            onChange={setMain}
            disabled={disabled}
            aria-label={t('{0} 的第三方模型', name)}
            data-testid={`cli-main-${kind}`}
          />
          {claude && (
            <>
              <span className={styles.tierLabel}>{t('小')}</span>
              <ModelPicker
                {...common}
                purpose="coding"
                className={styles.picker}
                extraOptions={[{ value: FOLLOW, label: t('跟随主模型') }]}
                value={m.small ?? FOLLOW}
                onChange={(v) => onAssign({ models: { small: v === FOLLOW ? null : v } })}
                disabled={disabled}
                aria-label={t('Claude Code 的小模型')}
                data-testid="cli-small-claude"
              />
              <button
                type="button"
                className={styles.expand}
                aria-expanded={open}
                aria-label={t('各档模型')}
                data-testid="cli-tiers-toggle"
                onClick={onToggle}
              >
                <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
              </button>
            </>
          )}
        </span>
        <Select
          size="sm"
          className={styles.source}
          options={sourceOptions}
          value={source}
          onChange={(e) => onAssign({ newTabSource: e.target.value as 'official' | 'thirdParty' })}
          aria-label={t('{0} 新标签默认用', name)}
          data-testid={`cli-source-${kind}`}
          menuMinWidth={200}
        />
      </div>
      {open && (
        <>
          {CLAUDE_TIERS.map((tier) => (
            <div key={tier.id} className={`${styles.cliRow} ${styles.tierRow}`}>
              <span className={styles.cliName}>{t(tier.label)}</span>
              <span className={styles.cliPickers}>
                <ModelPicker
                  {...common}
                  purpose="coding"
                  className={styles.picker}
                  extraOptions={[
                    {
                      value: FOLLOW,
                      label: tier.follows === 'main' ? t('跟随主模型') : t('跟随小模型'),
                    },
                  ]}
                  value={m.tiers?.[tier.id] ?? FOLLOW}
                  onChange={(v) => setTier(tier.id, v)}
                  disabled={disabled}
                  aria-label={t('Claude Code 的{0}', t(tier.label))}
                  data-testid={`cli-tier-${tier.id}`}
                />
              </span>
              <span />
            </div>
          ))}
          <div className={`${styles.cliRow} ${styles.tierRow}`}>
            <span className={styles.cliName}>{t('子代理')}</span>
            <span className={styles.cliPickers}>
              <ModelPicker
                {...common}
                purpose="coding"
                className={styles.picker}
                extraOptions={[{ value: FOLLOW, label: t('跟随主模型') }]}
                value={m.subagent ?? FOLLOW}
                onChange={(v) => onAssign({ models: { subagent: v === FOLLOW ? null : v } })}
                disabled={disabled}
                aria-label={t('Claude Code 的子代理模型')}
                data-testid="cli-subagent"
              />
            </span>
            <span />
          </div>
        </>
      )}
    </>
  );
};

/* ------------------------------ 供应商一行 ------------------------------ */

/** Key 的显示名：用户起的名字原样显示，否则按顺序「主 Key / 备用 Key N」 */
const keyName = (k: { name?: string }, i: number): string =>
  k.name || (i === 0 ? t('主 Key') : t('备用 Key {0}', String(i)));

const ProviderRow: React.FC<{
  p: ProviderView;
  open: boolean;
  onToggle: () => void;
  onModels: (models: ProviderView['models']) => void;
  onRemove: () => void;
  onClearLearned: () => void;
}> = ({ p, open, onToggle, onModels, onRemove, onClearLearned }) => {
  const enabledCount = p.models.filter((x) => x.enabled).length;
  const fromEnv = p.source === 'env';
  const wires = WIRES.filter((w) => p.detected?.[w]?.ok ?? Boolean(p.urls[w]));
  const fi = p.keys.findIndex((k) => k.enabled && (k.lastError || !k.decryptable));
  const failing = fi >= 0 ? p.keys[fi]! : undefined;
  const warning = failing
    ? failing.decryptable
      ? t('{0} 最近一次请求失败：{1}', keyName(failing, fi), failing.lastError ?? '')
      : t('{0} 无法解密，请重新填写', keyName(failing, fi))
    : undefined;
  return (
    <div className={styles.provider} data-testid={`provider-${p.id}`}>
      <div className={styles.providerRow}>
        <button
          type="button"
          className={styles.providerMain}
          onClick={onToggle}
          aria-expanded={open}
        >
          <BrandIcon brand={p.presetId ?? p.id} name={p.name} size={20} />
          <span className={styles.providerName}>{providerDisplayName(p.name)}</span>
          {warning && (
            <span className={styles.warnDot} title={warning} aria-label={warning}>
              <Icon icon={AlertCircle} size={14} />
            </span>
          )}
          {fromEnv && <span className={styles.badgeMuted}>{t('环境变量')}</span>}
          <span className={styles.muted}>{t('{0} 个 Key', String(p.keys.length))}</span>
          <span className={styles.wires}>
            {wires.map((w) => (
              <span key={w} className={styles.wireTag}>
                <Icon icon={Check} size={12} />
                {WIRE_LABEL[w]}
              </span>
            ))}
          </span>
          <span className={styles.muted}>{t('{0} 个模型', String(enabledCount))}</span>
        </button>
        <button type="button" className={styles.more} aria-label={t('更多')} onClick={onToggle}>
          <Icon icon={MoreHorizontal} size={16} />
        </button>
      </div>
      {open && (
        <div className={styles.detail}>
          <div className={styles.detailCol}>
            <div className={styles.groupTitle}>{t('Key（按顺序回退）')}</div>
            {p.keys.map((k, i) => (
              <div key={k.id} className={styles.keyLine}>
                <span>{keyName(k, i)}</span>
                <code>{k.masked}</code>
                {k.lastError && <span className={styles.errorText}>{k.lastError}</span>}
              </div>
            ))}
            {!p.keys.length && <span className={styles.muted}>{t('无需 Key')}</span>}
          </div>
          <div className={styles.detailCol}>
            <div className={styles.groupTitle}>{t('模型')}</div>
            {p.models.map((x) => (
              <label key={x.id} className={styles.modelCheck}>
                <input
                  type="checkbox"
                  disabled={fromEnv}
                  checked={x.enabled}
                  onChange={(e) =>
                    onModels(
                      p.models.map((y) =>
                        y.id === x.id ? { ...y, enabled: e.target.checked } : y,
                      ),
                    )
                  }
                />
                <span>{x.id}</span>
                {x.metaSource === 'default' && (
                  <span className={styles.badgeMuted}>{t('参数未知')}</span>
                )}
                {x.toolCalling === false && (
                  <span className={styles.badgeMuted}>{t('不支持工具调用')}</span>
                )}
              </label>
            ))}
          </div>
          {p.learned && <LearnedInfo learned={p.learned} onClear={onClearLearned} />}
          <div className={styles.detailActions}>
            {!fromEnv && (
              <Button size="sm" variant="danger" onClick={onRemove}>
                {t('删除')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/** 运行时学到的（§7.4）：哪些协议暂时不可用、哪些模型只走某些协议、去掉了哪些字段；可以清除重新学 */
const LearnedInfo: React.FC<{ learned: LearnedState; onClear: () => void }> = ({
  learned,
  onClear,
}) => {
  const lines = [
    ...Object.entries(learned.wireDown ?? {}).map(([w, d]) =>
      t('{0} 暂时不可用：{1}', WIRE_LABEL[w as Wire], d!.reason),
    ),
    ...Object.entries(learned.modelWire ?? {}).map(([m, ws]) =>
      t('{0} 只走 {1}', m, ws.map((w) => WIRE_LABEL[w]).join(' / ')),
    ),
    ...Object.entries(learned.droppedParams ?? {}).map(([w, ps]) =>
      t('{0} 不发送字段：{1}', WIRE_LABEL[w as Wire] ?? w, ps.join('、')),
    ),
  ];
  return (
    <div className={styles.detailCol} data-testid="provider-learned">
      <div className={styles.groupTitle}>{t('自动学到的')}</div>
      {lines.map((l) => (
        <span key={l} className={styles.muted}>
          {l}
        </span>
      ))}
      <Button size="sm" variant="ghost" onClick={onClear} data-testid="provider-learned-clear">
        {t('清除，重新学习')}
      </Button>
    </div>
  );
};
