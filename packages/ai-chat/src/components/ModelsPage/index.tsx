/**
 * 设置 →「模型」页（docs/design/unified-gateway.md §4.1）。
 * M1.5 原型：数据全部来自 fakeData，只在开发模式出现，用于评审交互；M2 接网关（ai:gateway:*）。
 * 官方账号不在这里：仍在「编程助手」页原位置。
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

import { EndpointIcon } from '../EndpointIcon';

import { AddProviderDialog } from './AddProviderDialog';
import {
  CLAUDE_TIERS,
  CLIS,
  INITIAL_ASSIGNMENT,
  INITIAL_PROVIDERS,
  pickerProviders,
  RECENT,
  WIRE_LABEL,
  type Assignment,
  type CliId,
  type ProtoCli,
  type ProtoProvider,
} from './fakeData';
import styles from './index.module.css';

const FOLLOW = 'follow';
const UNSET = 'unset';

export const ModelsPage: React.FC = () => {
  const [providers, setProviders] = useState<ProtoProvider[]>(INITIAL_PROVIDERS);
  const [a, setA] = useState<Assignment>(INITIAL_ASSIGNMENT);
  const [adding, setAdding] = useState(false);
  const [showWire, setShowWire] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [offer, setOffer] = useState<ProtoProvider | null>(null);

  const picker = useMemo(() => pickerProviders(providers), [providers]);
  const common = { providers: picker, recent: RECENT, showWire, size: 'sm' as const };

  const setCli = (id: CliId, patch: Partial<Assignment['cli'][CliId]>) =>
    setA((p) => ({ ...p, cli: { ...p.cli, [id]: { ...p.cli[id], ...patch } } }));

  const onSaved = (p: ProtoProvider) => {
    const hadAssignment = Boolean(a.chat) || Object.values(a.cli).some((c) => c.main);
    setProviders((list) => [...list, p]);
    setAdding(false);
    if (!hadAssignment) setOffer(p);
  };

  /** 一键把新供应商的第一个模型填进分配区（「新标签默认用」不改，官方账号保持原样） */
  const applyOffer = (p: ProtoProvider) => {
    const first = p.models.find((x) => x.enabled && x.toolCalling !== false);
    if (!first) return setOffer(null);
    const ref = `${p.id}/${first.id}`;
    setA((prev) => ({
      ...prev,
      chat: prev.chat ?? ref,
      cli: Object.fromEntries(
        CLIS.map((c) => [
          c.id,
          c.installed && !prev.cli[c.id].main ? { ...prev.cli[c.id], main: ref } : prev.cli[c.id],
        ]),
      ) as Assignment['cli'],
    }));
    setOffer(null);
  };

  return (
    <div className={styles.page} data-testid="models-page">
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>
            {t('模型')}
            <span className={styles.protoBadge}>{t('原型 · 假数据')}</span>
          </h2>
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

      {offer && (
        <div className={styles.offer} role="status" data-testid="models-offer">
          <span>{t('要让 Nomi 对话和已安装的编程助手都用「{0}」吗？', offer.name)}</span>
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
            value={a.chat}
            onChange={(v) => setA((p) => ({ ...p, chat: v }))}
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
            value={a.tools ?? FOLLOW}
            onChange={(v) => setA((p) => ({ ...p, tools: v === FOLLOW ? null : v }))}
            aria-label={t('工具调用的模型')}
          />
          <span className={styles.rowLabel}>{t('摘要')}</span>
          <ModelPicker
            {...common}
            className={styles.picker}
            value={a.summary}
            onChange={(v) => setA((p) => ({ ...p, summary: v }))}
            aria-label={t('摘要的模型')}
          />
        </div>

        <div className={styles.cliHead}>
          <span>{t('编程助手的第三方模型')}</span>
          <span>{t('新标签默认用')}</span>
        </div>
        {CLIS.map((c) => (
          <CliRow
            key={c.id}
            cli={c}
            a={a}
            common={common}
            open={c.id === 'claude' && claudeOpen}
            onToggle={() => setClaudeOpen((x) => !x)}
            setCli={setCli}
            setSource={(s) =>
              setA((p) => ({ ...p, newTabSource: { ...p.newTabSource, [c.id]: s } }))
            }
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
            data-testid="add-provider"
          >
            <Icon icon={Plus} size={14} />
            {t('添加')}
          </Button>
        </div>
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            p={p}
            open={expanded === p.id}
            onToggle={() => setExpanded((x) => (x === p.id ? null : p.id))}
            onChange={(next) => setProviders((list) => list.map((x) => (x.id === p.id ? next : x)))}
            onRemove={() => setProviders((list) => list.filter((x) => x.id !== p.id))}
          />
        ))}
      </section>

      <section className={`${styles.card} ${styles.terminal}`}>
        <div>
          <div className={styles.cardTitle}>{t('终端启动命令')}</div>
          <p className={styles.sub}>
            {t(
              '在终端里用 nomi-claude、nomi-codex 等命令使用第三方模型；直接运行 claude、codex 仍是官方登录。',
            )}
          </p>
        </div>
        <Switch checked={terminal} onChange={setTerminal} aria-label={t('终端启动命令')} />
      </section>

      <AddProviderDialog open={adding} onClose={() => setAdding(false)} onSave={onSaved} />
    </div>
  );
};

/* ------------------------------ 编程助手一行 ------------------------------ */

const CliRow: React.FC<{
  cli: ProtoCli;
  a: Assignment;
  common: Omit<React.ComponentProps<typeof ModelPicker>, 'value' | 'onChange'>;
  open: boolean;
  onToggle: () => void;
  setCli: (id: CliId, patch: Partial<Assignment['cli'][CliId]>) => void;
  setSource: (s: 'official' | 'third-party') => void;
}> = ({ cli, a, common, open, onToggle, setCli, setSource }) => {
  const v = a.cli[cli.id];
  const unset: SelectOption = { value: UNSET, label: t('未设置') };
  const sourceOptions: SelectOption[] = [
    {
      value: 'official',
      label: t('官方账号'),
      disabled: !cli.account,
      description: cli.account ?? t('未登录'),
    },
    {
      value: 'third-party',
      label: t('第三方'),
      disabled: !v.main,
      description: v.main ? undefined : t('先选第三方模型'),
    },
  ];
  if (!cli.installed) {
    return (
      <div className={`${styles.cliRow} ${styles.cliMissing}`} data-testid={`cli-row-${cli.id}`}>
        <span className={styles.cliName}>
          <EndpointIcon backend={cli.id} size={16} decorative />
          {cli.name}
        </span>
        <span className={styles.muted}>{t('未安装')}</span>
        <Button size="sm" variant="secondary">
          {t('安装')}
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className={styles.cliRow} data-testid={`cli-row-${cli.id}`}>
        <span className={styles.cliName}>
          <EndpointIcon backend={cli.id} size={16} decorative />
          {cli.name}
        </span>
        <span className={styles.cliPickers}>
          {cli.id === 'claude' && <span className={styles.tierLabel}>{t('主')}</span>}
          <ModelPicker
            {...common}
            purpose="coding"
            className={styles.picker}
            extraOptions={[unset]}
            value={v.main ?? UNSET}
            onChange={(x) => setCli(cli.id, { main: x === UNSET ? null : x })}
            aria-label={t('{0} 的第三方模型', cli.name)}
          />
          {cli.id === 'claude' && (
            <>
              <span className={styles.tierLabel}>{t('小')}</span>
              <ModelPicker
                {...common}
                purpose="coding"
                className={styles.picker}
                extraOptions={[{ value: FOLLOW, label: t('跟随主模型') }]}
                value={v.small ?? FOLLOW}
                onChange={(x) => setCli(cli.id, { small: x === FOLLOW ? null : x })}
                aria-label={t('Claude Code 的小模型')}
              />
              <button
                type="button"
                className={styles.expand}
                aria-expanded={open}
                aria-label={t('各档模型')}
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
          value={a.newTabSource[cli.id]}
          onChange={(e) => setSource(e.target.value as 'official' | 'third-party')}
          aria-label={t('{0} 新标签默认用', cli.name)}
          menuMinWidth={220}
        />
      </div>
      {open &&
        CLAUDE_TIERS.map((tier) => (
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
                value={v.tiers[tier.id] ?? FOLLOW}
                onChange={(x) =>
                  setCli('claude', { tiers: { ...v.tiers, [tier.id]: x === FOLLOW ? null : x } })
                }
                aria-label={t('Claude Code 的{0}', t(tier.label))}
              />
            </span>
            <span />
          </div>
        ))}
    </>
  );
};

/* ------------------------------ 供应商一行 ------------------------------ */

const ProviderRow: React.FC<{
  p: ProtoProvider;
  open: boolean;
  onToggle: () => void;
  onChange: (p: ProtoProvider) => void;
  onRemove: () => void;
}> = ({ p, open, onToggle, onChange, onRemove }) => {
  const enabledCount = p.models.filter((x) => x.enabled).length;
  return (
    <div className={styles.provider} data-testid={`provider-${p.id}`}>
      <div className={styles.providerRow}>
        <button
          type="button"
          className={styles.providerMain}
          onClick={onToggle}
          aria-expanded={open}
        >
          <BrandIcon brand={p.brand} name={p.name} size={20} />
          <span className={styles.providerName}>{p.name}</span>
          {p.warning && (
            <span className={styles.warnDot} title={p.warning} aria-label={p.warning}>
              <Icon icon={AlertCircle} size={14} />
            </span>
          )}
          {p.fromEnv && <span className={styles.badgeMuted}>{t('环境变量')}</span>}
          <span className={styles.muted}>{t('{0} 个 Key', String(p.keys.length))}</span>
          <span className={styles.wires}>
            {p.wires.map((w) => (
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
            {p.keys.map((k) => (
              <div key={k.name} className={styles.keyLine}>
                <span>{t(k.name)}</span>
                <code>{k.masked}</code>
                {k.lastError && <span className={styles.errorText}>{t(k.lastError)}</span>}
              </div>
            ))}
          </div>
          <div className={styles.detailCol}>
            <div className={styles.groupTitle}>{t('模型')}</div>
            {p.models.map((x) => (
              <label key={x.id} className={styles.modelCheck}>
                <input
                  type="checkbox"
                  disabled={Boolean(p.fromEnv)}
                  checked={x.enabled}
                  onChange={(e) =>
                    onChange({
                      ...p,
                      models: p.models.map((y) =>
                        y.id === x.id ? { ...y, enabled: e.target.checked } : y,
                      ),
                    })
                  }
                />
                <span>{x.id}</span>
                {x.metaKnown === false && (
                  <span className={styles.badgeMuted}>{t('参数未知')}</span>
                )}
                {x.toolCalling === false && (
                  <span className={styles.badgeMuted}>{t('不支持工具调用')}</span>
                )}
              </label>
            ))}
          </div>
          <div className={styles.detailActions}>
            <Button size="sm" variant="ghost" disabled>
              {t('高级')}
            </Button>
            {!p.fromEnv && (
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
