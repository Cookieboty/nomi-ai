/**
 * 看板娘窗口的宿主操作（契约 `window.*`，见 host/contract/mascot.ts）：退出、置顶、移动 / 定位、
 * 读光标，以及从看板娘打开对话窗口的某个面板（原 `WindowIpcHandler` 的 quit-app、move-window、
 * open-ai-chat 等通道，P1b 起只经契约）。
 */

import { type ILoggerService } from '@nomi-ai/core/services/LoggerService';
import { app, screen } from 'electron';

import { type IWindowManager } from '../core/WindowManager';

/** type 而不是 interface：要能赋给契约的 loose 输出（带索引签名） */
export type OpenResult = { success: boolean; error?: string };

const failure = (error: unknown): OpenResult => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
});

export class MascotWindowActions {
  constructor(
    private readonly logger: ILoggerService,
    private readonly windowManager: IWindowManager,
  ) {}

  /** 退出应用 */
  quitApp(): void {
    this.logger.info('收到退出应用请求');
    app.quit();
  }

  /** 看板娘窗口置顶 */
  setAlwaysOnTop(flag: boolean): void {
    this.windowManager.setAlwaysOnTop('main', flag);
    this.logger.debug('设置窗口置顶', { flag });
  }

  /** 打开 AI 对话窗口；失败时返回错误信封（看板娘据此提示） */
  async openAiChat(): Promise<OpenResult> {
    try {
      await this.windowManager.createAiChatWindow();
      return { success: true };
    } catch (error) {
      this.logger.error('创建AI对话窗口失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failure(error);
    }
  }

  /** 看板娘「任务看板」：打开对话窗口并切到「知识 · 记忆 · 日程」的日程页 */
  async openTaskBoard(): Promise<OpenResult> {
    try {
      await this.windowManager.openProviderPanel('nav.scheduleRequested');
      return { success: true };
    } catch (error) {
      this.logger.error('打开任务看板失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failure(error);
    }
  }

  /** 看板娘「TTS 语音配置」/ 语音错误「去设置」：打开对话窗口的「设置 → 语音与屏幕 → 语音」 */
  async openVoiceSettings(): Promise<OpenResult> {
    try {
      await this.windowManager.openProviderPanel('nav.voiceSettingsRequested');
      return { success: true };
    } catch (error) {
      this.logger.error('打开语音设置失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failure(error);
    }
  }

  /** 看板娘窗口按增量移动（取整；0 位移不处理） */
  moveWindow(deltaX: number, deltaY: number): void {
    const mainWindow = this.windowManager.getMainWindow();
    if (!mainWindow) {
      this.logger.warn('主窗口不存在，无法移动');
      return;
    }
    try {
      const dx = Math.round(Number(deltaX) || 0);
      const dy = Math.round(Number(deltaY) || 0);
      if (dx === 0 && dy === 0) return;
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition((x ?? 0) + dx, (y ?? 0) + dy);
    } catch (error) {
      this.logger.error('移动窗口失败', {
        error: error instanceof Error ? error.message : String(error),
        deltaX,
        deltaY,
      });
    }
  }

  /** 看板娘窗口左上角；窗口不存在时为 [0, 0] */
  getPosition(): [number, number] {
    const mainWindow = this.windowManager.getMainWindow();
    if (!mainWindow) return [0, 0];
    const [x, y] = mainWindow.getPosition();
    return [x ?? 0, y ?? 0];
  }

  /** 设置看板娘窗口位置（取整） */
  setPosition(x: number, y: number): void {
    const mainWindow = this.windowManager.getMainWindow();
    if (!mainWindow) {
      this.logger.warn('主窗口不存在，无法设置位置');
      return;
    }
    try {
      mainWindow.setPosition(Math.round(Number(x) || 0), Math.round(Number(y) || 0));
    } catch (error) {
      this.logger.error('设置窗口位置失败', {
        error: error instanceof Error ? error.message : String(error),
        x,
        y,
      });
    }
  }

  /** 系统光标的屏幕坐标；读取失败时为 (0, 0) */
  getCursorPosition(): { x: number; y: number } {
    try {
      const p = screen.getCursorScreenPoint();
      return { x: p.x, y: p.y };
    } catch (error) {
      this.logger.error('获取鼠标位置失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { x: 0, y: 0 };
    }
  }
}
