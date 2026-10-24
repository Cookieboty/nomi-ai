/**
 * 编程助手会话能不能附图（与主进程 sendTab 里的检查一致）：
 * - dsh：命令行本身没有图片输入，一律不行；
 * - 其它：看这个会话当前用的模型——CLI / 网关明确说不支持看图（Codex input_modalities、
 *   网关模型 vision: false）才拦，不知道就放行，交给 CLI / 网关处理。
 */
import { t } from '@nomi-ai/ui';
import { useEffect, useMemo, useState } from 'react';

import { tabSourceOf } from '../services/cliSource';
import {
  harnessClient,
  type BackendModelCatalog,
  type HarnessBackend,
  type HarnessTabMeta,
} from '../services/harnessClient';

import { cliAcceptsImages } from './cliCaps';

export type CliImageCapability = 'full' | 'none';

export interface CliImageSupport {
  capability: CliImageCapability;
  /** 不能附图时给用户看的原因 */
  reason?: string;
}

/** 后端本身能不能收图（不看模型） */
export function cliImageSupport(backend: HarnessBackend | undefined | null): CliImageCapability {
  // 按插件清单的 images 能力位（如 dsh 的命令行没有图片输入）
  return cliAcceptsImages(backend) ? 'full' : 'none';
}

/** 结合模型目录判断（纯函数，便于单测） */
export function imageSupportFor(
  tab: Pick<HarnessTabMeta, 'backend' | 'modelOverride'> | null | undefined,
  catalog: BackendModelCatalog | null | undefined,
): CliImageSupport {
  if (!tab) return { capability: 'full' };
  if (cliImageSupport(tab.backend) === 'none')
    return {
      capability: 'none',
      reason: t('{0} 的命令行没有图片输入，不能在会话里发送图片，请去掉图片后再发。', 'dsh'),
    };
  const own = tab.modelOverride?.trim() || null;
  const m = own ? catalog?.models.find((x) => x.id === own) : catalog?.defaultModel;
  if (m && m.vision === false)
    return {
      capability: 'none',
      reason: t(
        '当前模型 {0} 不支持图片，请去掉图片，或在模型按钮里换一个能看图的模型。',
        m.label ?? m.id,
      ),
    };
  return { capability: 'full' };
}

/** 当前会话能不能附图：读这个标签来源（官方 / 第三方）的模型目录（主进程有缓存） */
export function useCliImageSupport(tab: HarnessTabMeta | null | undefined): CliImageSupport {
  const backend = tab?.backend;
  const source = tabSourceOf(tab);
  const [catalog, setCatalog] = useState<{ key: string; value: BackendModelCatalog | null }>();
  const key = `${backend}|${source}`;
  useEffect(() => {
    if (!backend || backend === 'nomi' || !cliAcceptsImages(backend)) return;
    let alive = true;
    harnessClient
      .modelCatalog(backend, source === 'thirdParty' ? { source } : {})
      .then((c) => alive && setCatalog({ key: `${backend}|${source}`, value: c }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend, source]);
  const value = catalog?.key === key ? catalog.value : null;
  const modelOverride = tab?.modelOverride;
  return useMemo(
    () => (backend ? imageSupportFor({ backend, modelOverride }, value) : { capability: 'full' }),
    [backend, modelOverride, value],
  );
}
