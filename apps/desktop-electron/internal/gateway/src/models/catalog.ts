/**
 * 内置模型目录（§6.9.3 第 2 级）：构建脚本 scripts/build-catalog.mjs 从 models.dev（MIT）生成
 * catalog.json，随应用发布、离线可用。按去掉供应商前缀后的模型 id（小写）查。
 * 运行时同步到的目录作为覆盖层（setCatalogOverlay）：先查覆盖层，没有再查内置（models.dev 下架的
 * 旧模型仍按内置的值）。
 */
import fs from 'node:fs';

import catalog from './catalog.json';
import type { ModelSpecData } from './types';

export interface CatalogDoc {
  version: string;
  source: string;
  license: string;
  models: Record<string, ModelSpecData>;
}

const doc = catalog as unknown as CatalogDoc;

/**
 * 目录版本（学到的结论记下当时的版本，目录升级后重新验证）。只跟内置目录：运行时同步每天都可能更新，
 * 跟着它会让学到的结论天天作废、反复试错。
 */
export const CATALOG_VERSION = doc.version;

let overlay: CatalogDoc | null = null;

/** 运行时同步到的目录（null = 清除，只用内置） */
export function setCatalogOverlay(next: CatalogDoc | null): void {
  overlay = next && next.models && typeof next.models === 'object' ? next : null;
}

/** 覆盖层文件的上限与最少条目数：超过 / 不足视为损坏，不采用 */
const MAX_OVERLAY_BYTES = 16 * 1024 * 1024;
const MIN_OVERLAY_MODELS = 50;

/** 读同步缓存文件；不存在 / 太大 / 形状不对 / 条目过少返回 null */
export function readCatalogFile(file: string): CatalogDoc | null {
  try {
    if (fs.statSync(file).size > MAX_OVERLAY_BYTES) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CatalogDoc>;
    const models = j?.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
    if (Object.keys(models).length < MIN_OVERLAY_MODELS) return null;
    return {
      version: typeof j.version === 'string' ? j.version : '',
      source: 'models.dev',
      license: 'MIT',
      models,
    };
  } catch {
    return null;
  }
}

/** 当前覆盖层的版本（同步日）；没有覆盖层为 null */
export function catalogOverlayVersion(): string | null {
  return overlay?.version ?? null;
}

/** 去掉供应商前缀（openai/gpt-5 → gpt-5；中转服务常带一两级前缀） */
export function bareModelId(id: string): string {
  const i = id.lastIndexOf('/');
  return (i >= 0 ? id.slice(i + 1) : id).toLowerCase();
}

/** 目录里的条目；没收录返回 undefined。中转常加的 `:free` / `:latest` 等标签与日期后缀不参与匹配 */
export function catalogEntry(model: string): ModelSpecData | undefined {
  const id = bareModelId(model).replace(/:[\w.-]+$/, '');
  const base = id.replace(/-\d{8}$|-latest$/, '');
  return overlay?.models[id] ?? doc.models[id] ?? overlay?.models[base] ?? doc.models[base];
}

export function catalogSize(): number {
  return new Set([...Object.keys(doc.models), ...Object.keys(overlay?.models ?? {})]).size;
}
