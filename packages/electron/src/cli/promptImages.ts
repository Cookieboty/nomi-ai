/**
 * CLI 多模态用户附图：规范化、落盘、按后端组装已文档化注入载荷。
 * 不读凭据；不读用户无关目录（仅写入 harness 临时目录）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { t } from '../i18n';

import type { HarnessBackend } from './types';

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
] as const);

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** IPC / 渲染层传入的附图 */
export interface HarnessImageInput {
  mime: string;
  /** base64，不含 data: 前缀 */
  data: string;
  width?: number;
  height?: number;
  /** 缩略图 data URL（存进消息气泡） */
  thumb?: string;
  source?: string;
}

export interface NormalizedImage {
  mime: ImageMime;
  data: string;
  width: number;
  height: number;
  thumb: string;
  source?: string;
}

export interface StagedImage extends NormalizedImage {
  /** 绝对路径（Codex localImage / --image；会话临时目录） */
  absPath: string;
}

export type ImageSupport = 'full' | 'none';

export function imageSupportFor(backend: HarnessBackend): ImageSupport {
  return backend === 'dsh' ? 'none' : 'full';
}

export function unsupportedImageMessage(backend: HarnessBackend): string {
  const name =
    backend === 'dsh'
      ? 'dsh'
      : backend === 'claude'
        ? 'Claude Code'
        : backend === 'codex'
          ? 'Codex'
          : backend === 'grok'
            ? 'Grok'
            : backend === 'gemini'
              ? 'Gemini'
              : backend;
  return t('electron.common.the-cli-has-no-image-input-so-images', name);
}

/** 当前模型明确不支持看图（CLI / 网关给了模型能力时才判断） */
export function modelNoVisionMessage(model: string): string {
  return t('electron.common.the-current-model-doesn-t-support-images-remove', model);
}

function normalizeMime(mime: string): ImageMime | null {
  const m = mime.trim().toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/webp' || m === 'image/gif') return m;
  return null;
}

function extFor(mime: ImageMime): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

/** 单张图片 base64 上限（字符数，约 9MB 原图） */
export const IMAGE_DATA_MAX = 12_000_000;
/** 没带缩略图时，用原图当气泡缩略图的上限（再大就不能塞进消息记录里） */
export const THUMB_FALLBACK_MAX = 600_000;

export type ImageRejectReason = 'mime' | 'empty' | 'too-large' | 'no-thumb' | 'over-max';

export interface RejectedImage {
  /** 在原始列表里的序号（从 0 开始） */
  index: number;
  reason: ImageRejectReason;
}

/**
 * 规范化图片并记录被拒绝的原因（不再静默丢弃）：非法 mime / 空 data / 超过大小上限 /
 * 缺缩略图且原图太大（截断 base64 当缩略图只会是一张坏图）/ 超过张数上限。
 */
export function inspectImages(
  raw: HarnessImageInput[] | undefined | null,
  max = 8,
): { images: NormalizedImage[]; rejected: RejectedImage[] } {
  const images: NormalizedImage[] = [];
  const rejected: RejectedImage[] = [];
  if (!raw?.length) return { images, rejected };
  raw.forEach((r, index) => {
    if (images.length >= max) {
      rejected.push({ index, reason: 'over-max' });
      return;
    }
    const mime = normalizeMime(String(r.mime ?? ''));
    if (!mime || !ALLOWED_MIME.has(mime as never)) {
      rejected.push({ index, reason: 'mime' });
      return;
    }
    const data = String(r.data ?? '').replace(/\s+/g, '');
    if (!data) {
      rejected.push({ index, reason: 'empty' });
      return;
    }
    if (data.length > IMAGE_DATA_MAX) {
      rejected.push({ index, reason: 'too-large' });
      return;
    }
    let thumb: string;
    if (typeof r.thumb === 'string' && r.thumb.startsWith('data:')) thumb = r.thumb;
    else if (data.length <= THUMB_FALLBACK_MAX) thumb = `data:${mime};base64,${data}`;
    else {
      rejected.push({ index, reason: 'no-thumb' });
      return;
    }
    images.push({
      mime,
      data,
      width: Math.max(0, Number(r.width) || 0),
      height: Math.max(0, Number(r.height) || 0),
      thumb,
      ...(r.source ? { source: String(r.source) } : {}),
    });
  });
  return { images, rejected };
}

/** 兼容旧调用：只要结果，不关心被拒绝的 */
export function normalizeImages(
  raw: HarnessImageInput[] | undefined | null,
  max = 8,
): NormalizedImage[] {
  return inspectImages(raw, max).images;
}

/** 有图片被拒绝时给用户看的说明（整条消息不发出，让用户自己决定去掉哪张） */
export function rejectedImagesMessage(rejected: readonly RejectedImage[], max = 8): string {
  const has = (r: ImageRejectReason) => rejected.some((x) => x.reason === r);
  const parts: string[] = [];
  if (has('too-large')) parts.push(t('electron.common.image-too-large-max-about-9mb-each'));
  if (has('no-thumb')) parts.push(t('electron.common.image-has-no-preview-and-is-too-large'));
  if (has('mime')) parts.push(t('electron.common.only-png-jpeg-webp-gif-images-are-supported'));
  if (has('empty')) parts.push(t('electron.common.image-is-empty'));
  if (has('over-max')) parts.push(t('electron.common.at-most-images-per-message', max));
  return t('electron.common.image-s-can-t-be-sent-remove-them', rejected.length, parts.join('；'));
}

/** 写入会话临时目录，返回带 absPath 的列表 */
export function stageImages(dir: string, images: NormalizedImage[]): StagedImage[] {
  fs.mkdirSync(dir, { recursive: true });
  return images.map((im) => {
    const file = path.join(dir, `${randomUUID()}${extFor(im.mime)}`);
    fs.writeFileSync(file, Buffer.from(im.data, 'base64'));
    return { ...im, absPath: file };
  });
}

/** 气泡展示用缩略图（不落全尺寸 base64） */
export function imageThumbsForMessage(
  images: NormalizedImage[],
): Array<{ thumb: string; width: number; height: number; source?: string }> {
  return images.map((im) => ({
    thumb: im.thumb,
    width: im.width,
    height: im.height,
    ...(im.source ? { source: im.source } : {}),
  }));
}

/** Claude stream-json：Anthropic content blocks */
export function claudeContentBlocks(
  text: string,
  images: NormalizedImage[],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const im of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: im.mime, data: im.data },
    });
  }
  if (text.trim()) blocks.push({ type: 'text', text });
  else if (!blocks.length) blocks.push({ type: 'text', text: '' });
  return blocks;
}

/** Codex app-server turn/start input */
export function codexTurnInput(
  text: string,
  staged: StagedImage[],
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [{ type: 'text', text, text_elements: [] }];
  for (const im of staged) {
    input.push({ type: 'localImage', path: im.absPath });
  }
  return input;
}

/** Codex exec 回退：每个附件一对 --image <absPath>，插在 prompt 参数之前 */
export function codexImageArgs(staged: StagedImage[]): string[] {
  const args: string[] = [];
  for (const im of staged) {
    args.push('--image', im.absPath);
  }
  return args;
}

/** ACP session/prompt parts（Grok / Gemini） */
export function acpPromptParts(
  text: string,
  images: NormalizedImage[],
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const im of images) {
    parts.push({ type: 'image', mimeType: im.mime, data: im.data });
  }
  if (!parts.length) parts.push({ type: 'text', text: '' });
  return parts;
}

/**
 * Grok `-p` 回退带图：把 ACP content blocks（含 base64 图片）写进临时 `.json` 文件，
 * 用 `--prompt-file <file>`（`.json` 按 content blocks 解析）传入，base64 不进 argv
 * （命令行参数有长度上限，也会出现在进程列表里）。文件随会话临时目录一起清理。
 * 返回应替换 `-p <prompt>` 的 argv 片段（含 flag）。
 */
export function grokPromptFileArgv(dir: string, text: string, images: NormalizedImage[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `grok-prompt-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(acpPromptParts(text, images)), { mode: 0o600 });
  return ['--prompt-file', file];
}

/** 清理临时目录（最佳努力） */
export function cleanupStagedDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
