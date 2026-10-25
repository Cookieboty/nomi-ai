/**
 * 输入栏的「模型 · 思考深度」按钮（编程助手标签：Codex / Claude Code / Grok 等）。
 *
 * 标签来源是第三方（docs/design/unified-gateway.md §4.3）时，同一个按钮只列**当前供应商**的模型
 * （主进程 ai:harness:model-catalog 带 source: 'thirdParty'，id 是 `供应商/模型`，这里按供应商筛选），
 * 直接打开模型列表、没有思考深度；换供应商用 `/model`，新标签默认在侧栏信息卡（CliDefaultSource）。
 * 「默认模型」= 这个 CLI 在「模型」页分配的模型（属于当前供应商时）。
 *
 * 交互参考 Codex：一个按钮显示「模型 · 档位」，点开一个浮层，节省输入栏空间；
 * - 默认页：大字显示当前档位，下面「模型名 ›」，再下面是分档滑杆（只在推理模型上出现）；
 *   不选档位 = 不发覆盖参数，沿用 CLI 默认；CLI 告诉我们默认档位时滑块定位到该档位；
 * - 点「模型名 ›」进入模型页：跟随 CLI 默认 / 目录内模型 / 自定义模型 id，选完回到滑杆。
 * 官方来源的模型列表、每个模型的档位与默认档位全部来自 CLI 自己（主进程读取并缓存，见
 * electron/src/cli/modelDiscovery.ts），这里不写死任何模型或档位；读不到时只保留默认与自定义。
 * 覆盖是标签级的，主进程在每轮启动时以进程级参数注入
 * （codex `-c model=...`、grok `-m ... --reasoning-effort ...`、claude `--model ... --effort ...`），
 * 不改写用户的全局 CLI 配置；每轮新进程的后端下一条消息即生效，Claude 长驻进程空闲时重启复用。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  PencilLine,
  RefreshCw,
} from 'lucide-react';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  cliAccountClient,
  type AccountKind,
  type CliAccount,
} from '../../services/cliAccountClient';
import { scopeCatalogToProvider, tabSourceOf, thirdPartyRefOf } from '../../services/cliSource';
import { gatewayClient, gatewayClientAvailable } from '../../services/gatewayClient';
import {
  harnessClient,
  type BackendModelCatalog,
  type HarnessTabMeta,
  type ModelCatalogModel,
  type ReasoningEffort,
  type TabSource,
} from '../../services/harnessClient';
import { useGatewayState } from '../../services/nomiModel';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

/** 模型多于这个数时模型页显示搜索框（与 @nomi-ai/ui 的 Select 一致） */
const MODEL_SEARCH_THRESHOLD = 8;

/** 有官方账号的编程助手 */
const ACCOUNT_KINDS: readonly AccountKind[] = ['claude', 'codex', 'grok', 'gemini'];

/**
 * 没有文档化思考深度控制的后端（Gemini ACP / dsh）：
 * 不暴露可操作的档位 UI，避免假装可调。
 */
const NO_REASONING_BACKENDS = new Set(['gemini', 'dsh']);

/** 档位由浅到深的顺序（只用于排序 CLI 返回的值，不代表某个模型支持哪些） */
const EFFORT_ORDER: ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export function effortLabel(e: ReasoningEffort): string {
  switch (e) {
    case 'minimal':
      return t('ui.chat-settings.minimal');
    case 'low':
      return t('ui.chat-settings.low');
    case 'medium':
      return t('ui.chat-settings.medium');
    case 'high':
      return t('ui.chat-settings.high');
    case 'xhigh':
      return t('ui.chat-settings.extra-high');
    case 'max':
      return t('ui.chat-settings.max');
    case 'ultra':
      return t('ui.chat-settings.ultra');
  }
}

/** 主进程返回的目录做结构校验：无效 / 空后端一律当作「不支持」 */
function validCatalog(c: unknown): BackendModelCatalog | null {
  if (!c || typeof c !== 'object') return null;
  const cat = c as Partial<BackendModelCatalog>;
  if (typeof cat.backend !== 'string' || !Array.isArray(cat.models)) return null;
  const okModel = (m: unknown) =>
    !!m &&
    typeof (m as ModelCatalogModel).id === 'string' &&
    Array.isArray((m as ModelCatalogModel).efforts);
  if (!cat.models.every(okModel)) return null;
  if (cat.defaultModel && !okModel(cat.defaultModel)) return null;
  return { ...cat, defaultModel: cat.defaultModel ?? null } as BackendModelCatalog;
}

/** 向主进程要目录（官方：主进程从 CLI 读取并缓存；第三方：网关的模型）；IPC 本身失败当作不支持 */
function fetchCatalog(
  backend: string,
  refresh: boolean,
  source: TabSource,
): Promise<BackendModelCatalog | null> {
  const opts = {
    ...(refresh ? { refresh } : {}),
    ...(source === 'thirdParty' ? { source } : {}),
  };
  return harnessClient
    .modelCatalog(backend as HarnessTabMeta['backend'], opts)
    .then(validCatalog)
    .catch(() => null);
}

/**
 * 某个后端的模型目录。catalog：undefined = 还在读；null = 该后端不支持切换（按钮整体不渲染）。
 * refresh 让主进程重新读；重读失败时保留原目录。第三方来源在网关的供应商 / 模型变化时自动重读。
 */
function useCatalog(backend: string, source: TabSource) {
  // 目录按「后端 + 来源」存放：换了来源（官方 / 第三方）旧目录自动作废，回到「还在读」
  const key = `${backend}|${source}`;
  const [st, setSt] = useState<{ key: string; catalog: BackendModelCatalog | null } | null>(null);
  const catalog = st?.key === key ? st.catalog : undefined;
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetchCatalog(backend, false, source).then((c) => {
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
  const refresh = () => {
    setRefreshing(true);
    void fetchCatalog(backend, true, source).then((c) => {
      if (c) setSt({ key, catalog: c });
      setRefreshing(false);
    });
  };
  return { catalog, refreshing, refresh };
}

/** 目录里所有模型档位的并集（自定义的未知模型 / CLI 没告诉我们默认模型时用） */
function catalogEfforts(catalog: BackendModelCatalog): ReasoningEffort[] {
  const set = new Set(catalog.models.flatMap((m) => m.efforts));
  return EFFORT_ORDER.filter((e) => set.has(e));
}

/** 按钮浮层的外壳：挂 body、fixed、向上弹，避免输入栏 overflow 裁剪 */
const ChipMenu: React.FC<{
  btnRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  label: string;
  testId: string;
  width?: number;
  children: React.ReactNode;
}> = ({ btnRef, menuRef, onClose, label, testId, width = 300, children }) => {
  const [pos, setPos] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - r.top + 6,
      width,
    });
  }, [btnRef, width]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        onClose();
        btnRef.current?.focus();
        return;
      }
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menuRef, btnRef, onClose]);
  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      style={pos}
      role="dialog"
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  );
};

/** 滑块直径（与 CSS 的 .slider --thumb 一致） */
const THUMB = 18;

/**
 * 分档滑杆（参考 Codex 的推理强度滑杆）：细轨道上每档一个点，下方是档位名；
 * 点击 / 拖动吸附到最近一档，点档位名直接选，键盘 ← → Home End 调档。
 * value = null（沿用 CLI 默认）时不显示滑块与填充。
 * 拖动中只预览，松手才提交，避免每移一格就重启一次 Claude 长驻进程。
 */
const EffortSlider: React.FC<{
  levels: ReasoningEffort[];
  value: ReasoningEffort | null;
  onPreview: (e: ReasoningEffort | null) => void;
  onCommit: (e: ReasoningEffort) => void;
}> = ({ levels, value, onPreview, onCommit }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const idx = value ? levels.indexOf(value) : -1;
  const last = Math.max(levels.length - 1, 1);
  // 第 i 档在「轨道宽 - 滑块宽」区间里的偏移（两端各留半个滑块）
  const at = (i: number, plus = 0) => `calc((100% - ${THUMB}px) * ${i / last} + ${plus}px)`;

  const levelAt = (clientX: number): ReasoningEffort => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= THUMB) return levels[Math.max(idx, 0)];
    const ratio = (clientX - r.left - THUMB / 2) / (r.width - THUMB);
    return levels[Math.round(Math.min(1, Math.max(0, ratio)) * last)];
  };

  const step = (to: number) => {
    const e = levels[Math.min(levels.length - 1, Math.max(0, to))];
    if (e !== value) onCommit(e);
  };

  return (
    <div className={styles.sliderWrap}>
      <div
        ref={trackRef}
        className={styles.slider}
        role="slider"
        tabIndex={0}
        aria-label={t('ui.chat-settings.reasoning-effort')}
        aria-valuemin={0}
        aria-valuemax={levels.length - 1}
        aria-valuenow={idx < 0 ? undefined : idx}
        aria-valuetext={value ? effortLabel(value) : t('ui.providers-schedule.default')}
        data-testid="effort-slider"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(idx < 0 ? 0 : idx + 1);
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(idx < 0 ? 0 : idx - 1);
          else if (e.key === 'Home') step(0);
          else if (e.key === 'End') step(levels.length - 1);
          else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onPreview(levelAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging.current) onPreview(levelAt(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(levelAt(e.clientX));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          onPreview(null);
        }}
      >
        <span className={styles.sliderTrack} />
        {idx >= 0 && <span className={styles.sliderFill} style={{ width: at(idx) }} />}
        {levels.map((l, i) => (
          <span
            key={l}
            className={`${styles.sliderStop} ${i <= idx ? styles.sliderStopOn : ''}`}
            style={{ left: at(i, THUMB / 2) }}
            data-testid={`effort-${l}`}
          />
        ))}
        {idx >= 0 && <span className={styles.sliderThumb} style={{ left: at(idx) }} />}
      </div>
      {/* 档位名：鼠标直接点选（键盘走滑杆本身，这里不进 Tab 顺序） */}
      <div className={styles.sliderLabels} aria-hidden="true">
        {levels.map((l, i) => (
          <span
            key={l}
            className={`${styles.sliderLabel} ${i === idx ? styles.sliderLabelOn : ''}`}
            style={{ left: at(i, THUMB / 2) }}
            onClick={() => {
              if (l !== value) onCommit(l);
            }}
          >
            {effortLabel(l)}
          </span>
        ))}
      </div>
    </div>
  );
};

/** 模型 · 思考深度按钮（一个按钮 + 一个浮层，参考 Codex） */
const ModelChip: React.FC<{
  tab: HarnessTabMeta;
  catalog: BackendModelCatalog;
  refreshing: boolean;
  onRefresh: () => void;
}> = ({ tab, catalog, refreshing, onRefresh }) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'model' | 'account'>('effort');
  const [accounts, setAccounts] = useState<CliAccount[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  /** 模型页的搜索词（模型多于 MODEL_SEARCH_THRESHOLD 个时显示搜索框，与共享的 Select 一致） */
  const [query, setQuery] = useState('');
  /** 拖动滑杆时的预览档位（松手提交后清空，回到以主进程广播的 tab 为准） */
  const [preview, setPreview] = useState<ReasoningEffort | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = tab.modelOverride?.trim() || null;
  // 第三方来源的目录：直接是模型列表，没有思考深度页
  const thirdParty = tabSourceOf(tab) === 'thirdParty';
  const provider =
    catalog.provider ??
    (thirdParty ? { id: 'gateway', name: t('ui.models.third-party-models') } : null);
  const currentModel = useMemo(
    () => catalog.models.find((m) => m.id === current) ?? null,
    [catalog, current],
  );
  // 档位所依据的模型：选了模型用它；没选用 CLI 告诉我们的默认模型
  const info = current ? currentModel : catalog.defaultModel;
  // Gemini / dsh：没有文档化的思考深度控制，整后端禁用；其余看 CLI 是否声明该模型支持
  const backendBlocksEffort = NO_REASONING_BACKENDS.has(tab.backend);
  const noReasoning = backendBlocksEffort || (!!info && !info.reasoning);
  // 档位全部来自 CLI：模型自己的 > 目录并集（自定义的未知模型 / 默认模型未知）
  const levels: ReasoningEffort[] = noReasoning
    ? []
    : info?.efforts.length
      ? info.efforts
      : catalogEfforts(catalog);
  const reasoningSupported = levels.length > 0;
  const effort = reasoningSupported
    ? ((tab.reasoningEffort ?? null) as ReasoningEffort | null)
    : null;
  // null 表示沿用 CLI 默认，界面仍应把 CLI 返回的默认档位显示在对应位置。
  const defaultEffort =
    reasoningSupported && info?.defaultEffort && levels.includes(info.defaultEffort)
      ? info.defaultEffort
      : null;
  const shown = preview ?? effort ?? defaultEffort;

  const defaultLabel = catalog.defaultModel?.label ?? catalog.defaultModel?.id;
  // 没选模型时显示 CLI 默认用的那个模型名（浮层里再标「默认」）
  const modelLabel = current
    ? (currentModel?.label ?? current)
    : (defaultLabel ?? t('ui.providers-schedule.default-model'));
  // 没有显式覆盖时也显示 CLI 的实际默认档位，让底部按钮直接反映当前设置。
  const chipEffort = effort ?? defaultEffort;
  const shortLabel = chipEffort ? `${modelLabel} · ${effortLabel(chipEffort)}` : modelLabel;
  const backendName = ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME];
  // 模型列表从哪来：官方账号是 CLI 自己，第三方是网关
  const sourceName = provider?.name || backendName;
  // 官方来源的标签可以单独选官方账号（多个账号并行，§5.10.8）
  const accountKind =
    !thirdParty && ACCOUNT_KINDS.includes(tab.backend as AccountKind)
      ? (tab.backend as AccountKind)
      : null;
  const defaultAccount = accounts.find((a) => a.active);
  const pinnedAccount = tab.accountId ? accounts.find((a) => a.id === tab.accountId) : undefined;
  const accountLabel = tab.accountId
    ? (pinnedAccount?.label ?? t('ui.models.removed-account'))
    : t(
        'ui.models.follow-default',
        defaultAccount?.label ?? t('ui.models.this-computer-s-sign-in'),
      );

  useEffect(() => {
    if (!open || !accountKind) return;
    let alive = true;
    void cliAccountClient
      .list(accountKind)
      .then((l) => alive && setAccounts(l))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, accountKind]);

  const pickAccount = (id: string | null) => {
    setView('effort');
    if ((tab.accountId ?? null) === id) return;
    void run(() => harnessClient.setTabAccount(tab.id, id));
  };

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(id);
  }, [note]);

  const run = async (fn: () => Promise<unknown>) => {
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = () => {
    setView(provider ? 'model' : 'effort');
    setCustomOpen(false);
    setQuery('');
    setPreview(null);
    setOpen((o) => !o);
  };

  // 选完模型回到滑杆页，接着调档位（与 Codex 一致的「一次选完」）
  const pickModel = (model: string) => {
    setCustomOpen(false);
    setQuery('');
    setView('effort');
    if (provider) setOpen(false);
    if (model === (current ?? '')) return;
    void run(() => harnessClient.setTabModel(tab.id, model, { expectSource: tabSourceOf(tab) }));
  };

  const q = query.trim().toLowerCase();
  const searchable = catalog.models.length > MODEL_SEARCH_THRESHOLD;
  const shownModels = q
    ? catalog.models.filter((m) =>
        `${m.id} ${m.label ?? ''} ${m.description ?? ''}`.toLowerCase().includes(q),
      )
    : catalog.models;

  const pickEffort = (e: ReasoningEffort | null) => {
    setPreview(null);
    // 点击 CLI 默认所在的档位不应把“沿用默认”变成显式覆盖。
    if (e === effort || (effort === null && e === defaultEffort)) return;
    void run(() => harnessClient.setTabEffort(tab.id, e));
  };

  return (
    <div className={styles.wrap}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.chip} ${!current && !chipEffort ? styles.chipMuted : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          provider
            ? t('ui.chat-settings.model', provider.name, shortLabel)
            : t('ui.chat-settings.model-and-reasoning-effort', shortLabel)
        }
        title={t('ui.chat-settings.takes-effect-from-the-next-message-current-tab')}
        data-testid="model-chip"
        onClick={toggle}
      >
        <Icon icon={Cpu} size={14} />
        <span className={styles.label}>{shortLabel}</span>
        <Icon icon={ChevronDown} size={12} />
      </button>
      {note && (
        <span className={styles.note} role="status" data-testid="model-chip-note">
          {note}
        </span>
      )}
      {open && (
        <ChipMenu
          btnRef={btnRef}
          menuRef={menuRef}
          onClose={() => setOpen(false)}
          label={
            provider
              ? t('ui.foundation.model')
              : t('ui.chat-settings.model-and-reasoning-effort-label')
          }
          testId="model-menu"
          width={300}
        >
          {view === 'effort' ? (
            <div className={styles.effortView} data-testid="effort-view">
              {reasoningSupported ? (
                <>
                  <div className={styles.effortHead}>
                    <span className={styles.effortHeadLabel}>
                      {t('ui.chat-settings.reasoning-effort')}
                    </span>
                    {effort && (
                      <button
                        type="button"
                        className={styles.link}
                        data-testid="effort-default"
                        onClick={() => pickEffort(null)}
                      >
                        {t('ui.providers-schedule.restore-defaults')}
                      </button>
                    )}
                  </div>
                  <EffortSlider
                    levels={levels}
                    value={shown}
                    onPreview={setPreview}
                    onCommit={pickEffort}
                  />
                </>
              ) : (
                <div
                  className={`${styles.effortHead} ${styles.effortUnavailable}`}
                  data-testid="effort-unavailable"
                >
                  <span className={styles.effortHeadLabel}>
                    {t('ui.chat-settings.reasoning-effort')}
                  </span>
                  <p className={styles.effortHint} data-testid="effort-hint" role="status">
                    {backendBlocksEffort
                      ? t(
                          'ui.chat-settings.has-no-documented-reasoning-effort-control-nomi-will',
                          backendName || tab.backend,
                        )
                      : t('ui.chat-settings.this-model-has-no-reasoning-effort')}
                  </p>
                </div>
              )}
              <button
                type="button"
                className={styles.modelRow}
                data-testid="model-open"
                aria-label={t('ui.chat-settings.switch-model', modelLabel)}
                onClick={() => setView('model')}
              >
                <span className={styles.modelRowLabel}>{t('ui.foundation.model')}</span>
                <span className={styles.modelRowValue}>
                  <span className={styles.modelLinkText}>{modelLabel}</span>
                </span>
                <Icon icon={ChevronRight} size={14} />
              </button>
              {accountKind && (
                <button
                  type="button"
                  className={styles.modelRow}
                  data-testid="account-open"
                  aria-label={t('ui.models.switch-official-account', accountLabel)}
                  onClick={() => setView('account')}
                >
                  <span className={styles.modelRowLabel}>{t('ui.models.account')}</span>
                  <span className={styles.modelRowValue}>
                    <span className={styles.modelLinkText}>{accountLabel}</span>
                  </span>
                  <Icon icon={ChevronRight} size={14} />
                </button>
              )}
            </div>
          ) : view === 'account' ? (
            <>
              <div className={styles.modelHead}>
                <button
                  type="button"
                  className={styles.back}
                  data-testid="account-back"
                  onClick={() => setView('effort')}
                >
                  <Icon icon={ChevronLeft} size={14} />
                  {t('ui.chat-settings.official-accounts')}
                </button>
              </div>
              <div
                className={styles.models}
                role="listbox"
                aria-label={t('ui.chat-settings.official-accounts')}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={!tab.accountId}
                  className={styles.item}
                  data-testid="account-default"
                  onClick={() => pickAccount(null)}
                >
                  <span className={styles.itemLabel}>
                    {t('ui.models.follow-the-default-account')}
                  </span>
                  <span className={styles.itemHint}>
                    {defaultAccount?.label ?? t('ui.models.this-computer-s-sign-in')}
                  </span>
                  {!tab.accountId && <Icon icon={Check} size={14} />}
                </button>
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={tab.accountId === a.id}
                    className={styles.item}
                    data-testid={`account-${a.id}`}
                    disabled={!a.loggedIn}
                    title={a.identity?.email ?? a.label}
                    onClick={() => pickAccount(a.id)}
                  >
                    <span className={styles.itemLabel}>{a.label}</span>
                    <span className={styles.itemHint}>
                      {a.loggedIn ? (a.identity?.plan ?? '') : t('ui.models.not-signed-in')}
                    </span>
                    {tab.accountId === a.id && <Icon icon={Check} size={14} />}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className={styles.modelHead}>
                {provider ? (
                  <span className={styles.back} data-testid="model-provider">
                    {t('ui.chat-settings.models', provider.name)}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.back}
                    data-testid="model-back"
                    onClick={() => setView('effort')}
                  >
                    <Icon icon={ChevronLeft} size={14} />
                    {t('ui.foundation.model')}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.back}
                  data-testid="model-refresh"
                  disabled={refreshing}
                  aria-label={t('ui.chat-settings.reload-the-model-list-from', sourceName)}
                  title={t('ui.chat-settings.reload-the-model-list-from', sourceName)}
                  onClick={onRefresh}
                >
                  <span className={refreshing ? styles.spin : undefined}>
                    <Icon icon={RefreshCw} size={13} />
                  </span>
                </button>
              </div>
              {catalog.error && (
                <div className={styles.modelError} role="status" data-testid="model-error">
                  {t(
                    'ui.chat-settings.couldn-t-read-the-model-list-from',
                    sourceName,
                    catalog.error,
                  )}
                </div>
              )}
              {backendBlocksEffort && (
                <div className={styles.effortHint} role="status" data-testid="effort-hint">
                  {t(
                    'ui.chat-settings.has-no-documented-reasoning-effort-control-nomi-will',
                    backendName || tab.backend,
                  )}
                </div>
              )}
              {searchable && (
                <input
                  autoFocus
                  type="search"
                  className={styles.customInput}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // 回车选第一个匹配的；Esc 先清空搜索词，再按一次才关菜单
                    if (e.key === 'Enter' && shownModels[0]) {
                      e.preventDefault();
                      pickModel(shownModels[0].id);
                    } else if (e.key === 'Escape' && query) {
                      e.preventDefault();
                      e.stopPropagation();
                      setQuery('');
                    }
                  }}
                  placeholder={t('ui.session-workspace.search-models')}
                  aria-label={t('ui.session-workspace.search-models')}
                  data-testid="model-search"
                />
              )}
              <div className={styles.models} role="listbox" aria-label={t('ui.foundation.model')}>
                {!q && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={!current}
                    className={styles.item}
                    data-testid="model-default"
                    title={t('ui.chat-settings.follows-s-own-choice', sourceName)}
                    onClick={() => pickModel('')}
                  >
                    <span className={styles.itemLabel}>
                      {t('ui.providers-schedule.default-model')}
                    </span>
                    <span className={styles.itemHint}>{defaultLabel ?? sourceName}</span>
                    {!current && <Icon icon={Check} size={14} />}
                  </button>
                )}
                {q && !shownModels.length && (
                  <div className={styles.modelError} role="status" data-testid="model-search-empty">
                    {t('ui.session-workspace.no-models-match', query.trim())}
                  </div>
                )}
                {shownModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={current === m.id}
                    className={styles.item}
                    data-testid={`model-${m.id}`}
                    title={m.description ? `${m.id} · ${m.description}` : m.id}
                    onClick={() => pickModel(m.id)}
                  >
                    <span className={styles.itemLabel}>{m.label ?? m.id}</span>
                    {!m.reasoning && !provider && (
                      <span className={styles.itemHint}>
                        {t('ui.chat-settings.no-reasoning-effort')}
                      </span>
                    )}
                    {current === m.id && <Icon icon={Check} size={14} />}
                  </button>
                ))}
                {current && !currentModel && !q && (
                  <button
                    type="button"
                    role="option"
                    aria-selected
                    className={styles.item}
                    data-testid="model-current-custom"
                    onClick={() => pickModel(current)}
                  >
                    <span className={styles.itemLabel}>{current}</span>
                    <span className={styles.itemHint}>{t('ui.providers-schedule.custom')}</span>
                    <Icon icon={Check} size={14} />
                  </button>
                )}
              </div>
              {/* 第三方的模型只能从网关的列表里选（值是 `供应商/模型`），不提供自定义 id */}
              {!thirdParty && (
                <div className={styles.custom}>
                  {customOpen ? (
                    <form
                      className={styles.customForm}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = customName.trim();
                        if (name) pickModel(name);
                      }}
                    >
                      <input
                        autoFocus
                        className={styles.customInput}
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder={t('ui.chat-settings.model-id')}
                        aria-label={t('ui.chat-settings.custom-model-id')}
                        maxLength={128}
                        data-testid="model-custom-input"
                      />
                      <button
                        type="submit"
                        className={styles.link}
                        disabled={!customName.trim()}
                        data-testid="model-custom-ok"
                      >
                        {t('ui.chat-settings.use')}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className={styles.link}
                      data-testid="model-custom-toggle"
                      onClick={() => {
                        setCustomName(current ?? '');
                        setCustomOpen(true);
                      }}
                    >
                      <Icon icon={PencilLine} size={13} />
                      {t('ui.chat-settings.custom-model-id')}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </ChipMenu>
      )}
    </div>
  );
};

/**
 * 目录还在从 CLI 读（Claude / Grok 冷启动要一两秒）：先放一个不可点的按钮占位，免得读完才突然冒出来。
 * 不支持切换的后端主进程立刻返回 null，所以只在读取超过一小会儿时才显示，避免一闪而过。
 */
const LoadingChip: React.FC<{ tab: HarnessTabMeta }> = ({ tab }) => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  const label = tab.modelOverride?.trim() || t('ui.providers-schedule.default-model');
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.chip} ${styles.chipMuted}`}
        disabled
        aria-busy="true"
        aria-label={t(
          'ui.chat-settings.reading-the-model-list-from',
          ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME],
        )}
        data-testid="model-chip-loading"
      >
        <Icon icon={Cpu} size={14} />
        <span className={styles.label}>{label}</span>
        <span className={styles.spin}>
          <Icon icon={RefreshCw} size={12} />
        </span>
      </button>
    </div>
  );
};

/** 输入栏入口：无模型目录的后端不渲染；第三方来源列网关的模型 */
export const ModelControls: React.FC<{ tab: HarnessTabMeta }> = ({ tab }) => {
  const source = tabSourceOf(tab);
  const { catalog, refreshing, refresh } = useCatalog(tab.backend, source);
  const gateway = useGatewayState();
  const thirdRef = source === 'thirdParty' ? thirdPartyRefOf(tab, tab.backend, gateway) : null;
  // 第三方：只列当前供应商的模型
  const scoped = useMemo(
    () => (catalog && thirdRef ? scopeCatalogToProvider(catalog, thirdRef, gateway) : catalog),
    [catalog, thirdRef, gateway],
  );
  if (scoped === null) return null;
  if (scoped === undefined) return <LoadingChip tab={tab} />;
  return <ModelChip tab={tab} catalog={scoped} refreshing={refreshing} onRefresh={refresh} />;
};
