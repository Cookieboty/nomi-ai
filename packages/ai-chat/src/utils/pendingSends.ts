/**
 * 运行中发出、还没交出去的消息（输入框上方的待发列表）：
 * - steer（Enter）：插入这一轮。等到安全点再交给 CLI / Nomi：下一个工具开始时，或入列时正好有工具在跑
 *   （CLI 在这个工具结果处取走）。交出去之前可以撤回修改或删除；交不出去（后端不支持、这一轮已结束）就排队。
 * - queue（Ctrl+Enter）：排队到这一轮结束，再作为新的一轮发出。
 * Esc（输入框里、列表非空）：停止这一轮，把列表里的消息合成一条马上发出。
 */
import type { HarnessTraceEvent } from '../services/harnessClient';
import type { ImageAttachment } from '../services/screenClient';

export type PendingMode = 'steer' | 'queue';

/** 待发消息附带的图片（兼容 ImageAttachment 与 HarnessImageInput） */
export interface PendingImage {
  id?: string;
  mime: string;
  data: string;
  width?: number;
  height?: number;
  thumb?: string;
  source?: string;
  url?: string;
}

export interface PendingSend {
  id: string;
  text: string;
  mode: PendingMode;
  /** Nomi：入列时开着知识库问答（出队时走问答，见 useSendQueue） */
  kb?: boolean;
  /** 随消息排队的图片附件（仅内存持有，不写 localStorage / 会话元信息） */
  images?: readonly PendingImage[];
}

let seq = 0;
let imgSeq = 0;
export const newPendingId = (): string => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

const IMAGE_MIMES = new Set<ImageAttachment['mime']>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const IMAGE_SOURCES = new Set<ImageAttachment['source']>(['snip', 'screen', 'paste', 'file']);

/**
 * 合成一条（Esc 马上发出 / 交不出去）后的 id：由被合成的那几条决定（`+` 起头，不会和 newPendingId 撞）。
 * 合成后的那条已经存进会话的待发列表，之后照常第 2 步交出去；重启前就交出去、最后只写进用户消息的，
 * 同一次交付里只有这一条，重启后从回复的开头（`## You added` 分节）认出它，不再多一条重复的。
 */
export const mergePendingKey = (items: readonly Pick<PendingSend, 'id'>[]): string =>
  `+${items.map((i) => i.id).join('+')}`;

/** 合成一条发送的正文（多条之间空一行） */
export function mergePending(items: readonly Pick<PendingSend, 'text'>[]): string {
  return items
    .map((i) => i.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 按顺序合并多条待发消息里的图片 */
export function mergePendingImages(items: readonly Pick<PendingSend, 'images'>[]): PendingImage[] {
  const out: PendingImage[] = [];
  for (const item of items) {
    if (item.images?.length) out.push(...item.images);
  }
  return out;
}

/**
 * 合成待发消息供打断并立即发出：
 * - 纯文字合成一条；
 * - 带图时按 maxImages 分批，不丢图、不把带图消息走知识库通道。
 */
export function mergePendingBatches(
  items: readonly PendingSend[],
  maxImages: number,
): PendingSend[] {
  if (!items.length) return [];
  if (!items.some((i) => i.images?.length)) {
    return [
      {
        id: mergePendingKey(items),
        text: mergePending(items),
        mode: 'queue',
        ...(items.some((i) => i.kb) ? { kb: true } : {}),
      },
    ];
  }
  const batches: PendingSend[] = [];
  let current: PendingSend[] = [];
  let imgCount = 0;
  const flushBatch = () => {
    if (!current.length) return;
    const images = mergePendingImages(current);
    batches.push({
      id: mergePendingKey(current),
      text: mergePending(current),
      mode: 'queue',
      ...(images.length ? { images } : current.some((i) => i.kb) ? { kb: true } : {}),
    });
    current = [];
    imgCount = 0;
  };
  for (const item of items) {
    const n = item.images?.length ?? 0;
    if (current.length > 0 && imgCount + n > maxImages) {
      flushBatch();
    }
    current.push(item);
    imgCount += n;
  }
  flushBatch();
  return batches;
}

/** 将待发图片转为前端附件格式（给 Nomi 发送与撤回编辑用） */
export function toImageAttachments(images: readonly PendingImage[] | undefined): ImageAttachment[] {
  if (!images?.length) return [];
  return images.map((img) => {
    const mime = IMAGE_MIMES.has(img.mime as ImageAttachment['mime'])
      ? (img.mime as ImageAttachment['mime'])
      : 'image/jpeg';
    const source = IMAGE_SOURCES.has(img.source as ImageAttachment['source'])
      ? (img.source as ImageAttachment['source'])
      : 'paste';
    return {
      id: img.id || `pimg-${Date.now().toString(36)}-${(imgSeq++).toString(36)}`,
      mime,
      data: img.data,
      width: img.width ?? 0,
      height: img.height ?? 0,
      thumb: img.thumb || `data:${mime};base64,${img.data}`,
      source,
    };
  });
}

/** 轨迹里还有没结束的工具调用（此时交出的插入消息会在它的结果处被取走） */
export function hasRunningTool(trace: readonly HarnessTraceEvent[] | undefined): boolean {
  if (!trace?.length) return false;
  const open = new Set<string>();
  for (const ev of trace) {
    if (ev.type !== 'tool') continue;
    const key = ev.id ?? ev.detail ?? ev.name;
    if (ev.status === 'start') open.add(key);
    else open.delete(key);
  }
  return open.size > 0;
}

/** 取出所有可插入的纯文本消息（带图的留在 rest，不经纯文本 steer 丢图） */
export function takeSteer(list: readonly PendingSend[]): {
  steer: PendingSend[];
  rest: PendingSend[];
} {
  const steer: PendingSend[] = [];
  const rest: PendingSend[] = [];
  for (const i of list) (i.mode === 'steer' && !i.images?.length ? steer : rest).push(i);
  return { steer, rest };
}

/** 交不出去的插入消息改为排队，放回列表最前（保持它们原来的先后） */
export function requeue(
  list: readonly PendingSend[],
  failed: readonly PendingSend[],
): PendingSend[] {
  return [...failed.map((i) => ({ ...i, mode: 'queue' as const })), ...list];
}
