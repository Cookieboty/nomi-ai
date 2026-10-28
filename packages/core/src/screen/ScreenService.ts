/**
 * 图片发送前的检查：对话里粘贴 / 拖入的图片发给模型之前，渲染层调用 `ai:screen:check-send`，
 * 走 PermissionBroker 的云端告知 / 仅本地模式。
 *
 * 截图提问（框选截图、全局快捷键）与屏幕记忆（定时截屏 + OCR）已在 v2.0.4 移除；
 * 启动时清掉旧版本留下的屏幕记录、缩略图与截图快捷键设置。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { DesktopService } from '../desktop/DesktopService';
import { t } from '../i18n';

interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
}

export interface ScreenDeps {
  /** 旧版本的 userData/screen-memory 目录 */
  root: string;
  logger: Logger;
  desktop: DesktopService;
}

export class ScreenService {
  /** 启动时清理旧数据的异步任务（测试可 await） */
  readonly legacyPurged: Promise<void>;

  constructor(private readonly d: ScreenDeps) {
    this.legacyPurged = this.purgeLegacy();
  }

  /** 旧版本的屏幕记忆与截图设置：功能已移除，不再留在磁盘上 */
  // 异步删除：旧截图目录可能很大，不在主进程启动路径上做同步 IO
  private purgeLegacy(): Promise<void> {
    return fs.promises.rm(this.d.root, { recursive: true, force: true }).then(
      () => undefined,
      (err) => this.d.logger.warn('清理旧屏幕记忆失败', String(err)),
    );
  }

  /** 发送图片前：云端告知 / 仅本地模式（契约 screen.checkSend） */
  async checkSend(): Promise<'ok' | 'local_only' | 'user_denied'> {
    const r = await this.d.desktop.broker.checkSend(
      this.d.desktop.providerFor('chat'),
      undefined,
      t('electron.common.images-attached'),
    );
    return r ?? 'ok';
  }
}

let inst: ScreenService | null = null;
export function initScreenService(d: ScreenDeps): ScreenService {
  inst = new ScreenService(d);
  return inst;
}
