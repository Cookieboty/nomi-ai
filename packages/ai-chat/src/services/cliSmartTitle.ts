import { api } from './api';
import { getSmartTitle } from './chatPrefs';
import { harnessClient } from './harnessClient';
import type { HarnessTabMeta } from './harnessClient';
import { splitRef } from './nomiModel';
import { generateSmartTitle, type TitleComplete } from './sessionTitle';

/** Build a TitleComplete that hits the gateway with the tab's provider/model ref. */
export function cliTitleComplete(ref: string): TitleComplete {
  return async (messages) => {
    const r = splitRef(ref);
    if (!r) return '';
    const resp = await api.ai.chat.sendMessage({
      messages,
      role: 'chat',
      provider: r.provider,
      model: r.model,
    });
    return typeof resp?.content === 'string' ? resp.content.trim() : '';
  };
}

/**
 * Official CLI tabs (no free-form gateway model) keep the heuristic title only.
 * Third-party tabs with a `provider/model` ref run generateSmartTitle then applyAutoTitle.
 * 隐私设置里关掉「用模型生成对话标题」时一律不发请求（与 Nomi 对话同一个开关，#247）。
 */
export async function maybeSmartTitleCliTab(opts: {
  tab: Pick<HarnessTabMeta, 'id' | 'source' | 'modelOverride' | 'lastServedRef' | 'backend'>;
  userText: string;
  complete: TitleComplete;
  applyAutoTitle: (id: string, title: string) => Promise<unknown>;
  /** 隐私开关，默认读 chatPrefs；测试注入 */
  enabled?: () => boolean;
}): Promise<void> {
  if (!(opts.enabled ?? getSmartTitle)()) return;
  const ref =
    opts.tab.source === 'thirdParty'
      ? opts.tab.modelOverride || opts.tab.lastServedRef || null
      : null;
  if (!ref || !splitRef(ref)) return;
  const title = await generateSmartTitle(opts.userText, opts.complete);
  if (!title) return;
  await opts.applyAutoTitle(opts.tab.id, title);
}

/** 编程助手标签第一次发送后：第三方模型的标签按它的模型后台起标题（官方标签只保留截取的标题） */
export function smartTitleOnFirstSend(
  tab: Pick<HarnessTabMeta, 'id' | 'source' | 'modelOverride' | 'lastServedRef' | 'backend'>,
  userText: string,
): Promise<void> {
  if (!getSmartTitle()) return Promise.resolve();
  const ref = tab.source === 'thirdParty' ? tab.modelOverride || tab.lastServedRef || null : null;
  return maybeSmartTitleCliTab({
    tab,
    userText,
    complete: ref ? cliTitleComplete(ref) : async () => '',
    applyAutoTitle: (id, title) => harnessClient.applyAutoTitle(id, title),
  });
}
