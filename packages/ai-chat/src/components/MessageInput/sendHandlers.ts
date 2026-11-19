import { createLogger, t as tr } from '@nomi-ai/ui';

import type { AiChatActionsValue } from '../../contexts/AiChatContext';
import { joinFileAttachments, type FileAttachment } from '../../services/fileAttachments';
import type { ImageAttachment } from '../../services/screenClient';
import type { SlashCommand } from '../../slash/types';

const log = createLogger('message-input');

type PendingMode = 'steer' | 'queue';

interface SendContext {
  actions: AiChatActionsValue['actions'];
  onSend?: (text: string, images?: ImageAttachment[]) => void | Promise<void>;
  busyOverride?: boolean;
  imageCapability?: 'full' | 'partial' | 'none';
  imageUnsupportedReason?: string;
  kbMode: boolean;
  kbAvailable: boolean;
  busy: boolean;
  queue?: {
    onQueue: (
      text: string,
      opts: { kb?: boolean; mode: PendingMode; images?: ImageAttachment[] },
    ) => void;
  };
  slash?: {
    scope?: () => string | undefined;
    run: (cmd: string, registry: SlashCommand[]) => Promise<{ handled: boolean; text?: string }>;
  };
  getRegistry: () => SlashCommand[];
  clearActive: () => void;
  setImgErr: (err: string) => void;
  setImages: (imgs: ImageAttachment[]) => void;
  setFiles: (files: FileAttachment[]) => void;
  setMessage: (msg: string) => void;
}

export function createSendHandler(
  ctx: SendContext,
  linkedDraft: { serialized: string },
  images: ImageAttachment[],
  files: FileAttachment[],
) {
  return async (mode: PendingMode = 'steer') => {
    let trimmedMessage =
      linkedDraft.serialized.trim() ||
      (images.length
        ? tr('ui.knowledge-local.please-take-a-look-at-this-image')
        : files.length
          ? tr('ui.knowledge-local.please-take-a-look-at-these-files')
          : '');
    if (!trimmedMessage) return;

    // 斜杠命令：原生命令 / 未知命令 / 自定义命令都在这里被接管；`//x` 转义成普通文字 `/x`
    if (ctx.slash && !images.length && !files.length && trimmedMessage.startsWith('/')) {
      const scopeAtStart = ctx.slash.scope?.();
      const r = await ctx.slash.run(trimmedMessage, ctx.getRegistry());
      if (r.handled) {
        // 命令是异步的：完成时用户若已切到别的会话，输入框里是那边的草稿，不能清掉
        if (scopeAtStart === undefined || ctx.slash.scope?.() === scopeAtStart) ctx.clearActive();
        return;
      }
      if (r.text !== undefined) trimmedMessage = r.text;
    }

    // 文件附件拼在正文末尾，随文字一起走（排队也带上）
    const sendFiles = files;
    const typed = trimmedMessage;
    trimmedMessage = joinFileAttachments(trimmedMessage, sendFiles);

    if (ctx.busy) {
      if (images.length && ctx.imageCapability === 'none') {
        ctx.setImgErr(
          ctx.imageUnsupportedReason ??
            tr('ui.session-workspace.the-current-model-doesn-t-support-images-remove'),
        );
        return;
      }
      // 运行中：纯文字可按 mode 插入或排队；带图片先排队（保留图片附件），本轮结束后自动发送
      if (ctx.queue) {
        const opts: { kb?: boolean; mode: PendingMode; images?: ImageAttachment[] } = { mode };
        if (images.length) {
          opts.images = images;
        } else if (ctx.kbMode && ctx.kbAvailable) {
          // 入队时冻结知识库模式：排队期间切换开关不改变这条消息的去向
          opts.kb = true;
        }
        ctx.queue.onQueue(trimmedMessage, opts);
        ctx.clearActive();
        ctx.setImgErr('');
      }
      return;
    }

    const sendImages = images;

    try {
      ctx.clearActive();
      ctx.setImgErr('');
      if (sendImages.length && ctx.imageCapability === 'none') {
        ctx.setImgErr(
          ctx.imageUnsupportedReason ??
            tr('ui.session-workspace.the-current-model-doesn-t-support-images-remove'),
        );
        ctx.setImages(sendImages);
        ctx.setFiles(sendFiles);
        ctx.setMessage(typed);
      } else if (sendImages.length && ctx.onSend && ctx.busyOverride !== undefined) {
        ctx.onSend(trimmedMessage, sendImages);
      } else if (sendImages.length) {
        await ctx.actions.sendStreamMessage(trimmedMessage, sendImages);
      } else if (ctx.onSend) {
        ctx.onSend(trimmedMessage);
      } else if (ctx.kbMode && ctx.kbAvailable) {
        await ctx.actions.askKnowledge(trimmedMessage);
      } else {
        // 默认使用流式消息
        await ctx.actions.sendStreamMessage(trimmedMessage);
      }
    } catch (error) {
      log.error('发送消息失败:', error);
    }
  };
}
