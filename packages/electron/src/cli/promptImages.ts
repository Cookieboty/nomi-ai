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
  if (backend === 'dsh' || backend === 'nomi') return backend === 'nomi' ? 'full' : 'none';
  return 'full';
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
  return t(
    '{0} 暂不支持在编程助手会话里发送图片，请去掉图片或换到支持的端（Claude / Codex / Grok / Gemini）。',
    name,
  );
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

/** 规范化并过滤非法 mime / 空 data；最多 max 张 */
export function normalizeImages(
  raw: HarnessImageInput[] | undefined | null,
  max = 8,
): NormalizedImage[] {
  if (!raw?.length) return [];
  const out: NormalizedImage[] = [];
  for (const r of raw) {
    if (out.length >= max) break;
    const mime = normalizeMime(String(r.mime ?? ''));
    if (!mime || !ALLOWED_MIME.has(mime as never)) continue;
    const data = String(r.data ?? '').replace(/\s+/g, '');
    if (!data || data.length > 12_000_000) continue;
    const thumb =
      typeof r.thumb === 'string' && r.thumb.startsWith('data:')
        ? r.thumb
        : `data:${mime};base64,${data.slice(0, 2_000)}`;
    out.push({
      mime,
      data,
      width: Math.max(0, Number(r.width) || 0),
      height: Math.max(0, Number(r.height) || 0),
      thumb,
      ...(r.source ? { source: String(r.source) } : {}),
    });
  }
  return out;
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
 * Grok `-p` 回退：官方 headless 支持 `--prompt-json` 多模态 JSON。
 * 返回应替换 `-p <prompt>` 的 argv 片段（含 flag）。
 */
export function grokPromptJsonArgv(text: string, images: NormalizedImage[]): string[] {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: 'text', text });
  for (const im of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: im.mime, data: im.data },
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const payload = JSON.stringify({ role: 'user', content });
  return ['--prompt-json', payload];
}

/** 清理临时目录（最佳努力） */
export function cleanupStagedDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
