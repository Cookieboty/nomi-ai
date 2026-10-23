/**
 * CLI 标签的来源（docs/design/unified-gateway.md §4.3、§13）：官方账号 / 第三方（经网关）。
 * 侧栏信息卡的「新标签默认」（CliDefaultSource）、模型按钮和斜杠命令 /model、/status 共用这里的数据与切换逻辑。
 */
import { t } from '@nomi-ai/ui';

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
  if (!pid) return catalog;
  const prefix = `${pid}/`;
  type Model = BackendModelCatalog['models'][number];
  const strip = (m: Model): Model => {
    const cut = m.label?.indexOf(' / ') ?? -1;
    return cut >= 0 ? { ...m, label: m.label!.slice(cut + 3) } : m;
  };
  const def = catalog.defaultModel;
  return {
    ...catalog,
    models: catalog.models.filter((m) => m.id.startsWith(prefix)).map(strip),
    defaultModel: def && def.id.startsWith(prefix) ? strip(def) : null,
    provider: { id: catalog.provider?.id ?? 'gateway', name: providerLabel(s, pid) },
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

/** 第三方标签实际用的模型：标签自己的选择，没有就用这个 CLI 在「模型」页分配的默认模型 */
export function thirdPartyRefOf(
  tab: Pick<HarnessTabMeta, 'modelOverride'> | null | undefined,
  kind: string,
  s: GatewayState | null,
): string | null {
  const own = tab?.modelOverride?.trim();
  if (own) return own;
  return isCliKind(kind) ? (s?.clients[kind]?.models.main ?? null) : null;
}

export const THIRD_PARTY_TO_OFFICIAL = () =>
  t('第三方的推理内容不能发给官方接口，将用带上下文的新会话继续，原会话保留。继续吗？');

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
    !window.confirm(THIRD_PARTY_TO_OFFICIAL())
  )
    return null;
  return harnessClient.setTabSource(tab.id, source, opts.model);
}
