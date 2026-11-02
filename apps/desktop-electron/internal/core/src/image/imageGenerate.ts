/**
 * Nomi 对话的生图工具 image_generate：用「模型」页给 Nomi 分配的图片模型（clients.nomi.models.image，
 * `供应商/模型`）生图。各家接口的差异在网关包的 media 层：端点规则（endpoints.ts）选适配器与地址，
 * 适配器（adapters/*）拼请求、解析响应；这里只负责发请求、放 Key、轮询异步任务、下载与保存图片。
 *
 * - 没分配图片模型 / 供应商不可用 / 没有可用端点时不提供这个工具（ToolDefinition.available）；
 * - 图片存到 userData/chat/images（经 chat-asset 协议给视图），工具结果只回 `chat-asset://images/<file>`；
 * - 接口返回图片 URL 时只下载公网 http(s) 地址、不跟随跳转（防 SSRF），大小有上限。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolDefinition } from '@nomi-ai/bundle-ig-base';
import {
  IMAGE_ASPECTS,
  imageAuthHeaders,
  resolveImageEndpoint,
  upstreamErrorMessage,
  type GeneratedImage,
  type ImageAspect,
  type ImageEndpoint,
  type ImageGenInput,
  type ImageHttpRequest,
  type ImageProviderInfo,
  type ImageRef,
  type Wire,
} from '@nomi-ai/gateway';
import { z } from 'zod';

import { t } from '../i18n';
import { assertPublicHttpUrlResolved } from '../security/netGuard';
import { ensurePrivateDir } from '../utils/privateFile';

export const IMAGE_TOOL = 'image_generate';
/** 单张图片的大小上限 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** 异步任务默认最长等待 */
const DEFAULT_TASK_TIMEOUT_MS = 180_000;

/** GatewayService.imageProvider 的形状 */
export interface ImageProviderAccess {
  info: ImageProviderInfo;
  keyFor(wire: Wire): string | undefined;
  headers?: Record<string, string>;
}

export interface ImageToolDeps {
  /** Nomi 生图用的模型（`供应商/模型`：指定的，或按对话模型自动匹配的）；都没有为 null */
  imageRef(): string | null;
  /** 当前的图片模型是不是自动匹配来的（工具结果与对话里的图片说明标出来） */
  imageAuto?: () => boolean;
  imageProvider(providerId: string): ImageProviderAccess | null;
  /** 图片存放目录（userData/chat/images） */
  imagesDir: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 生成了一张图（素材库记下模型 / 提示词 / 画幅 / 改自哪张 / 会话，media/AssetLibrary.ts） */
  onGenerated?: (file: string, meta: GeneratedMeta) => void;
}

export interface GeneratedMeta {
  /** `供应商/模型` */
  model: string;
  prompt: string;
  aspect?: ImageAspect;
  /** 改图：改自素材库里的哪张 */
  editedFrom?: string;
  /** 参考图生成：参考了素材库里的哪几张 */
  references?: string[];
  conversationId?: string;
}

/** `供应商/模型` → 供应商 id 与模型 id（模型 id 自己可以含 `/`） */
export function splitImageRef(ref: string | null): { provider: string; model: string } | null {
  const i = ref ? ref.indexOf('/') : -1;
  return ref && i > 0 && i < ref.length - 1
    ? { provider: ref.slice(0, i), model: ref.slice(i + 1) }
    : null;
}

interface Target {
  model: string;
  endpoint: ImageEndpoint;
  access: ImageProviderAccess;
}

/** 当前能不能生图：分配了图片模型，供应商可用，且端点规则给出了适配器与地址；ref 指定时用它（重新生成） */
export function imageTarget(
  deps: Pick<ImageToolDeps, 'imageRef' | 'imageProvider'>,
  ref?: string | null,
): Target | null {
  const r = splitImageRef(ref ?? deps.imageRef());
  if (!r) return null;
  const access = deps.imageProvider(r.provider);
  if (!access) return null;
  const endpoint = resolveImageEndpoint(access.info, r.model);
  return endpoint ? { model: r.model, endpoint, access } : null;
}

async function send(
  f: typeof fetch,
  req: ImageHttpRequest,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  let body: BodyInit | undefined;
  if (req.multipart) {
    // multipart：Content-Type（含 boundary）由 fetch 按 FormData 生成
    const form = new FormData();
    for (const [k, v] of Object.entries(req.multipart.fields)) form.append(k, v);
    for (const file of req.multipart.files)
      form.append(
        file.field,
        new Blob([new Uint8Array(Buffer.from(file.b64, 'base64'))], { type: file.mime }),
        file.name,
      );
    body = form;
  } else if (req.body !== undefined) body = JSON.stringify(req.body);
  const res = await f(req.url, {
    method: req.method,
    headers: {
      ...(req.body !== undefined && !req.multipart ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
      ...req.headers,
    },
    ...(body !== undefined ? { body } : {}),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok)
    throw new Error(
      t(
        'electron.image.service-returned',
        res.status,
        (upstreamErrorMessage(json) ?? text).slice(0, 300),
      ),
    );
  if (json === undefined)
    throw new Error(t('electron.image.no-image-in-response', text.slice(0, 200)));
  return json;
}

/** 按端点生图：首次请求 →（异步任务则轮询）→ 第一张图 */
export async function runImageEndpoint(
  target: Target,
  prompt: string,
  aspect: ImageAspect,
  opts: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** 带图（改图 / 参考图；适配器要声明 edit） */
    refs?: ImageRef[];
    refMode?: 'edit' | 'reference';
    /** 对话停止 / 工具调用取消：请求与轮询等待都随之中止 */
    signal?: AbortSignal;
  } = {},
): Promise<{ image: GeneratedImage; revisedPrompt?: string }> {
  const f = opts.fetchImpl ?? fetch;
  const signal = opts.signal;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const now = opts.now ?? Date.now;
  const { adapter, baseURL, wire, auth } = target.endpoint;
  if (opts.refs?.length && !adapter.edit)
    throw new Error(t('electron.image.edit-not-supported', target.model));
  const input: ImageGenInput = {
    baseURL,
    model: target.model,
    prompt,
    aspect,
    ...(opts.refs?.length ? { refs: opts.refs, refMode: opts.refMode ?? 'reference' } : {}),
  };
  const headers = {
    ...target.access.headers,
    ...imageAuthHeaders(auth, target.access.keyFor(wire)),
  };
  const deadline = now() + (adapter.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
  let body = await send(f, adapter.build(input), headers, signal);
  for (;;) {
    const r = adapter.parse(body, input);
    if (r.kind === 'failed') throw new Error(t('electron.image.task-failed', r.message));
    if (r.kind === 'images') {
      const image = r.images[0];
      if (!image)
        throw new Error(
          t('electron.image.no-image-in-response', JSON.stringify(body).slice(0, 200)),
        );
      return { image, ...(r.revisedPrompt ? { revisedPrompt: r.revisedPrompt } : {}) };
    }
    if (now() + r.afterMs > deadline) throw new Error(t('electron.image.task-timeout'));
    await sleep(r.afterMs);
    body = await send(f, r.next, headers, signal);
  }
}

/** 可中止的等待：signal 触发时立即以 AbortError 结束 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 图片字节：base64 直接解；URL 只下载公网地址、不跟随跳转 */
export async function imageBytes(
  img: GeneratedImage,
  f: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (img.b64) return new Uint8Array(Buffer.from(img.b64, 'base64'));
  if (!img.url) throw new Error(t('electron.image.no-image-in-response', ''));
  const url = await assertPublicHttpUrlResolved(img.url);
  signal?.throwIfAborted();
  const res = await f(url.toString(), { redirect: 'error', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(t('electron.image.download-failed', res.status));
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES)
    throw new Error(t('electron.image.too-large'));
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error(t('electron.image.too-large'));
  return buf;
}

/** 按文件头猜扩展名（接口多为 PNG，也有 JPEG / WebP） */
export function imageExt(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'webp';
  return 'png';
}

/** 素材库里的图片：`chat-asset://images/<file>` 或文件名 → 本地路径（只认生成的图片文件名，防路径穿越） */
const ASSET_NAME = /^[a-z][a-z0-9]*-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/i;
export function assetPathOf(imagesDir: string, ref: string): string | null {
  const name = ref.replace(/^chat-asset:\/\/images\//, '');
  return ASSET_NAME.test(name) && name === path.basename(name) ? path.join(imagesDir, name) : null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 最多带几张参考图 */
export const MAX_REFERENCES = 4;

/** 读素材库里的一张图（只发给图片模型，不进对话上下文） */
async function readAsset(imagesDir: string, ref: string): Promise<{ file: string; ref: ImageRef }> {
  const p = assetPathOf(imagesDir, ref);
  if (!p) throw new Error(t('electron.image.edit-source-missing'));
  let buf: Buffer;
  try {
    buf = await fs.readFile(p);
  } catch {
    throw new Error(t('electron.image.edit-source-missing'));
  }
  const ext = path.extname(p).slice(1).toLowerCase();
  return {
    file: path.basename(p),
    ref: { mime: MIME_BY_EXT[ext] ?? 'image/png', b64: buf.toString('base64') },
  };
}

/**
 * 生成一张图并存进素材库：对话里的 image_generate 与素材库的「重新生成」共用。
 * 两种带图模式（素材库里的图片从本地读出来，只发给图片模型，不进对话上下文）：
 * - editFrom：改图，在这张图上修改；
 * - references：参考图生成，以这几张为参考生成新图。
 */
export async function generateImageAsset(
  deps: ImageToolDeps,
  req: {
    prompt: string;
    aspect?: ImageAspect;
    editFrom?: string;
    references?: string[];
    /** 指定模型（`供应商/模型`，重新生成沿用原图的模型）；不给 = 当前的图片模型 */
    modelRef?: string;
    conversationId?: string;
    /** 对话停止时中止：不再请求、不落盘、不记入素材库 */
    signal?: AbortSignal;
  },
): Promise<{
  file: string;
  url: string;
  model: string;
  provider: string;
  adapter: string;
  revisedPrompt?: string;
}> {
  const now = deps.now ?? Date.now;
  // 指定了模型（重新生成沿用原图的模型）就只用它：不可用时报错，不悄悄换成当前图片模型（#224）
  const target = req.modelRef ? imageTarget(deps, req.modelRef) : imageTarget(deps);
  if (!target)
    throw new Error(
      req.modelRef
        ? t('electron.image.regenerate-model-unavailable', req.modelRef)
        : t('electron.image.no-image-model'),
    );
  let refs: ImageRef[] | undefined;
  let refMode: 'edit' | 'reference' | undefined;
  let editedFrom: string | undefined;
  let references: string[] | undefined;
  if (req.editFrom) {
    const a = await readAsset(deps.imagesDir, req.editFrom);
    refs = [a.ref];
    refMode = 'edit';
    editedFrom = a.file;
  } else if (req.references?.length) {
    const list = await Promise.all(
      req.references.slice(0, MAX_REFERENCES).map((r) => readAsset(deps.imagesDir, r)),
    );
    refs = list.map((x) => x.ref);
    refMode = 'reference';
    references = list.map((x) => x.file);
  }
  const aspect = req.aspect ?? 'auto';
  const { image, revisedPrompt } = await runImageEndpoint(target, req.prompt, aspect, {
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    now,
    ...(refs ? { refs, refMode } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  const bytes = await imageBytes(image, deps.fetchImpl, req.signal);
  req.signal?.throwIfAborted();
  ensurePrivateDir(deps.imagesDir);
  // 前缀 = 来源（素材库按它区分 Nomi / 各编程助手生成的图片）
  const file = `nomi-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${imageExt(bytes)}`;
  await fs.writeFile(path.join(deps.imagesDir, file), bytes, { mode: 0o600 });
  deps.onGenerated?.(file, {
    model: `${target.access.info.id}/${target.model}`,
    prompt: req.prompt,
    ...(aspect !== 'auto' ? { aspect } : {}),
    ...(editedFrom ? { editedFrom } : {}),
    ...(references ? { references } : {}),
    ...(req.conversationId ? { conversationId: req.conversationId } : {}),
  });
  return {
    file,
    url: `chat-asset://images/${file}`,
    model: target.model,
    provider: target.access.info.id,
    adapter: target.endpoint.adapter.id,
    ...(revisedPrompt ? { revisedPrompt } : {}),
  };
}

export function createImageTools(deps: ImageToolDeps): ToolDefinition[] {
  const tool: ToolDefinition<{
    prompt: string;
    aspect_ratio?: ImageAspect;
    edit_image?: string;
    reference_images?: string[];
  }> = {
    name: IMAGE_TOOL,
    description:
      'Generate an image from a text prompt with the image model the user configured for Nomi. ' +
      'Write the prompt in English when possible and be specific (subject, style, composition). ' +
      'Images are only sent to the image model when the user explicitly asks for it: ' +
      'to change an existing generated image pass its chat-asset://images/... link as edit_image and describe the change; ' +
      'to make a new image based on existing ones (style, subject, composition) pass up to 4 links as reference_images. ' +
      'Otherwise leave both out. ' +
      'The generated image is shown to the user automatically under this step; ' +
      'reply briefly about what you drew and do not paste the image link.',
    input: z.object({
      prompt: z.string().min(1).max(4000).describe('What to draw, or how to change the image'),
      aspect_ratio: z
        .enum(IMAGE_ASPECTS as [ImageAspect, ...ImageAspect[]])
        .optional()
        .describe('Aspect ratio; omit for the model default'),
      edit_image: z
        .string()
        .max(300)
        .optional()
        .describe('Only to edit an existing generated image: its chat-asset://images/... link'),
      reference_images: z
        .array(z.string().max(300))
        .max(MAX_REFERENCES)
        .optional()
        .describe('Only to generate from reference images: chat-asset://images/... links'),
    }),
    available: () => imageTarget(deps) !== null,
    async execute(input, ctx) {
      const r = await generateImageAsset(deps, {
        prompt: input.prompt,
        ...(input.aspect_ratio ? { aspect: input.aspect_ratio } : {}),
        ...(input.edit_image ? { editFrom: input.edit_image } : {}),
        ...(input.reference_images?.length ? { references: input.reference_images } : {}),
        ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      });
      return {
        ok: true,
        image: r.url,
        model: r.model,
        provider: r.provider,
        ...(deps.imageAuto?.() ? { auto: true } : {}),
        adapter: r.adapter,
        ...(input.edit_image
          ? { mode: 'edit' }
          : input.reference_images?.length
            ? { mode: 'reference' }
            : {}),
        ...(r.revisedPrompt ? { revisedPrompt: r.revisedPrompt } : {}),
      };
    },
  };
  return [tool as ToolDefinition];
}
