/**
 * 对话标签上下文用到的纯函数与公开类型（无 React、无 store）：待发失败的提示形状与「是不是同一条」
 * 待发消息判断（手动发送替代失败队首时只认完全一样的那条）。
 * 状态机本身见 harnessPendingQueue，实时进度事件见 harnessLiveEvents。
 */
import type { PendingImage, PendingSend } from '../utils/pendingSends';

/** 自动发送失败、挂回队首的那一条：提示里带上原因，用户处理（重试 / 删除 / 手动发送）后才再发 */
export interface PendingSendFailure {
  item: PendingSend;
  message: string;
  at: number;
}

/** 两张图是不是同一张（内容以 data 为准，再比元信息；url / thumb 只是补存之后才有的） */
const sameImage = (a: PendingImage, b: PendingImage): boolean =>
  a.mime === b.mime &&
  a.data === b.data &&
  (a.id ?? '') === (b.id ?? '') &&
  (a.width ?? -1) === (b.width ?? -1) &&
  (a.height ?? -1) === (b.height ?? -1) &&
  (a.source ?? '') === (b.source ?? '');

const sameImages = (
  a: readonly PendingImage[] | undefined,
  b: readonly PendingImage[] | undefined,
): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((img, i) => sameImage(img, y[i]!));
};

/**
 * 手动发送的这条是不是就是失败的那条：正文（去首尾空白）和附图都要一样——只有正文相同、附件不同的是另一条，
 * 不能当替代提前移除（否则不同附件的消息会被吞掉）。
 */
export const sameFailedSend = (
  item: Pick<PendingSend, 'text' | 'images'>,
  text: string,
  images: readonly PendingImage[] | undefined,
): boolean => item.text.trim() === text.trim() && sameImages(item.images, images);
