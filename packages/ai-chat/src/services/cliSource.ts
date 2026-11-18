import {
  BUILTIN_CLI_ORDER,
  BUILTIN_MANIFESTS,
  cliName,
  isBuiltinCliId,
} from '@nomi-ai/cli-catalog';
/**
 * CLI 标签的来源（docs/development/gateway.md）：Nomi 管理的官方账号 / 第三方（经网关）。
 * 有官方账号能力的 CLI 可沿用本机登录或使用 Nomi 管理的账号；dsh、Gemini 保持第三方来源。
 * 侧栏信息卡的「新标签默认」（CliDefaultSource）、模型按钮和斜杠命令 /model、/status 共用这里的数据与切换逻辑。
 */
import { t, type SelectOption } from '@nomi-ai/ui';

import { confirmDialog } from '../components/ConfirmDialog';
import { hasOfficialAccount, thirdPartyOnly } from '../utils/cliCaps';

import { accountDisplayLabel, accountSubtitle, type CliAccount } from './cliAccountClient';
import { launcherManagesLogin, supportsCustomLauncher } from './cliLauncherClient';
import type { ClientId, GatewayState } from './gatewayClient';
import {
  harnessClient,
  type BackendModelCatalog,
  type HarnessTabMeta,
  type TabSource,
} from './harnessClient';
import { pickerProviders, splitRef } from './nomiModel';
import { providerDisplayName } from './providerClient';

export type CliKind = Exclude<ClientId, 'nomi'>;

export const CLI_KINDS: readonly CliKind[] = BUILTIN_CLI_ORDER;

export const isCliKind = (b: string): b is CliKind => (CLI_KINDS as readonly string[]).includes(b);

export const tabSourceOf = (tab: Pick<HarnessTabMeta, 'source'> | null | undefined): TabSource =>
  tab?.source === 'thirdParty' ? 'thirdParty' : tab?.source === 'local' ? 'local' : 'official';

export interface CodingModelChoice {
  /** `供应商/模型` */
  ref: string;
  /** 「供应商 / 模型」 */
  label: string;
  provider: string;
  /** 供应商 id（`供应商/模型` 的前半段） */
  providerId: string;
  model: string;
}

/** 网关里能给 agent 用的模型（启用的供应商里启用的、不是明确不支持工具调用的） */
export function codingModelChoices(s: GatewayState | null): CodingModelChoice[] {
  if (!s) return [];
  return pickerProviders(s.providers).flatMap((p) =>
    p.models
      .filter((m) => m.toolCalling !== false)
      .map((m) => ({
        ref: `${p.id}/${m.id}`,
        label: `${p.name} / ${m.label ?? m.id}`,
        provider: p.name,
        providerId: p.id,
        model: m.id,
      })),
  );
}

/** 网关里能给 agent 用的第三方供应商（按供应商归组的 codingModelChoices） */
export interface CodingProvider {
  id: string;
  name: string;
  models: CodingModelChoice[];
}

export function codingProviders(s: GatewayState | null): CodingProvider[] {
  const out = new Map<string, CodingProvider>();
  for (const m of codingModelChoices(s)) {
    const p = out.get(m.providerId);
    if (p) p.models.push(m);
    else
      out.set(m.providerId, {
        id: m.providerId,
        name: providerDisplayName(m.provider),
        models: [m],
      });
  }
  return [...out.values()];
}

/** 网关里恰好只有一家可用的第三方供应商时返回它，否则返回 null */
export function singleCodingProvider(s: GatewayState | null): CodingProvider | null {
  const providers = codingProviders(s);
  return providers.length === 1 ? (providers[0] ?? null) : null;
}

/** `供应商/模型` 的供应商 id */
export const providerOfRef = (ref: string | null | undefined): string | null =>
  (ref && splitRef(ref)?.provider) || null;

/** 供应商 id → 显示名；不在网关里时原样返回 id */
export function providerLabel(s: GatewayState | null, id: string): string {
  const p = s?.providers.find((x) => x.id === id);
  return p ? providerDisplayName(p.name) : id;
}

/**
 * 换到某个第三方供应商时用哪个模型：当前就在这个供应商下的模型 > 这个 agent 在「模型」页分配的模型
 * （属于这个供应商时）> 这个供应商的第一个模型。之后在模型按钮里随时换。
 */
export function providerEntryRef(
  s: GatewayState | null,
  providerId: string,
  kind: CliKind,
  current?: string | null,
): string | null {
  if (providerOfRef(current) === providerId) return current!;
  const main = s?.clients[kind]?.models.main;
  if (providerOfRef(main) === providerId) return main!;
  return codingProviders(s).find((p) => p.id === providerId)?.models[0]?.ref ?? null;
}

/**
 * 第三方标签只有一个供应商时，模型目录只列它的模型（多个供应商时模型按钮按供应商分标签）：
 * 去掉模型名里的「供应商 / 」前缀，供应商名放到目录的 provider 上。
 */
export function scopeCatalogToProvider(
  catalog: BackendModelCatalog,
  ref: string | null,
  s: GatewayState | null,
): BackendModelCatalog {
  const pid = providerOfRef(ref);
  return pid ? scopeCatalogToProviders(catalog, [pid], s) : catalog;
}

/** 同上，列几个供应商的模型（按 pids 的顺序）；目录的 provider 是第一个 */
export function scopeCatalogToProviders(
  catalog: BackendModelCatalog,
  pids: readonly string[],
  s: GatewayState | null,
): BackendModelCatalog {
  if (!pids.length) return catalog;
  const owner = (id: string) => pids.find((p) => id.startsWith(`${p}/`));
  type Model = BackendModelCatalog['models'][number];
  const strip = (m: Model): Model => {
    const cut = m.label?.indexOf(' / ') ?? -1;
    return cut >= 0 ? { ...m, label: m.label!.slice(cut + 3) } : m;
  };
  const def = catalog.defaultModel;
  return {
    ...catalog,
    models: pids.flatMap((p) => catalog.models.filter((m) => owner(m.id) === p).map(strip)),
    defaultModel: def && owner(def.id) ? strip(def) : null,
    provider: { id: catalog.provider?.id ?? 'gateway', name: providerLabel(s, pids[0]!) },
  };
}

/** 会话上次用的第三方模型（主进程记的 lastServedRef），已不在网关里时为 null */
export function sessionRefOf(
  tab: Pick<HarnessTabMeta, 'lastServedRef'> | null | undefined,
  s: GatewayState | null,
): string | null {
  const last = tab?.lastServedRef;
  return last && codingModelChoices(s).some((m) => m.ref === last) ? last : null;
}

export interface SessionModelGroup {
  /** 供应商 id */
  id: string;
  /** 供应商显示名 */
  name: string;
  /** 分组标题：「本会话原来的供应商 · A」/「默认供应商 · B」 */
  label: string;
}

/**
 * 聊过的第三方会话在模型按钮里列哪几个供应商：会话原来的供应商（上次用的模型所在）、
 * 当前选中的模型所在的供应商、这个 agent 在「模型」页的默认供应商，去重后按这个顺序。
 * 会话还没聊过（没有 lastServedRef）返回 null。模型按钮用它给供应商标签加说明。
 * 换到默认供应商并聊过一轮后，原来的供应商就是默认供应商，只剩一组。
 */
export function sessionModelGroups(
  tab: Pick<HarnessTabMeta, 'modelOverride' | 'lastServedRef'>,
  kind: string,
  s: GatewayState | null,
): SessionModelGroup[] | null {
  const session = providerOfRef(sessionRefOf(tab, s));
  if (!session) return null;
  const current = providerOfRef(thirdPartyRefOf(tab, kind, s));
  const main = isCliKind(kind) ? s?.clients[kind]?.models.main : null;
  const def = codingModelChoices(s).some((m) => m.ref === main) ? providerOfRef(main) : null;
  const ids = [...new Set([session, current, def].filter((x): x is string => !!x))];
  return ids.map((id) => {
    const name = providerLabel(s, id);
    return {
      id,
      name,
      label:
        id === session
          ? t('ui.models.this-chat-s-provider', name)
          : id === def
            ? t('ui.models.default-provider-named', name)
            : name,
    };
  });
}

/** 模型按钮里「切到默认来源」的一组（标签来源与「新标签默认用」不同时） */
export interface SourceSwitch {
  target: TabSource;
  /** 分组标题：「默认 · 官方账号」/「默认供应商 · B」 */
  title: string;
  /** 官方：一项（切到官方账号）；第三方：默认供应商的全部模型（model = `供应商/模型`） */
  items: Array<{ id: string; label: string; model?: string }>;
}

/**
 * 标签的来源（官方 / 第三方）与这个 agent 的「新标签默认用」不同时，模型按钮里多一组，
 * 一步切到默认来源：默认是官方 → 「切换到官方账号」；默认是第三方 → 默认供应商的全部模型。
 * 来源相同（或网关状态还没到、且目标来源不可用）返回 null。
 */
export function defaultSourceSwitch(
  tab: Pick<HarnessTabMeta, 'backend' | 'source'>,
  s: GatewayState | null,
  accountSource?: 'local' | 'nomi',
  availability?: { local?: boolean; official?: boolean },
): SourceSwitch | null {
  const kind = tab.backend;
  if (!isCliKind(kind)) return null;
  const client = s?.clients[kind];
  if (!client) return null;
  const main = client.models.main ?? singleCodingProvider(s)?.models[0]?.ref ?? null;
  const choices = codingModelChoices(s);
  const hasMain = choices.some((m) => m.ref === main);
  const preferLocal =
    hasOfficialAccount(kind) &&
    (client.newTabSource === 'local' ||
      (!client.newTabSource &&
        (accountSource !== undefined
          ? supportsCustomLauncher(kind) && accountSource === 'local'
          : launcherManagesLogin(kind))));
  const noLocalAndNoOfficial =
    availability?.local === false && availability?.official === false && choices.length > 0;
  // 只能用第三方模型的（dsh、Gemini），或者既无本机也无官方账号时：回退第三方
  let target: TabSource =
    thirdPartyOnly(kind) || (client.newTabSource === 'thirdParty' && hasMain)
      ? 'thirdParty'
      : preferLocal
        ? 'local'
        : 'official';
  if (noLocalAndNoOfficial && target !== 'thirdParty') {
    target = 'thirdParty';
  }
  if (target === tabSourceOf(tab)) return null;
  if (target === 'local' && availability?.local === false) return null;
  if (target === 'official' && availability?.official === false) return null;
  if (target === 'thirdParty' && !hasMain && !noLocalAndNoOfficial) return null;
  if (target === 'local') {
    return {
      target,
      title: t('ui.chat-settings.cli-launcher-local'),
      items: [{ id: 'local', label: t('ui.chat-settings.cli-launcher-local') }],
    };
  }
  if (target === 'official') {
    return {
      target,
      title: t('ui.models.default-official'),
      items: [{ id: 'official', label: t('ui.models.switch-to-official') }],
    };
  }
  const pid = providerOfRef(main) ?? choices[0]!.providerId;
  return {
    target,
    title: t('ui.models.default-provider-named', providerLabel(s, pid)),
    items: choices
      .filter((m) => m.providerId === pid)
      .map((m) => ({ id: m.ref, label: m.label.slice(m.provider.length + 3), model: m.ref })),
  };
}

/** `供应商/模型` →「供应商 / 模型」；供应商不在网关里时原样返回 */
export function refSlashLabel(s: GatewayState | null, ref: string): string {
  const r = splitRef(ref);
  const p = r ? s?.providers.find((x) => x.id === r.provider) : undefined;
  if (!r || !p) return ref;
  const m = p.models.find((x) => x.id === r.model);
  return `${providerDisplayName(p.name)} / ${m?.label ?? r.model}`;
}

/** 第三方标签实际用的模型：标签自己的选择 → 会话上次用的模型 → 这个 CLI 在「模型」页分配的默认模型（单供应商时默认取其首个模型） */
export function thirdPartyRefOf(
  tab: Pick<HarnessTabMeta, 'modelOverride' | 'lastServedRef'> | null | undefined,
  kind: string,
  s: GatewayState | null,
): string | null {
  const own = tab?.modelOverride?.trim();
  if (own) return own;
  // 与主进程 effectiveOverrides 同规则：聊过的会话留在上次用的模型上（还在网关里时）
  const last = sessionRefOf(tab, s);
  if (last) return last;
  const assigned = isCliKind(kind) ? (s?.clients[kind]?.models.main ?? null) : null;
  return assigned ?? singleCodingProvider(s)?.models[0]?.ref ?? null;
}

/* ------------------- 「新标签默认用」：官方账号 / 第三方 ------------------- */

/** 旧版本的「本机登录」哨兵（主进程 AccountService 的 local-<kind>）：现在按「跟随默认账号」处理 */
const isLegacyLocalAccount = (id: string | null | undefined) => !!id && id.startsWith('local-');

/** 下拉值：local=本机登录；follow=跟随默认账号；account:<id>=指定官方账号；provider:<id>=第三方供应商；''=还没选（只能用第三方的助手） */
const NEWTAB_NONE = '';
const NEWTAB_LOCAL = 'local';
const NEWTAB_FOLLOW = 'follow';
const ACCOUNT_PREFIX = 'account:';
const PROVIDER_PREFIX = 'provider:';

export interface NewTabCtx {
  kind: CliKind;
  client: GatewayState['clients'][CliKind] | undefined;
  gateway: GatewayState | null;
  accounts: CliAccount[];
  localAvailable?: boolean;
}

export interface NewTabAvailability {
  localAvailable?: boolean;
  accounts?: readonly CliAccount[];
  gateway?: GatewayState | null;
}

/** 「新标签默认用」当前应选中的下拉值 */
export function newTabSelectValue(
  client: NewTabCtx['client'],
  kind: CliKind,
  availability?: NewTabAvailability,
): string {
  const main = client?.models.main ?? null;
  if ((client?.newTabSource ?? 'official') === 'thirdParty' && main) {
    const p = providerOfRef(main);
    if (p) return `${PROVIDER_PREFIX}${p}`;
  }
  // 没有官方账号能力的（dsh、Gemini）只用第三方：只有一家可用供应商时直接默认选中它
  if (!hasOfficialAccount(kind)) {
    const p = providerOfRef(main) ?? singleCodingProvider(availability?.gateway ?? null)?.id;
    return p ? `${PROVIDER_PREFIX}${p}` : NEWTAB_NONE;
  }

  const providers = availability?.gateway ? codingProviders(availability.gateway) : [];
  const fallbackTp = () => {
    const p = providerOfRef(main) ?? providers[0]?.id;
    return p ? `${PROVIDER_PREFIX}${p}` : NEWTAB_NONE;
  };
  const hasLocal = availability ? Boolean(availability.localAvailable) : true;
  const loggedIn = availability?.accounts ? availability.accounts.filter((a) => a.loggedIn) : null;
  const hasOfficial = loggedIn ? loggedIn.length > 0 : true;

  if (client?.newTabSource === 'local' || (!client?.newTabSource && launcherManagesLogin(kind))) {
    if (!availability || hasLocal) return NEWTAB_LOCAL;
    if (hasOfficial) return NEWTAB_FOLLOW;
    return fallbackTp();
  }
  const accountId = client?.newTabAccountId ?? null;
  if (accountId && !isLegacyLocalAccount(accountId)) {
    if (
      !loggedIn ||
      loggedIn.some((a) => a.id === accountId) ||
      client?.newTabSource === 'official'
    ) {
      return `${ACCOUNT_PREFIX}${accountId}`;
    }
  }
  if (!availability || hasOfficial) return NEWTAB_FOLLOW;
  if (hasLocal) return NEWTAB_LOCAL;
  return fallbackTp();
}

/** 「新标签默认用」分组下拉的选项：仅展示实际已登录的本机/官方账号与可用的第三方供应商 */
export function newTabOptions({
  kind,
  client,
  gateway,
  accounts,
  localAvailable,
}: NewTabCtx): SelectOption[] {
  const options: SelectOption[] = [];
  const official = hasOfficialAccount(kind);
  const providers = codingProviders(gateway);
  const hasLocal = Boolean(localAvailable);
  const loggedInAccounts = accounts.filter((a) => a.loggedIn);
  const hasOfficial = loggedInAccounts.length > 0;
  const currentSelect = newTabSelectValue(client, kind, { localAvailable, accounts, gateway });

  if (official) {
    if (hasLocal || currentSelect === NEWTAB_LOCAL) {
      options.push({
        value: NEWTAB_LOCAL,
        group: t('ui.chat-settings.official-accounts'),
        label: t('ui.chat-settings.cli-launcher-local'),
        description: hasLocal
          ? t('ui.models.local-sign-in-detected')
          : t('ui.chat-settings.cli-launcher-managed-hint', cliName(kind)),
      });
    }
    if (hasOfficial) {
      const def = loggedInAccounts.find((a) => a.active) ?? loggedInAccounts[0];
      options.push({
        value: NEWTAB_FOLLOW,
        group: t('ui.chat-settings.official-accounts'),
        label: t('ui.models.follow-the-default-account'),
        description: def ? accountDisplayLabel(def) : undefined,
      });
      for (const a of loggedInAccounts) {
        options.push({
          value: `${ACCOUNT_PREFIX}${a.id}`,
          group: t('ui.chat-settings.official-accounts'),
          label: accountDisplayLabel(a),
          description: accountSubtitle(a) || undefined,
        });
      }
    }
    // 已显式指定的账号后来被删掉或未登录：仅在当前仍绑定它时补一个禁用项，避免下拉显示空白
    const accountId = client?.newTabAccountId ?? null;
    if (
      accountId &&
      !isLegacyLocalAccount(accountId) &&
      client?.newTabSource === 'official' &&
      !loggedInAccounts.some((a) => a.id === accountId)
    ) {
      const existing = accounts.find((a) => a.id === accountId);
      options.push({
        value: `${ACCOUNT_PREFIX}${accountId}`,
        group: t('ui.chat-settings.official-accounts'),
        label: existing ? accountDisplayLabel(existing) : accountId,
        disabled: true,
        description: existing ? t('ui.models.not-signed-in') : t('ui.models.removed-account'),
      });
    }
  } else if (currentSelect === NEWTAB_NONE) {
    options.push({
      value: NEWTAB_NONE,
      label: t('ui.models.pick-a-third-party-provider'),
      description: t('ui.models.only-third-party-models', cliName(kind)),
      disabled: true,
    });
  }

  const present = new Set<string>();
  for (const p of providers) {
    present.add(p.id);
    const ref = providerEntryRef(gateway, p.id, kind, client?.models.main);
    const modelShort = ref ? (splitRef(ref)?.model ?? ref) : undefined;
    options.push({
      value: `${PROVIDER_PREFIX}${p.id}`,
      group: t('ui.cli-monitor.third-party'),
      label: p.name,
      ...(modelShort ? { description: modelShort } : {}),
    });
  }
  // 已分配第三方模型、但供应商不在当前列表（停用 / 删除）时补一项
  const main = client?.models.main ?? null;
  const currentProvider = providerOfRef(main);
  if (
    ((client?.newTabSource ?? 'official') === 'thirdParty' || !official) &&
    currentProvider &&
    !present.has(currentProvider)
  ) {
    options.push({
      value: `${PROVIDER_PREFIX}${currentProvider}`,
      group: t('ui.cli-monitor.third-party'),
      label: providerLabel(gateway, currentProvider),
      disabled: true,
      description: t('ui.models.provider-unavailable'),
    });
  }

  if (options.length === 0) {
    options.push({
      value: NEWTAB_NONE,
      label: t('ui.models.pick-a-third-party-provider'),
      disabled: true,
    });
  }

  return options;
}

export interface NewTabPatch {
  newTabSource: 'local' | 'official' | 'thirdParty';
  newTabAccountId?: string | null;
  /** 第三方来源必须带上同一供应商的主模型；切回官方/本机时保留已配好的第三方模型不清空。 */
  models?: { main: string | null };
}

/** 下拉值 → setAssignment 的 patch；无法应用（如供应商已无可用模型、还没选）时返回 null */
export function newTabPatch(
  value: string,
  { kind, client, gateway }: NewTabCtx,
): NewTabPatch | null {
  const main = client?.models.main ?? null;
  if (value === NEWTAB_FOLLOW && hasOfficialAccount(kind)) {
    return {
      newTabSource: 'official',
      newTabAccountId: null,
    };
  }
  if (value.startsWith(ACCOUNT_PREFIX) && hasOfficialAccount(kind)) {
    return {
      newTabSource: 'official',
      newTabAccountId: value.slice(ACCOUNT_PREFIX.length),
    };
  }
  if (value === 'local' && hasOfficialAccount(kind)) {
    return {
      newTabSource: 'local',
      newTabAccountId: null,
    };
  }
  if (value.startsWith(PROVIDER_PREFIX)) {
    const providerId = value.slice(PROVIDER_PREFIX.length);
    const ref = providerEntryRef(gateway, providerId, kind, main);
    if (!ref) return null;
    return {
      newTabSource: 'thirdParty',
      newTabAccountId: null,
      ...(ref !== main ? { models: { main: ref } } : {}),
    };
  }
  return null;
}

export const THIRD_PARTY_TO_OFFICIAL = () => t('ui.models.third-party-reasoning-can-t-be-sent-to');

/**
 * 切换标签来源。涉及跨源且标签里已有对话（除官方切第三方外，切回官方/本机或从本机切出）时先确认（主进程会带上下文新开会话）。
 * 返回 null = 用户取消。
 */
export async function switchTabSource(
  tab: Pick<HarnessTabMeta, 'id' | 'source'>,
  source: TabSource,
  opts: { model?: string; accountId?: string | null; hasMessages: boolean },
): Promise<HarnessTabMeta | null> {
  const cur = tabSourceOf(tab);
  const crossNeedsCarry =
    cur !== source && (source === 'official' || source === 'local' || cur === 'local');
  if (
    crossNeedsCarry &&
    opts.hasMessages &&
    !(await confirmDialog({ message: THIRD_PARTY_TO_OFFICIAL() }))
  )
    return null;
  return opts.accountId !== undefined
    ? harnessClient.setTabSource(tab.id, source, opts.model, opts.accountId)
    : harnessClient.setTabSource(tab.id, source, opts.model);
}

const NON_CODING_MODEL_PARTS = [
  'embed',
  'rerank',
  'tts',
  'whisper',
  'audio',
  'realtime',
  'moderation',
  'safeguard',
  'ocr',
  'lyria',
  'voxtral',
  'pixtral',
  'image',
  'dall-e',
  'flux',
  'live-translate',
  'live-preview',
];

function bareLower(raw: string): string {
  const cut = raw.lastIndexOf('/');
  const bare = (cut >= 0 ? raw.slice(cut + 1) : raw).trim().toLowerCase();
  return bare.replace(/:[\w.-]+$/, '');
}

const VENDOR_MATCHERS: ReadonlyArray<{ vendor: string; match: (bare: string) => boolean }> = [
  {
    vendor: 'anthropic',
    match: (b) =>
      b.startsWith('claude') || b === 'opus' || b === 'sonnet' || b === 'haiku' || b === 'fable',
  },
  {
    vendor: 'openai',
    match: (b) =>
      b.startsWith('gpt-') ||
      b.startsWith('chatgpt-') ||
      b.startsWith('o1') ||
      b.startsWith('o3') ||
      b.startsWith('o4') ||
      (b.startsWith('codex') && !b.startsWith('codestral')),
  },
  { vendor: 'google', match: (b) => b.startsWith('gemini') },
  { vendor: 'xai', match: (b) => b.startsWith('grok') },
  {
    vendor: 'deepseek',
    match: (b) =>
      b.startsWith('deepseek') || b.startsWith('ds-') || b.startsWith('ds4') || b.startsWith('ds3'),
  },
  { vendor: 'moonshot', match: (b) => b.startsWith('kimi') || b.startsWith('moonshot') },
  { vendor: 'minimax', match: (b) => b.startsWith('minimax') || b.startsWith('abab') },
];

const VENDOR_TIER_SCORERS: Record<string, (bare: string) => number> = {
  anthropic: (b) => {
    if (b.includes('fable')) return 4;
    if (b.includes('opus')) return 3;
    if (b.includes('sonnet')) return 2;
    if (b.includes('haiku')) return 1;
    return 2;
  },
  openai: (b) => {
    if (
      b.endsWith('-pro') ||
      b.includes('-pro-') ||
      b.includes('astra') ||
      b.includes('daybreak-red')
    )
      return 4;
    if (
      (b.includes('-mini') && !b.includes('mini-high')) ||
      b.includes('-nano') ||
      b.includes('luna') ||
      b.startsWith('gpt-3.5') ||
      b.startsWith('gpt-oss')
    )
      return 1;
    if (
      (b.includes('-sol') && !b.includes('-pro')) ||
      b.includes('codex-max') ||
      b.includes('daybreak-blue') ||
      b === 'o1' ||
      b.startsWith('gpt-5.5') ||
      b.startsWith('gpt-5-5') ||
      b === 'gpt-5.6' ||
      b === 'gpt-5-6'
    )
      return 3;
    return 2;
  },
  google: (b) => {
    if (b.includes('deep-research-max')) return 4;
    if (
      b.includes('pro') ||
      b.includes('argon') ||
      b.includes('carbon') ||
      b.includes('deep-research')
    )
      return 3;
    if (b.includes('flash-lite') || b.includes('lite') || b.includes('2.5-flash')) return 1;
    return 2;
  },
  xai: (b) => {
    if (b.startsWith('grok-5') && (b.includes('pro') || b.includes('ultra') || b.includes('heavy')))
      return 4;
    if (b.includes('non-reasoning') || b.includes('mini') || b.includes('fast')) return 1;
    if (
      b.includes('multi-agent') ||
      b.startsWith('grok-4.7') ||
      b.startsWith('grok-4-7') ||
      b.startsWith('grok-5')
    )
      return 3;
    return 2;
  },
  deepseek: (b) => {
    if (b.includes('flash')) return 1;
    if (b.startsWith('deepseek-v4-pro') || b.startsWith('deepseek-r1') || b.includes('reasoner'))
      return 3;
    return 2;
  },
  moonshot: (b) => {
    if (b.includes('highspeed')) return 4;
    if (b.startsWith('kimi-k3') && b.includes('pro')) return 3;
    if (b === 'kimi-k2' || b.startsWith('kimi-k2-0')) return 1;
    return 2;
  },
  minimax: (b) => {
    if (b.includes('flash')) return 1;
    if (b === 'minimax-m3') return 3;
    return 2;
  },
};

function modelVendor(bare: string): string {
  return VENDOR_MATCHERS.find((v) => v.match(bare))?.vendor ?? '';
}

function modelVersionScore(bare: string): [number, number, number, number] {
  const isLatest = bare.endsWith('-latest') ? 1 : 0;
  let s = bare.replace(
    /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|(?:24|25|26)\d{2}|(?:0[1-9]|1[0-2])\d{2}|(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/g,
    '',
  );
  let penalty = s !== bare ? 1 : 0;
  for (const suf of ['-exp', '-preview', '-latest']) {
    if (s.endsWith(suf)) {
      if (suf !== '-latest') penalty += 1;
      s = s.slice(0, -suf.length);
    }
  }
  const cleaned = s.replace(/\b\d+(?:\.\d+)?[btk]\b/gi, ' ');
  let major = 0;
  let minor = 0;
  for (const m of cleaned.matchAll(/(?:^|[-vkm.])(\d{1,2})(?:[.-](\d{1,2}))?/gi)) {
    const maj = Number(m[1] ?? 0);
    if (maj > 20) continue;
    const minV = Number(m[2] ?? 0);
    if (maj > major || (maj === major && minV > minor)) {
      major = maj;
      minor = minV;
    }
  }
  return [major, minor, isLatest, penalty];
}

/** 选出最契合指定 CLI 原生生态的第三方次顶级模型（未分配 main 时优先同族次顶级，其次兼容首个模型）。 */
export function preferredThirdPartyModelForCli(
  s: GatewayState | null,
  kind: CliKind,
): string | null {
  const choices = codingModelChoices(s);
  if (!choices.length) return null;
  const main = s?.clients[kind]?.models.main;
  if (main && choices.some((c) => c.ref === main)) return main;

  const targetVendor = isBuiltinCliId(kind) ? BUILTIN_MANIFESTS[kind].host?.vendor : undefined;
  const scorer = targetVendor ? VENDOR_TIER_SCORERS[targetVendor] : undefined;
  if (targetVendor && scorer) {
    const vendorModels = choices
      .map((c, idx) => {
        const bare = bareLower(c.model);
        return { ref: c.ref, bare, vendor: modelVendor(bare), idx };
      })
      .filter(
        (x) =>
          x.vendor === targetVendor &&
          x.bare !== 'default' &&
          !NON_CODING_MODEL_PARTS.some((part) => x.bare.includes(part)),
      )
      .map((x) => {
        const [major, minor, isLatest, penalty] = modelVersionScore(x.bare);
        return { ...x, tier: scorer(x.bare), major, minor, isLatest, penalty };
      });
    if (vendorModels.length > 0) {
      const sortQuality = (a: (typeof vendorModels)[number], b: (typeof vendorModels)[number]) =>
        b.major - a.major ||
        b.minor - a.minor ||
        a.isLatest - b.isLatest ||
        a.penalty - b.penalty ||
        a.idx - b.idx;
      const tiers = [4, 3, 2]
        .map((t) => vendorModels.filter((m) => m.tier === t).sort(sortQuality))
        .filter((arr) => arr.length > 0);
      if (tiers.length >= 2) return tiers[1]![0]!.ref;
      if (tiers.length === 1) {
        const arr = tiers[0]!;
        if (arr[0]!.tier <= 2 || arr.length === 1) return arr[0]!.ref;
        const diff = arr.find((m) => m.major !== arr[0]!.major || m.minor !== arr[0]!.minor);
        return (diff ?? arr[0]!).ref;
      }
      const light = vendorModels.filter((m) => m.tier === 1).sort(sortQuality);
      if (light.length > 0) return light[0]!.ref;
    }
  }
  return codingProviders(s)[0]?.models[0]?.ref ?? choices[0]?.ref ?? null;
}
