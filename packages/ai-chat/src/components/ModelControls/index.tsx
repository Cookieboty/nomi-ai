import { BUILTIN_CLI_ORDER, cliCapability } from '@nomi-ai/cli-catalog';
/**
 * 输入栏的「模型 · 思考深度」按钮（编程助手标签：Codex / Claude Code / Grok 等）。
 *
 * 标签来源是第三方（docs/development/gateway.md）时，同一个按钮列**所有第三方供应商**的模型
 * （主进程 ai:harness:model-catalog 带 source: 'thirdParty'，id 是 `供应商/模型`）：顶部按供应商分标签、
 * 左侧按厂商快速筛选（与对话输入栏的模型选择器一致），第三方之间换供应商原地续接（第 5 条）；
 * 直接打开模型列表、没有思考深度；新标签默认在侧栏信息卡（CliDefaultSource）。
 * 「默认模型」= 这个 CLI 在「模型」页分配的模型（属于当前供应商时）。
 *
 * 交互参考 Codex：一个按钮显示「模型 · 档位」，点开一个浮层，节省输入栏空间；
 * - 默认页：大字显示当前档位，下面「模型名 ›」，再下面是分档滑杆（只在推理模型上出现）；
 *   不选档位 = 不发覆盖参数，沿用 CLI 默认；CLI 告诉我们默认档位时滑块定位到该档位；
 * - 点「模型名 ›」进入模型页：跟随 CLI 默认 / 目录内模型，选完回到滑杆（不提供自定义模型 id）。
 * 官方来源的模型列表、每个模型的档位与默认档位全部来自 CLI 自己（主进程读取并缓存，见
 * core/src/cli/modelDiscovery.ts），这里不写死任何模型或档位；读不到时只保留默认。
 * 覆盖是标签级的，主进程在每轮启动时以进程级参数注入
 * （codex `-c model=...`、grok `-m ... --reasoning-effort ...`、claude `--model ... --effort ...`），
 * 不改写用户的全局 CLI 配置；每轮新进程的后端下一条消息即生效，Claude 长驻进程空闲时重启复用。
 */
import {
  BrandIcon,
  formatContext,
  Icon,
  IconButton,
  isImageModel,
  modelBrandOf,
  ModelPicker,
  Select,
  t,
  type ModelProviderTab,
  type PickerModel,
  type PickerProvider,
  type SelectOption,
} from '@nomi-ai/ui';
import { ChevronDown, ChevronLeft, ChevronRight, Cpu, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  cliAccountClient,
  type AccountKind,
  type CliAccount,
} from '../../services/cliAccountClient';
import {
  codingProviders,
  defaultSourceSwitch,
  isCliKind,
  providerOfRef,
  scopeCatalogToProvider,
  scopeCatalogToProviders,
  sessionModelGroups,
  switchTabSource,
  tabSourceOf,
  thirdPartyRefOf,
  type CodingProvider,
  type SessionModelGroup,
  type SourceSwitch,
} from '../../services/cliSource';
import { gatewayClient, gatewayClientAvailable } from '../../services/gatewayClient';
import {
  harnessClient,
  type BackendModelCatalog,
  type HarnessTabMeta,
  type ModelCatalogModel,
  type ReasoningEffort,
  type TabSource,
} from '../../services/harnessClient';
import { longContextFor, type LongContextInfo } from '../../services/longContext';
import { registerModelMenu } from '../../services/modelMenu';
import { pickerProviders, providerBrand, useGatewayState } from '../../services/nomiModel';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import { effortLabel } from './effortLabel';
import { EffortSlider } from './EffortSlider';
import styles from './index.module.css';

export { effortLabel };

/** 官方来源标签的模型页里，CLI 自己那一页的标签 id（不会和网关供应商 id 撞上） */
const OWN_TAB = '__cli';
/** 模型页里的特殊选项（值不含 `/`，与 `供应商/模型` 区分）：当前模型不在目录里 / 切换来源的第 n 项 */
const CUSTOM = '__custom';
const SWITCH = 'switch:';
/** 第三方模型名去掉厂商前缀（anthropic/claude-fable-5 → claude-fable-5）：左侧已有厂商筛选与分组标题 */
const shortName = (s: string) => s.slice(s.lastIndexOf('/') + 1);

/** 有官方账号的编程助手（清单 officialAccount） */
const ACCOUNT_KINDS = BUILTIN_CLI_ORDER.filter((id): id is AccountKind =>
  cliCapability(id, 'officialAccount'),
);

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

/**
 * 模型页（共享 ModelPicker）的高度上限：浮层向上弹，不超出按钮上方的空间；
 * 官方来源多一行「‹ 模型」返回，有长上下文时下面多一组
 */
function pickerHeight(btn: HTMLElement | null, onlyModels: boolean, long: boolean): number {
  const top = btn?.getBoundingClientRect().top ?? 600;
  const reserved = 6 + 16 + 12 + (onlyModels ? 0 : 36) + (long ? 84 : 0);
  return Math.max(200, Math.min(420, top - reserved));
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

/** 模型 · 思考深度按钮（一个按钮 + 一个浮层，参考 Codex） */
const ModelChip: React.FC<{
  tab: HarnessTabMeta;
  catalog: BackendModelCatalog;
  refreshing: boolean;
  onRefresh: () => void;
  /** 第三方模型可开长上下文时的信息；null = 不显示「上下文」一组 */
  long?: LongContextInfo | null;
  /**
   * 聊过的第三方会话实际在用的模型（没手动选时就是会话上次用的）：勾选打在它上面，
   * 不再显示「默认模型」一行（清掉选择回到的是会话上次的模型，不是「模型」页的默认）
   */
  sessionRef?: string | null;
  /** 列了几个供应商时的分组（原来的供应商 / 默认供应商）；不到两组不分 */
  groups?: SessionModelGroup[] | null;
  /** 标签来源与「新标签默认用」不同时，切到默认来源的一组（官方账号 / 默认供应商的模型） */
  sourceSwitch?: SourceSwitch | null;
  /** 第三方：目录里列了几个供应商时按供应商分标签（多于一个才显示） */
  providerTabs?: ModelProviderTab[] | null;
  /**
   * 官方来源（CLI 自己的配置 / 官方账号）的标签：网关里能给编程助手用的供应商。
   * 有的话模型页与 Nomi 的模型选择器同形：第一个标签是 CLI 自己的模型，后面每个供应商一个标签，
   * 选供应商的模型 = 把标签切到第三方并用这个模型（原地续接）
   */
  switchProviders?: CodingProvider[] | null;
  /** 「模型」页给这个编程助手分配的默认供应商（标签上标「默认供应商」） */
  defaultProviderId?: string | null;
  /** 网关模型（`供应商/模型`）的能力与上下文窗口（与 Nomi 的模型选择器显示同样的信息） */
  modelMeta?: ReadonlyMap<string, PickerModel> | null;
}> = ({
  tab,
  catalog,
  refreshing,
  onRefresh,
  long = null,
  sessionRef = null,
  groups = null,
  sourceSwitch = null,
  providerTabs: thirdPartyTabs = null,
  switchProviders = null,
  defaultProviderId = null,
  modelMeta = null,
}) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'model' | 'account'>('effort');
  const [accounts, setAccounts] = useState<CliAccount[]>([]);
  const [note, setNote] = useState<string | null>(null);
  /** 打开模型页时搜索框里预先填的内容（`/model gpt` 的 gpt） */
  const [query, setQuery] = useState('');
  /** 拖动滑杆时的预览档位（松手提交后清空，回到以主进程广播的 tab 为准） */
  const [preview, setPreview] = useState<ReasoningEffort | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = tab.modelOverride?.trim() || sessionRef || null;
  const backendName = ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME];
  // 官方来源 + 网关里有供应商：第一个标签是 CLI 自己的模型，其余是网关供应商（与 Nomi 的选择器同形）
  const officialTabs = useMemo<ModelProviderTab[] | null>(
    () =>
      switchProviders?.length && tabSourceOf(tab) !== 'thirdParty'
        ? [
            { id: OWN_TAB, name: backendName || tab.backend },
            ...switchProviders.map((p) => ({
              id: p.id,
              name: p.name,
              ...(p.id === defaultProviderId
                ? { hint: t('ui.models.default-provider-named', p.name) }
                : {}),
            })),
          ]
        : null,
    [switchProviders, tab, backendName, defaultProviderId],
  );
  const providerTabs = thirdPartyTabs ?? officialTabs;
  const tabbed = !!providerTabs && providerTabs.length > 1;
  // 分了供应商标签就不再按组列标题（组的说明放到标签的悬停提示里）
  const grouped = !tabbed && !!groups && groups.length > 1;
  // 第三方来源的目录：直接是模型列表，没有思考深度页
  const thirdParty = tabSourceOf(tab) === 'thirdParty';
  const provider = useMemo(
    () =>
      catalog.provider ??
      (thirdParty ? { id: 'gateway', name: t('ui.models.third-party-models') } : null),
    [catalog.provider, thirdParty],
  );
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
  // 分组时同名模型可能出现在两家：按钮上带上供应商名
  const groupOf = (id: string) => groups?.find((g) => id.startsWith(`${g.id}/`));
  const currentGroupName =
    current && tabbed
      ? (providerTabs.find((p) => p.id === providerOfRef(current))?.name ?? null)
      : grouped && current
        ? (groupOf(current)?.name ?? null)
        : null;
  const modelLabel = current
    ? currentGroupName
      ? `${currentGroupName} / ${currentModel?.label ?? current}`
      : (currentModel?.label ?? current)
    : (defaultLabel ?? t('ui.providers-schedule.default-model'));
  // 没有显式覆盖时也显示 CLI 的实际默认档位，让底部按钮直接反映当前设置。
  const chipEffort = effort ?? defaultEffort;
  const shortLabel = chipEffort ? `${modelLabel} · ${effortLabel(chipEffort)}` : modelLabel;
  // 按钮上的图标：认得出模型厂商或供应商品牌就用它的图标，否则通用芯片图标
  const gateway = useGatewayState();
  const chipModelId = current ?? catalog.defaultModel?.id ?? null;
  const chipBrand = chipModelId
    ? modelBrandOf(chipModelId, providerBrand(gateway, providerOfRef(chipModelId)))
    : undefined;
  /** 开 / 关长上下文；与模型默认相同时存 null（跟随默认），免得模型默认改了这里还钉着旧值 */
  const pickLong = (on: boolean) => {
    if (!long || on === long.on) return;
    void run(() => harnessClient.setTabLongContext(tab.id, on === long.modelDefault ? null : on));
  };
  // 模型列表从哪来：官方账号是 CLI 自己，第三方是网关
  const sourceName = provider?.name || backendName;
  // 官方来源的标签可以单独选官方账号（多个账号并行）
  const accountKind =
    !thirdParty && ACCOUNT_KINDS.includes(tab.backend as AccountKind)
      ? (tab.backend as AccountKind)
      : null;
  const defaultAccount = useMemo(() => accounts.find((a) => a.active), [accounts]);
  const pinnedAccount = tab.accountId ? accounts.find((a) => a.id === tab.accountId) : undefined;
  const accountLabel = tab.accountId
    ? (pinnedAccount?.label ?? t('ui.models.removed-account'))
    : t(
        'ui.models.follow-default',
        defaultAccount?.label ?? t('ui.models.this-computer-s-sign-in'),
      );

  // 第三方标签可切到官方账号时，也读账号列表：「切换到官方账号」后面写上默认账号
  const listKind =
    accountKind ??
    (sourceSwitch?.target === 'official' && ACCOUNT_KINDS.includes(tab.backend as AccountKind)
      ? (tab.backend as AccountKind)
      : null);
  useEffect(() => {
    if (!open || !listKind) return;
    let alive = true;
    void cliAccountClient
      .list(listKind)
      .then((l) => alive && setAccounts(l))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, listKind]);

  /**
   * 切到默认来源（主进程 setTabSource）：官方 → 第三方在原会话上续接；第三方 → 官方时第三方的推理内容
   * 不能发给官方接口，CLI 换一个会话、带上现在的对话作前文（标签和对话都不变，已有对话时先确认）
   */
  const pickSource = (item: SourceSwitch['items'][number]) => {
    if (!sourceSwitch) return;
    setOpen(false);
    setQuery('');
    void run(() =>
      switchTabSource(tab, sourceSwitch.target, {
        model: item.model,
        hasMessages: !!tab.cliSessionId || (tab.carriedMessages ?? 0) > 0,
      }),
    );
  };

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

  /** 官方来源停在网关供应商上选了模型 = 把标签切到第三方并用这个模型（原地续接，同「切到默认来源」） */
  const pickSwitchModel = (ref: string) => {
    setQuery('');
    setView('effort');
    setOpen(false);
    void run(() =>
      switchTabSource(tab, 'thirdParty', {
        model: ref,
        hasMessages: !!tab.cliSessionId || (tab.carriedMessages ?? 0) > 0,
      }),
    );
  };

  /** 模型页高度上限：浮层向上弹，不超出按钮上方的空间（再减去返回行与长上下文一组）；打开时量一次 */
  const [pickerMax, setPickerMax] = useState(420);
  const hasProvider = !!provider;
  const hasLong = !!long;
  const measure = () => setPickerMax(pickerHeight(btnRef.current, hasProvider, hasLong));

  // `/model` 打开同一个浮层：直接到模型列表，搜索框里填上参数
  useEffect(
    () =>
      registerModelMenu(tab.id, (q) => {
        setPickerMax(pickerHeight(btnRef.current, hasProvider, hasLong));
        setView('model');
        setQuery(q);
        setPreview(null);
        setOpen(true);
      }),
    [tab.id, hasProvider, hasLong],
  );

  const toggle = () => {
    if (!open) measure();
    setView(provider ? 'model' : 'effort');
    setQuery('');
    setPreview(null);
    setOpen((o) => !o);
  };

  // 选完模型回到滑杆页，接着调档位（与 Codex 一致的「一次选完」）
  const pickModel = (model: string) => {
    setQuery('');
    setView('effort');
    if (provider) setOpen(false);
    if (model === (current ?? '')) return;
    void run(() => harnessClient.setTabModel(tab.id, model, { expectSource: tabSourceOf(tab) }));
  };

  /**
   * 模型页用共享的 ModelPicker（与 Nomi 对话的模型下拉同一个组件）：
   * - 第三方：目录里每个供应商一个标签（模型 id 是 `供应商/模型`），左侧按厂商筛选；
   * - 官方：CLI 自己的模型放在 OWN_TAB 下；网关里有能给编程助手用的供应商时，每个供应商再一个标签。
   * toCatalog：选择器里的值 → 目录里的模型 id（官方 CLI 自己的模型）或网关的 `供应商/模型`
   */
  const { pickerList, toCatalog } = useMemo(() => {
    const toCatalog = new Map<string, string>();
    const meta = (ref: string) => modelMeta?.get(ref);
    if (thirdParty) {
      // 网关给出了两个以上供应商才分标签；否则整份目录是一个供应商（模型 id 照原样，可能带厂商前缀）
      const split = (thirdPartyTabs?.length ?? 0) > 1;
      const one = provider?.id ?? 'gateway';
      const byPid = new Map<string, PickerModel[]>();
      for (const m of catalog.models) {
        const pid = (split && providerOfRef(m.id)) || one;
        const id = split && providerOfRef(m.id) ? m.id.slice(pid.length + 1) : m.id;
        const g = meta(m.id);
        toCatalog.set(`${pid}/${id}`, m.id);
        if (!byPid.has(pid)) byPid.set(pid, []);
        byPid.get(pid)!.push({
          ...g,
          id,
          label: m.label ?? g?.label,
          reasoning: g?.reasoning ?? m.reasoning,
        });
      }
      const named = new Map((thirdPartyTabs ?? []).map((p) => [p.id, p]));
      const pickerList: PickerProvider[] = [...byPid].map(([pid, models]) => ({
        id: pid,
        name: named.get(pid)?.name ?? provider?.name ?? pid,
        brand: providerBrand(gateway, pid),
        ...(named.get(pid)?.hint ? { hint: named.get(pid)!.hint } : {}),
        models,
      }));
      // 标签顺序跟随网关里供应商的顺序
      const order = new Map((thirdPartyTabs ?? []).map((p, i) => [p.id, i]));
      pickerList.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
      return { pickerList, toCatalog };
    }
    const own: PickerProvider = {
      id: OWN_TAB,
      name: backendName || tab.backend,
      // 官方目录都是同一家：不按厂商筛
      vendors: false,
      models: catalog.models.map((m) => {
        toCatalog.set(`${OWN_TAB}/${m.id}`, m.id);
        return { id: m.id, label: m.label, reasoning: m.reasoning };
      }),
    };
    if (!officialTabs) return { pickerList: [own], toCatalog };
    const others: PickerProvider[] = (switchProviders ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      brand: providerBrand(gateway, p.id),
      ...(p.id === defaultProviderId
        ? { hint: t('ui.models.default-provider-named', p.name) }
        : {}),
      models: p.models.map((m) => {
        toCatalog.set(m.ref, m.ref);
        return { ...meta(m.ref), id: m.model };
      }),
    }));
    return { pickerList: [own, ...others], toCatalog };
  }, [
    thirdParty,
    catalog,
    provider,
    thirdPartyTabs,
    modelMeta,
    backendName,
    tab.backend,
    officialTabs,
    switchProviders,
    defaultProviderId,
    gateway,
  ]);
  const catalogRef = useMemo(() => new Map([...toCatalog].map(([v, id]) => [id, v])), [toCatalog]);
  const pickerValue = current ? (currentModel ? (catalogRef.get(current) ?? null) : CUSTOM) : null;

  // 官方来源已经按供应商分标签列出网关模型时，不再另列「默认供应商」一组
  const switchItems = useMemo(
    () =>
      sourceSwitch && !(officialTabs && sourceSwitch.target === 'thirdParty')
        ? sourceSwitch.items
        : [],
    [sourceSwitch, officialTabs],
  );
  const extraOptions = useMemo<SelectOption[]>(
    () => [
      // 聊过的第三方会话：清掉选择回到的是会话上次的模型，不是「模型」页的默认，不列「默认模型」
      ...(!sessionRef
        ? [
            {
              value: '',
              label: t('ui.providers-schedule.default-model'),
              description:
                (defaultLabel && thirdParty ? shortName(defaultLabel) : defaultLabel) ?? sourceName,
              hint: t('ui.chat-settings.follows-s-own-choice', sourceName),
              testId: 'model-default',
            },
          ]
        : []),
      ...(current && !currentModel
        ? [
            {
              value: CUSTOM,
              label: current,
              description: t('ui.providers-schedule.custom'),
              testId: 'model-current-custom',
            },
          ]
        : []),
    ],
    [sessionRef, defaultLabel, thirdParty, sourceName, current, currentModel],
  );
  const tailOptions = useMemo<SelectOption[]>(
    () =>
      switchItems.map((i, n) => ({
        value: `${SWITCH}${n}`,
        label: i.label,
        group: sourceSwitch!.title,
        ...(sourceSwitch!.target === 'official' && defaultAccount
          ? { description: defaultAccount.label }
          : {}),
        testId: `model-switch-${i.id}`,
      })),
    [switchItems, sourceSwitch, defaultAccount],
  );
  const optionTestId = useCallback((v: string) => `model-${toCatalog.get(v) ?? v}`, [toCatalog]);

  /** 选中了一项（inline 时点当前值也通知）：与 Esc 区分开 */
  const picked = useRef(false);
  const onPick = (v: string) => {
    picked.current = true;
    if (v === '') return pickModel('');
    if (v === CUSTOM) return pickModel(current ?? '');
    if (v.startsWith(SWITCH)) {
      const item = switchItems[Number(v.slice(SWITCH.length))];
      if (item) pickSource(item);
      return;
    }
    const id = toCatalog.get(v);
    if (id === undefined) return;
    if (officialTabs && !v.startsWith(`${OWN_TAB}/`)) return pickSwitchModel(id);
    pickModel(id);
  };
  const onPickerOpenChange = (o: boolean) => {
    if (o) return;
    if (picked.current) {
      picked.current = false;
      return;
    }
    // Esc：关掉整个浮层（与滑杆页一致），焦点回到按钮
    setOpen(false);
    btnRef.current?.focus();
  };

  const pickEffort = (e: ReasoningEffort | null) => {
    setPreview(null);
    // 点击 CLI 默认所在的档位不应把“沿用默认”变成显式覆盖。
    if (e === effort || (effort === null && e === defaultEffort)) return;
    void run(() => harnessClient.setTabEffort(tab.id, e));
  };

  const refreshButton = (
    <IconButton
      size="sm"
      data-testid="model-refresh"
      disabled={refreshing}
      label={t('ui.chat-settings.reload-the-model-list-from', sourceName)}
      onClick={onRefresh}
      icon={
        <span className={refreshing ? styles.spin : undefined}>
          <Icon icon={RefreshCw} size={13} />
        </span>
      }
    />
  );
  // 模型页的提示（读不到目录的原因 / 后端没有思考深度控制）：放在选择器顶部
  const pickerNotice =
    catalog.error || backendBlocksEffort ? (
      <>
        {catalog.error && (
          <div className="cd-model-picker__notice" role="status" data-testid="model-error">
            {t('ui.chat-settings.couldn-t-read-the-model-list-from', sourceName, catalog.error)}
          </div>
        )}
        {backendBlocksEffort && (
          <div className="cd-model-picker__notice" role="status" data-testid="effort-hint">
            {t(
              'ui.chat-settings.has-no-documented-reasoning-effort-control-nomi-will',
              backendName || tab.backend,
            )}
          </div>
        )}
      </>
    ) : null;

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
        {chipBrand ? (
          <BrandIcon brand={chipBrand} name={modelLabel} size={14} />
        ) : (
          <Icon icon={Cpu} size={14} />
        )}
        <span className={styles.label}>{shortLabel}</span>
        {long?.on && (
          <span className={styles.longBadge} data-testid="model-chip-long">
            {t('ui.models.long-context-short')}
          </span>
        )}
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
          width={view === 'model' && (thirdParty || officialTabs) ? 380 : 300}
        >
          {view === 'effort' ? (
            <div className={styles.effortView} data-testid="effort-view">
              {reasoningSupported ? (
                <>
                  <div className={styles.effortHead}>
                    <span className={styles.effortHeadLabel}>
                      {t('ui.chat-settings.reasoning-effort')}
                    </span>
                    {effort ? (
                      <button
                        type="button"
                        className={styles.link}
                        data-testid="effort-default"
                        onClick={() => pickEffort(null)}
                      >
                        {t('ui.providers-schedule.restore-defaults')}
                      </button>
                    ) : (
                      // 沿用默认、CLI 又没告诉我们默认是哪一档：说明由谁决定，而不是留一个空滑块
                      !defaultEffort && (
                        <span className={styles.effortNote} data-testid="effort-default-unknown">
                          {t(
                            'ui.chat-settings.effort-default-set-by-cli',
                            backendName || tab.backend,
                          )}
                        </span>
                      )
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
              <Select
                inline
                size="sm"
                inlineMaxHeight={300}
                aria-label={t('ui.chat-settings.official-accounts')}
                data-testid="account-picker"
                value={tab.accountId ?? ''}
                options={[
                  {
                    value: '',
                    label: t('ui.models.follow-the-default-account'),
                    description: defaultAccount?.label ?? t('ui.models.this-computer-s-sign-in'),
                    testId: 'account-default',
                  },
                  ...accounts.map((a) => ({
                    value: a.id,
                    label: a.label,
                    description: a.loggedIn
                      ? (a.identity?.plan ?? '')
                      : t('ui.models.not-signed-in'),
                    disabled: !a.loggedIn,
                    hint: a.identity?.email,
                    testId: `account-${a.id}`,
                  })),
                ]}
                onChange={(e) => {
                  picked.current = true;
                  pickAccount(e.target.value || null);
                }}
                onOpenChange={onPickerOpenChange}
              />
            </>
          ) : (
            <>
              {!provider && (
                <div className={styles.modelHead}>
                  <button
                    type="button"
                    className={styles.back}
                    data-testid="model-back"
                    onClick={() => setView('effort')}
                  >
                    <Icon icon={ChevronLeft} size={14} />
                    {t('ui.foundation.model')}
                  </button>
                  {/* 没有供应商标签时刷新放在返回这一行，不单独占一行 */}
                  {!officialTabs && refreshButton}
                </div>
              )}
              <ModelPicker
                inline
                browse
                purpose="coding"
                size="sm"
                inlineMaxHeight={pickerMax}
                defaultQuery={query}
                providers={pickerList}
                value={pickerValue}
                extraOptions={extraOptions}
                tailOptions={tailOptions}
                notice={pickerNotice}
                headerEnd={provider || officialTabs ? refreshButton : undefined}
                optionTestId={optionTestId}
                focusProvider={
                  thirdParty ? (providerOfRef(catalog.defaultModel?.id) ?? undefined) : OWN_TAB
                }
                onChange={onPick}
                onOpenChange={onPickerOpenChange}
                aria-label={t('ui.foundation.model')}
                data-testid="model-picker"
              />
              {long && (
                <div
                  className={styles.contextBar}
                  title={t('ui.models.switching-restarts-this-tab-s-assistant')}
                  data-testid="long-context-group"
                >
                  <div className={styles.contextBarRow}>
                    <span className={styles.contextBarLabel}>{t('ui.models.context-window')}</span>
                    <div
                      className={styles.segment}
                      role="radiogroup"
                      aria-label={t('ui.models.context-window')}
                    >
                      {[
                        { on: false, label: t('ui.models.standard-context'), size: long.standard },
                        { on: true, label: t('ui.models.long-context'), size: long.full },
                      ].map((o) => (
                        <button
                          key={String(o.on)}
                          type="button"
                          role="radio"
                          aria-checked={long.on === o.on}
                          className={styles.segmentItem}
                          data-testid={o.on ? 'long-context-long' : 'long-context-standard'}
                          onClick={() => pickLong(o.on)}
                        >
                          {o.label}
                          <span className={styles.segmentSize}>{formatContext(o.size)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <span className={styles.contextBarNote}>
                    {long.priceNote ?? t('ui.models.long-context-costs-more')}
                  </span>
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
  // 聊过的会话：原来的供应商与默认供应商不同时两家都列（全部模型）
  const groups = useMemo(
    () => (source === 'thirdParty' ? sessionModelGroups(tab, tab.backend, gateway) : null),
    [source, tab, gateway],
  );
  const sourceSwitch = useMemo(() => defaultSourceSwitch(tab, gateway), [tab, gateway]);
  // 官方来源：网关里的供应商也按标签列出来，可以直接换过去（与 Nomi 的模型选择器同形）
  const switchProviders = useMemo(
    () =>
      source !== 'thirdParty' && isCliKind(tab.backend) && gateway?.clients[tab.backend]
        ? codingProviders(gateway)
        : null,
    [source, tab.backend, gateway],
  );
  // 网关模型的能力与上下文窗口（与 Nomi 的模型选择器同一份数据）
  const modelMeta = useMemo(() => {
    const out = new Map<string, PickerModel>();
    for (const p of pickerProviders(gateway?.providers ?? []))
      for (const m of p.models) out.set(`${p.id}/${m.id}`, m);
    return out;
  }, [gateway]);
  const defaultProviderId = isCliKind(tab.backend)
    ? providerOfRef(gateway?.clients[tab.backend]?.models.main)
    : null;
  // 第三方：列所有供应商的模型，按供应商分标签；组（原来的 / 默认供应商）的说明放到标签上
  const providerTabs = useMemo(() => {
    if (!catalog || !thirdRef) return null;
    const has = new Set(catalog.models.map((m) => providerOfRef(m.id)));
    const label = new Map(groups?.map((g) => [g.id, g.label]));
    return codingProviders(gateway)
      .filter((p) => has.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, hint: label.get(p.id) }));
  }, [catalog, thirdRef, groups, gateway]);
  // 第三方目录来自网关：生图模型不能给编程助手用，不列
  const chatCatalog = useMemo(
    () =>
      catalog && thirdRef
        ? { ...catalog, models: catalog.models.filter((m) => !isImageModel(m.id)) }
        : catalog,
    [catalog, thirdRef],
  );
  const scoped = useMemo(
    () =>
      chatCatalog && thirdRef
        ? providerTabs && providerTabs.length > 1
          ? scopeCatalogToProviders(
              chatCatalog,
              providerTabs.map((p) => p.id),
              gateway,
            )
          : scopeCatalogToProvider(chatCatalog, thirdRef, gateway)
        : chatCatalog,
    [chatCatalog, thirdRef, providerTabs, gateway],
  );
  if (scoped === null) return null;
  if (scoped === undefined) return <LoadingChip tab={tab} />;
  return (
    <ModelChip
      tab={tab}
      catalog={scoped}
      refreshing={refreshing}
      onRefresh={refresh}
      long={longContextFor(tab, gateway)}
      sessionRef={groups ? thirdRef : null}
      groups={groups}
      sourceSwitch={sourceSwitch}
      providerTabs={providerTabs}
      switchProviders={switchProviders}
      defaultProviderId={defaultProviderId}
      modelMeta={modelMeta}
    />
  );
};
