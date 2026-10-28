/**
 * CLI 标签的来源（docs/design/unified-gateway.md §4.3、§13）：本机默认 / 官方账号 / 第三方（经网关）。
 * 侧栏信息卡的「新标签默认」（CliDefaultSource）、模型按钮和斜杠命令 /model、/status 共用这里的数据与切换逻辑。
 */
import { t, type SelectOption } from '@nomi-ai/ui';

import { confirmDialog } from '../components/ConfirmDialog';
import { hasOfficialAccount } from '../utils/cliCaps';

import type { CliAccount } from './cliAccountClient';
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

export const CLI_KINDS: readonly CliKind[] = ['claude', 'codex', 'gemini', 'grok', 'dsh'];

export const isCliKind = (b: string): b is CliKind => (CLI_KINDS as readonly string[]).includes(b);

export const tabSourceOf = (tab: Pick<HarnessTabMeta, 'source'> | null | undefined): TabSource =>
  tab?.source === 'thirdParty' ? 'thirdParty' : 'official';

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

/** 网关里能给编程助手用的模型（启用的供应商里启用的、不是明确不支持工具调用的） */
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

/** 网关里能给编程助手用的第三方供应商（按供应商归组的 codingModelChoices） */
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

/** `供应商/模型` 的供应商 id */
export const providerOfRef = (ref: string | null | undefined): string | null =>
  (ref && splitRef(ref)?.provider) || null;

/** 供应商 id → 显示名；不在网关里时原样返回 id */
export function providerLabel(s: GatewayState | null, id: string): string {
  const p = s?.providers.find((x) => x.id === id);
  return p ? providerDisplayName(p.name) : id;
}

/**
 * 换到某个第三方供应商时用哪个模型：当前就在这个供应商下的模型 > 这个编程助手在「模型」页分配的模型
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
 * 第三方标签的模型目录只列当前供应商的模型（换供应商在输入框左下角，换模型在模型按钮）：
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
 * 当前选中的模型所在的供应商、这个编程助手在「模型」页的默认供应商，去重后按这个顺序。
 * 会话还没聊过（没有 lastServedRef）返回 null，按钮只列当前供应商。
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

/** `供应商/模型` →「供应商 / 模型」；供应商不在网关里时原样返回 */
export function refSlashLabel(s: GatewayState | null, ref: string): string {
  const r = splitRef(ref);
  const p = r ? s?.providers.find((x) => x.id === r.provider) : undefined;
  if (!r || !p) return ref;
  const m = p.models.find((x) => x.id === r.model);
  return `${providerDisplayName(p.name)} / ${m?.label ?? r.model}`;
}

/** 第三方标签实际用的模型：标签自己的选择 → 会话上次用的模型 → 这个 CLI 在「模型」页分配的默认模型 */
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
  return isCliKind(kind) ? (s?.clients[kind]?.models.main ?? null) : null;
}

/* ------------------- 「新标签默认用」：默认 / 官方账号 / 第三方 ------------------- */

/** 本机 CLI 自己的登录目录（不使用 Nomi 管理的配置），主进程 AccountService 的 local-<kind> 哨兵 */
export const localAccountValue = (kind: CliKind) => `local-${kind}`;

/** 下拉值：default=本机登录；follow=跟随默认账号；account:<id>=指定官方账号；provider:<id>=第三方供应商 */
const NEWTAB_DEFAULT = 'default';
const NEWTAB_FOLLOW = 'follow';
const ACCOUNT_PREFIX = 'account:';
const PROVIDER_PREFIX = 'provider:';

export interface NewTabCtx {
  kind: CliKind;
  client: GatewayState['clients'][CliKind] | undefined;
  gateway: GatewayState | null;
  accounts: CliAccount[];
}

/** 「新标签默认用」当前应选中的下拉值 */
export function newTabSelectValue(client: NewTabCtx['client'], kind: CliKind): string {
  const main = client?.models.main ?? null;
  if ((client?.newTabSource ?? 'official') === 'thirdParty' && main) {
    const p = providerOfRef(main);
    if (p) return `${PROVIDER_PREFIX}${p}`;
  }
  const accountId = client?.newTabAccountId ?? null;
  if (!accountId) return NEWTAB_FOLLOW;
  if (accountId === localAccountValue(kind)) return NEWTAB_DEFAULT;
  return `${ACCOUNT_PREFIX}${accountId}`;
}

/** 「新标签默认用」三级分组下拉的选项：默认（本机登录）/ 官方账号（可指定账号）/ 第三方（供应商） */
export function newTabOptions({ kind, client, gateway, accounts }: NewTabCtx): SelectOption[] {
  const options: SelectOption[] = [];
  const official = hasOfficialAccount(kind);

  options.push({
    value: NEWTAB_DEFAULT,
    group: t('ui.providers-schedule.default'),
    label: official ? t('ui.models.this-computer-s-sign-in') : t('ui.models.dsh-built-in-config'),
    // 标签已写明「本机登录 / 自带配置」，说明只补一句不经 Nomi（太长会撑宽下拉菜单）
    description: t('ui.models.without-nomi'),
  });

  if (official) {
    options.push({
      value: NEWTAB_FOLLOW,
      group: t('ui.chat-settings.official-accounts'),
      label: t('ui.models.follow-the-default-account'),
    });
    const seen = new Set<string>();
    for (const a of accounts) {
      if (a.local) continue;
      seen.add(a.id);
      options.push({
        value: `${ACCOUNT_PREFIX}${a.id}`,
        group: t('ui.chat-settings.official-accounts'),
        label: a.label,
        disabled: !a.loggedIn,
        description: a.loggedIn
          ? (a.identity?.plan ?? a.identity?.email)
          : t('ui.models.not-signed-in'),
      });
    }
    // 已指定的账号后来被删掉：补一个禁用项，避免下拉显示空白
    const accountId = client?.newTabAccountId ?? null;
    if (accountId && accountId !== localAccountValue(kind) && !seen.has(accountId)) {
      options.push({
        value: `${ACCOUNT_PREFIX}${accountId}`,
        group: t('ui.chat-settings.official-accounts'),
        label: accountId,
        disabled: true,
        description: t('ui.models.removed-account'),
      });
    }
  }

  const providers = codingProviders(gateway);
  const present = new Set<string>();
  for (const p of providers) {
    present.add(p.id);
    options.push({
      value: `${PROVIDER_PREFIX}${p.id}`,
      group: t('ui.cli-monitor.third-party'),
      label: p.name,
    });
  }
  // 已分配第三方模型、但供应商不在当前列表（停用 / 删除）时补一项
  const main = client?.models.main ?? null;
  const currentProvider = providerOfRef(main);
  if (
    (client?.newTabSource ?? 'official') === 'thirdParty' &&
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

  return options;
}

export interface NewTabPatch {
  newTabSource: 'official' | 'thirdParty';
  newTabAccountId?: string | null;
  /** 第三方来源必须带上同一供应商的主模型；切回官方时清掉第三方模型。 */
  models?: { main: string | null };
}

/** 下拉值 → setAssignment 的 patch；无法应用（如供应商已无可用模型）时返回 null */
export function newTabPatch(
  value: string,
  { kind, client, gateway }: NewTabCtx,
): NewTabPatch | null {
  const main = client?.models.main ?? null;
  if (value === NEWTAB_DEFAULT) {
    return {
      newTabSource: 'official',
      newTabAccountId: localAccountValue(kind),
      ...(main ? { models: { main: null } } : {}),
    };
  }
  if (value === NEWTAB_FOLLOW) {
    return {
      newTabSource: 'official',
      newTabAccountId: null,
      ...(main ? { models: { main: null } } : {}),
    };
  }
  if (value.startsWith(ACCOUNT_PREFIX)) {
    return {
      newTabSource: 'official',
      newTabAccountId: value.slice(ACCOUNT_PREFIX.length),
      ...(main ? { models: { main: null } } : {}),
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
 * 切换标签来源。第三方 → 官方且标签里已有对话时先确认（主进程会带上下文新开会话）。
 * 返回 null = 用户取消。
 */
export async function switchTabSource(
  tab: Pick<HarnessTabMeta, 'id' | 'source'>,
  source: TabSource,
  opts: { model?: string; hasMessages: boolean },
): Promise<HarnessTabMeta | null> {
  if (
    tabSourceOf(tab) === 'thirdParty' &&
    source === 'official' &&
    opts.hasMessages &&
    !(await confirmDialog({ message: THIRD_PARTY_TO_OFFICIAL() }))
  )
    return null;
  return harnessClient.setTabSource(tab.id, source, opts.model);
}
