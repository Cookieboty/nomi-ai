/**
 * 编程助手标签的「模型 · 思考深度」数据适配器：原来 ModelChip 里的读取与写回原样搬到这里，
 * 界面由共用外壳（ModelEffortChip）画。
 *
 * 标签来源是第三方（docs/development/gateway.md）时，同一个按钮列**所有第三方供应商**的模型
 * （主进程 ai:harness:model-catalog 带 source: 'thirdParty'，id 是 `供应商/模型`）：顶部按供应商分标签、
 * 左侧按厂商快速筛选，第三方之间换供应商原地续接。思考深度与 Nomi 对话完全同一套
 * （services/thinkingDepth：网关按模型能力给档位、不给选「不思考」、没选过落在第二档），
 * 选的档位登记在网关的标签绑定上，由网关写进这个 CLI 发出的请求。
 * 「默认模型」= 这个 CLI 在「模型」页分配的模型（属于当前供应商时）。
 */
import { BUILTIN_CLI_ORDER, cliCapability } from '@nomi-ai/cli-catalog';
import {
  formatContext,
  IconButton,
  Icon,
  modelBrandOf,
  t,
  type ModelProviderTab,
  type PickerModel,
  type PickerProvider,
  type SelectOption,
} from '@nomi-ai/ui';
import { RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  cliAccountClient,
  type AccountKind,
  type CliAccount,
} from '../../services/cliAccountClient';
import {
  providerOfRef,
  switchTabSource,
  tabSourceOf,
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
import type { LongContextInfo } from '../../services/longContext';
import { providerBrand, useGatewayState } from '../../services/nomiModel';
import { resolveThinkingLevel, thinkingProfileOf } from '../../services/thinkingDepth';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import { effortLabel, thinkingLevelLabel } from './effortLabel';
import menuStyles from './index.module.css';
import type { EffortPageSource, ModelEffortSource, ModelPageSource } from './ModelEffortChip';

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
export function validCatalog(c: unknown): BackendModelCatalog | null {
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
export function useCatalog(backend: string, source: TabSource) {
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

export interface CliChipInput {
  tab: HarnessTabMeta;
  catalog: BackendModelCatalog;
  refreshing: boolean;
  onRefresh: () => void;
  /** 浮层是否打开（账号列表只在打开时读） */
  open: boolean;
  long?: LongContextInfo | null;
  sessionRef?: string | null;
  groups?: SessionModelGroup[] | null;
  sourceSwitch?: SourceSwitch | null;
  providerTabs?: ModelProviderTab[] | null;
  switchProviders?: CodingProvider[] | null;
  defaultProviderId?: string | null;
  modelMeta?: ReadonlyMap<string, PickerModel> | null;
}

/** 编程助手标签的数据适配器：读 tab / 目录 / 网关，写 harnessClient */
export function useCliModelEffortSource({
  tab,
  catalog,
  refreshing,
  onRefresh,
  open,
  long = null,
  sessionRef = null,
  groups = null,
  sourceSwitch = null,
  providerTabs: thirdPartyTabs = null,
  switchProviders = null,
  defaultProviderId = null,
  modelMeta = null,
}: CliChipInput): ModelEffortSource {
  const [accounts, setAccounts] = useState<CliAccount[]>([]);
  const [note, setNote] = useState<string | null>(null);

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
  const thirdParty = tabSourceOf(tab) === 'thirdParty';
  const gateway = useGatewayState();
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
  // 第三方来源：档位来自网关的模型能力（与 Nomi 对话同一个 thinkingProfileOf），不看 CLI 自己的目录
  const thirdPartyRef = thirdParty ? (current ?? catalog.defaultModel?.id ?? null) : null;
  const thirdPartyProfile = useMemo(
    () => (thirdPartyRef ? thinkingProfileOf(gateway, thirdPartyRef) : null),
    [gateway, thirdPartyRef],
  );
  // Gemini / dsh：没有文档化的思考深度控制，整后端禁用；其余看 CLI 是否声明该模型支持
  // （第三方来源不经 CLI 的参数，由网关写进请求，后端本身有没有档位参数无关）
  const backendBlocksEffort = !thirdParty && NO_REASONING_BACKENDS.has(tab.backend);
  const noReasoning = thirdParty
    ? !thirdPartyProfile
    : backendBlocksEffort || (!!info && !info.reasoning);
  // 官方：档位全部来自 CLI：模型自己的 > 目录并集（自定义的未知模型 / 默认模型未知）
  const levels: ReasoningEffort[] = noReasoning
    ? []
    : thirdParty
      ? (thirdPartyProfile!.levels as ReasoningEffort[])
      : info?.efforts.length
        ? info.efforts
        : catalogEfforts(catalog);
  const reasoningSupported = levels.length > 0;
  const storedEffort = (tab.reasoningEffort ?? null) as ReasoningEffort | null;
  const effort = reasoningSupported
    ? thirdParty
      ? storedEffort && levels.includes(storedEffort)
        ? storedEffort
        : null
      : storedEffort
    : null;
  // null 表示沿用默认，界面仍应把默认档位显示在对应位置（第三方：模型的第二档，和 Nomi 对话一样，
  // 也是网关实际发出的那一档）。
  const defaultEffort = thirdParty
    ? ((resolveThinkingLevel(undefined, thirdPartyProfile) ?? null) as ReasoningEffort | null)
    : reasoningSupported && info?.defaultEffort && levels.includes(info.defaultEffort)
      ? info.defaultEffort
      : null;

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
  const shortLabel = chipEffort
    ? `${modelLabel} · ${thirdParty ? thinkingLevelLabel(chipEffort) : effortLabel(chipEffort)}`
    : modelLabel;
  // 按钮上的图标：认得出模型厂商或供应商品牌就用它的图标，否则通用芯片图标
  const chipModelId = current ?? catalog.defaultModel?.id ?? null;
  const chipBrand = chipModelId
    ? modelBrandOf(chipModelId, providerBrand(gateway, providerOfRef(chipModelId)))
    : undefined;
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
        defaultAccount?.label ?? t('ui.models.no-official-account-yet'),
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

  /**
   * 切到默认来源（主进程 setTabSource）：官方 → 第三方在原会话上续接；第三方 → 官方时第三方的推理内容
   * 不能发给官方接口，CLI 换一个会话、带上现在的对话作前文（标签和对话都不变，已有对话时先确认）
   */
  const pickSource = (item: SourceSwitch['items'][number]) => {
    if (!sourceSwitch) return;
    void run(() =>
      switchTabSource(tab, sourceSwitch.target, {
        model: item.model,
        hasMessages: !!tab.cliSessionId || (tab.carriedMessages ?? 0) > 0,
      }),
    );
  };

  const pickAccount = (id: string | null) => {
    if ((tab.accountId ?? null) === id) return;
    void run(() => harnessClient.setTabAccount(tab.id, id));
  };

  /** 官方来源停在网关供应商上选了模型 = 把标签切到第三方并用这个模型（原地续接，同「切到默认来源」） */
  const pickSwitchModel = (ref: string) => {
    void run(() =>
      switchTabSource(tab, 'thirdParty', {
        model: ref,
        hasMessages: !!tab.cliSessionId || (tab.carriedMessages ?? 0) > 0,
      }),
    );
  };

  /** 选完模型回到滑杆页，接着调档位（与 Codex 一致的「一次选完」） */
  const pickModel = (model: string) => {
    if (model === (current ?? '')) return;
    void run(() => harnessClient.setTabModel(tab.id, model, { expectSource: tabSourceOf(tab) }));
  };

  const pickEffort = (e: ReasoningEffort | null) => {
    // 点击 CLI 默认所在的档位不应把“沿用默认”变成显式覆盖。
    if (e === effort || (effort === null && e === defaultEffort)) return;
    void run(() => harnessClient.setTabEffort(tab.id, e));
  };

  /** 开 / 关长上下文；与模型默认相同时存 null（跟随默认），免得模型默认改了这里还钉着旧值 */
  const pickLong = (on: boolean) => {
    if (!long || on === long.on) return;
    void run(() => harnessClient.setTabLongContext(tab.id, on === long.modelDefault ? null : on));
  };

  /** 第三方模型选完：能调思考深度就回到档位页接着调（与 Nomi 对话的「一次选完」一致），否则收起浮层 */
  const afterThirdPartyPick = (ref: string | null): 'effort' | 'close' =>
    ref && thinkingProfileOf(gateway, ref) ? 'effort' : 'close';

  const onPick = (v: string): 'effort' | 'close' => {
    if (thirdParty) {
      if (v === '') {
        pickModel('');
        return afterThirdPartyPick(catalog.defaultModel?.id ?? null);
      }
      if (v === CUSTOM) {
        pickModel(current ?? '');
        return afterThirdPartyPick(current);
      }
      if (v.startsWith(SWITCH)) {
        const item = switchItems[Number(v.slice(SWITCH.length))];
        if (item) pickSource(item);
        return 'close';
      }
      const id = toCatalog.get(v);
      if (id === undefined) return 'close';
      pickModel(id);
      return afterThirdPartyPick(id);
    }
    if (v === '') pickModel('');
    else if (v === CUSTOM) pickModel(current ?? '');
    else if (v.startsWith(SWITCH)) {
      const item = switchItems[Number(v.slice(SWITCH.length))];
      if (item) pickSource(item);
      return 'close';
    } else {
      const id = toCatalog.get(v);
      if (id === undefined) return provider ? 'close' : 'effort';
      if (officialTabs && !v.startsWith(`${OWN_TAB}/`)) {
        pickSwitchModel(id);
        return 'close';
      }
      pickModel(id);
    }
    // 第三方来源（直接列模型、没有档位页）：选完收起浮层
    return provider ? 'close' : 'effort';
  };

  const refreshButton = (
    <IconButton
      size="sm"
      data-testid="model-refresh"
      disabled={refreshing}
      label={t('ui.chat-settings.reload-the-model-list-from', sourceName)}
      onClick={onRefresh}
      icon={
        <span className={refreshing ? menuStyles.spin : undefined}>
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

  const hasProvider = !!provider;

  const effortPage: EffortPageSource = {
    supported: reasoningSupported,
    levels,
    value: chipEffort,
    explicit: !!effort,
    defaultUnknownNote:
      !thirdParty && !effort && !defaultEffort
        ? t('ui.chat-settings.effort-default-set-by-cli', backendName || tab.backend)
        : null,
    unavailableHint: backendBlocksEffort
      ? t(
          'ui.chat-settings.has-no-documented-reasoning-effort-control-nomi-will',
          backendName || tab.backend,
        )
      : t('ui.chat-settings.this-model-has-no-reasoning-effort'),
    onCommit: (e) => pickEffort(e as ReasoningEffort | null),
    onRestore: () => pickEffort(null),
  };

  /** 只有模型页（第三方模型不能调思考深度时）；否则和 Nomi 对话一样是「模型 · 思考深度」 */
  const modelOnly = provider && !(thirdParty && reasoningSupported) ? provider : null;

  const modelPage: ModelPageSource = {
    providers: pickerList,
    value: pickerValue,
    extraOptions,
    tailOptions,
    notice: pickerNotice,
    headerEnd: hasProvider || officialTabs ? refreshButton : undefined,
    backEnd: !officialTabs ? refreshButton : undefined,
    // 第三方模型能调思考深度时和 Nomi 对话一样有「‹ 模型」返回行（回到档位页）
    showBack: !hasProvider || (thirdParty && reasoningSupported),
    footer: long ? <LongContextRow long={long} onPick={pickLong} /> : null,
    focusProvider: thirdParty ? (providerOfRef(catalog.defaultModel?.id) ?? undefined) : OWN_TAB,
    purpose: 'coding',
    optionTestId,
    onPick,
    wide: thirdParty || !!officialTabs,
  };

  return {
    label: shortLabel,
    muted: !current && !chipEffort,
    brand: chipBrand,
    ariaLabel: modelOnly
      ? t('ui.chat-settings.model', modelOnly.name, shortLabel)
      : t('ui.chat-settings.model-and-reasoning-effort', shortLabel),
    menuLabel: modelOnly
      ? t('ui.foundation.model')
      : t('ui.chat-settings.model-and-reasoning-effort-label'),
    note,
    longBadge: !!long?.on,
    // 第三方：能调档位时和 Nomi 对话一样先停在档位页；不能调直接列模型
    initialView: modelOnly ? 'model' : 'effort',
    menuCommandView: 'model',
    menuKey: tab.id,
    effort: effortPage,
    model: modelPage,
    account: accountKind
      ? {
          title: t('ui.chat-settings.official-accounts'),
          rowLabel: t('ui.models.account'),
          rowValue: accountLabel,
          rowAriaLabel: t('ui.models.switch-official-account', accountLabel),
          value: tab.accountId ?? '',
          options: [
            {
              value: '',
              label: t('ui.models.follow-the-default-account'),
              description: defaultAccount?.label ?? t('ui.models.no-official-account-yet'),
              testId: 'account-default',
            },
            ...accounts.map((a) => ({
              value: a.id,
              label: a.label,
              description: a.loggedIn ? (a.identity?.plan ?? '') : t('ui.models.not-signed-in'),
              disabled: !a.loggedIn,
              hint: a.identity?.email,
              testId: `account-${a.id}`,
            })),
          ],
          onChange: pickAccount,
        }
      : null,
    modelLabel,
    modelRowAria: t('ui.chat-settings.switch-model', modelLabel),
  };
}

/** 长上下文一组（分档计价模型的「标准 / 长上下文」开关） */
const LongContextRow: React.FC<{
  long: LongContextInfo;
  onPick: (on: boolean) => void;
}> = ({ long, onPick }) => (
  <div
    className={menuStyles.contextBar}
    title={t('ui.models.switching-restarts-this-tab-s-assistant')}
    data-testid="long-context-group"
  >
    <div className={menuStyles.contextBarRow}>
      <span className={menuStyles.contextBarLabel}>{t('ui.models.context-window')}</span>
      <div
        className={menuStyles.segment}
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
            className={menuStyles.segmentItem}
            data-testid={o.on ? 'long-context-long' : 'long-context-standard'}
            onClick={() => onPick(o.on)}
          >
            {o.label}
            <span className={menuStyles.segmentSize}>{formatContext(o.size)}</span>
          </button>
        ))}
      </div>
    </div>
    <span className={menuStyles.contextBarNote}>
      {long.priceNote ?? t('ui.models.long-context-costs-more')}
    </span>
  </div>
);
