/**
 * CLI 标签的来源（docs/design/unified-gateway.md §4.3、§13）：官方账号 / 第三方（经网关）。
 * 来源菜单（CliSourceMenu）和斜杠命令 /model、/status 共用这里的数据与切换逻辑。
 */
import { t } from '@nomi-ai/ui';

import type { ClientId, GatewayState } from './gatewayClient';
import { harnessClient, type HarnessTabMeta, type TabSource } from './harnessClient';
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
        model: m.id,
      })),
  );
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
