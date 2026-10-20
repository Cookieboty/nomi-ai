import type { LicenseTermsView, ModelConfig } from '@nomi-ai/types';

/**
 * 看板娘角色。只内置 Nomi 一个角色（不再提供角色商店、导入与切换），
 * 列表读打包进应用的 model-list.json。
 */
export interface MascotModel {
  name: string;
  displayName: string;
  description?: string;
  path: string;
  thumbnail?: string;
  author: string;
  license: string;
  source: string;
  vrmVersion?: string;
  tags?: string[];
  credit?: string;
  licenseTerms?: LicenseTermsView;
  licenseFileUrl?: string;
  version?: string;
  config?: ModelConfig;
}

export interface MascotCatalog {
  models: MascotModel[];
}

export const MODEL_LIST_URL = './assets/models/vrm/model-list.json';
/** 旧版本记住的「当前角色」（可能是已移除的商店 / 导入角色） */
const LEGACY_SELECTED_KEY = 'companion.mascot.model';

export function parseCatalog(raw: unknown): MascotModel[] {
  const models = (raw as Partial<MascotCatalog> | null)?.models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (m): m is MascotModel =>
      !!m &&
      typeof m.name === 'string' &&
      typeof m.path === 'string' &&
      typeof m.license === 'string' &&
      m.license.length > 0,
  );
}

let cache: Promise<MascotModel[]> | null = null;

export function loadCatalog(fetchImpl: typeof fetch = fetch): Promise<MascotModel[]> {
  if (!cache) {
    cache = fetchImpl(MODEL_LIST_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => parseCatalog(raw))
      .catch(() => {
        cache = null;
        return [];
      });
  }
  return cache;
}

/** 清掉旧版本记住的角色选择（只剩 Nomi，不再需要） */
export function clearSelectedModel(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_SELECTED_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** 选中模型；找不到时回落到第一个（Nomi）。 */
export function pickModel(models: MascotModel[], name: string | null): MascotModel | undefined {
  return models.find((m) => m.name === name) ?? models[0];
}
