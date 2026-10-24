/**
 * 内置模型目录（§6.9.3 第 2 级）：构建脚本 scripts/build-catalog.mjs 从 models.dev（MIT）生成
 * catalog.json，随应用发布、离线可用。按去掉供应商前缀后的模型 id（小写）查。
 */
import catalog from './catalog.json';
import type { ModelSpecData } from './types';

interface CatalogDoc {
  version: string;
  source: string;
  license: string;
  models: Record<string, ModelSpecData>;
}

const doc = catalog as unknown as CatalogDoc;

/** 目录版本（学到的结论记下当时的版本，目录升级后重新验证） */
export const CATALOG_VERSION = doc.version;

/** 去掉供应商前缀（openai/gpt-5 → gpt-5；中转服务常带一两级前缀） */
export function bareModelId(id: string): string {
  const i = id.lastIndexOf('/');
  return (i >= 0 ? id.slice(i + 1) : id).toLowerCase();
}

/** 目录里的条目；没收录返回 undefined */
export function catalogEntry(model: string): ModelSpecData | undefined {
  const id = bareModelId(model);
  return doc.models[id] ?? doc.models[id.replace(/-\d{8}$|-latest$/, '')];
}

export function catalogSize(): number {
  return Object.keys(doc.models).length;
}
