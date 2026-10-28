/**
 * 窗口相关IPC处理器
 * 处理窗口管理、位置、拖拽等相关的IPC通信
 */

import { app, screen } from 'electron';

import { type IWindowManager } from '../../core/WindowManager';
import { type ILoggerService } from '../../services/LoggerService';

import { BaseIpcHandler } from './BaseIpcHandler';

export class WindowIpcHandler extends BaseIpcHandler {
  private windowManager: IWindowManager;

  constructor(logger: ILoggerService, windowManager: IWindowManager) {
    super(logger);
    this.windowManager = windowManager;
  }

  /**
   * 初始化窗口相关IPC处理器
   */
  initialize(): void {
    // 应用控制
    this.registerListener('quit-app', () => this.quitApp());

    // 窗口置顶
    this.registerListener('set-always-on-top', (_, flag: boolean) => {
      this.validateArgs([flag], 1, ['boolean']);
      this.setAlwaysOnTop(flag);
    });

    // 打开AI对话窗口
    this.registerHandler('open-ai-chat', () => this.openAiChat());

    // 看板娘「任务看板」：打开对话窗口并切到「知识 · 记忆 · 日程」的日程页
    this.registerHandler('open-task-board', () => this.openTaskBoard());

    // 看板娘「TTS 语音配置」/ 语音错误「去设置」：打开对话窗口的「设置 → 语音与屏幕 → 语音」
    this.registerHandler('open-voice-settings', () => this.openVoiceSettings());

    // 窗口移动
    this.registerListener('move-window', (_, deltaX: number, deltaY: number) => {
      this.validateArgs([deltaX, deltaY], 2, ['number', 'number']);
      this.moveWindow(deltaX, deltaY);
    });

    // 获取窗口位置
    this.registerHandler('get-position', async () => this.getPosition());

    // 设置窗口位置
    this.registerListener('set-position', (_, x: number, y: number) => {
      this.validateArgs([x, y], 2, ['number', 'number']);
      this.setPosition(x, y);
    });

    // 获取鼠标位置
    this.registerHandler('get-cursor-position', async () => this.getCursorPosition());

    // 获取屏幕信息
    this.registerHandler('get-screen-info', async () => {
      try {
        const display = screen.getPrimaryDisplay();
        const screenInfo = {
          bounds: display.bounds,
          workArea: display.workAreaSize,
          scaleFactor: display.scaleFactor,
          rotation: display.rotation,
        };
        this.logger.debug('获取屏幕信息', { screenInfo });
        return screenInfo;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('获取屏幕信息失败', { error: errorMessage });
        throw error;
      }
    });

    // 最小化窗口
    this.registerListener('minimize-window', (_, windowType: string = 'main') => {
      const window =
        windowType === 'main'
          ? this.windowManager.getMainWindow()
          : this.windowManager.getAiChatWindow();

      if (window) {
        window.minimize();
        this.logger.debug('窗口最小化', { windowType });
      } else {
        this.logger.warn('窗口不存在，无法最小化', { windowType });
      }
    });

    // 恢复窗口
    this.registerListener('restore-window', (_, windowType: string = 'main') => {
      const window =
        windowType === 'main'
          ? this.windowManager.getMainWindow()
          : this.windowManager.getAiChatWindow();

      if (window) {
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
        this.logger.debug('窗口恢复', { windowType });
      } else {
        this.logger.warn('窗口不存在，无法恢复', { windowType });
      }
    });

    // 隐藏窗口
    this.registerListener('hide-window', (_, windowType: string = 'main') => {
      const window =
        windowType === 'main'
          ? this.windowManager.getMainWindow()
          : this.windowManager.getAiChatWindow();

      if (window) {
        window.hide();
        this.logger.debug('窗口隐藏', { windowType });
      } else {
        this.logger.warn('窗口不存在，无法隐藏', { windowType });
      }
    });

    // 显示窗口
    this.registerListener('show-window', (_, windowType: string = 'main') => {
      const window =
        windowType === 'main'
          ? this.windowManager.getMainWindow()
          : this.windowManager.getAiChatWindow();

      if (window) {
        window.show();
        window.focus();
        this.logger.debug('窗口显示', { windowType });
      } else {
        this.logger.warn('窗口不存在，无法显示', { windowType });
      }
    });

    this.logger.info('WindowIpcHandler 初始化完成', {
      registeredChannels: this.getRegisteredChannels().length,
    });
  }

  // —— 看板娘窗口的旧操作（旧 IPC 与契约 host/contract/mascot.ts 共用）

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
  async openAiChat(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.windowManager.createAiChatWindow();
      this.logger.info('AI对话窗口创建成功');
      return this.createSuccessResponse();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('创建AI对话窗口失败', { error: errorMessage });
      return this.createErrorResponse(error);
    }
  }

  /** 看板娘「任务看板」：打开对话窗口并切到「知识 · 记忆 · 日程」的日程页 */
  async openTaskBoard(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.windowManager.openProviderPanel('ai:hub:open-schedule');
      return this.createSuccessResponse();
    } catch (error) {
      this.logger.error('打开任务看板失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createErrorResponse(error);
    }
  }

  /** 看板娘「TTS 语音配置」/ 语音错误「去设置」：打开对话窗口的「设置 → 语音与屏幕 → 语音」 */
  async openVoiceSettings(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.windowManager.openProviderPanel('ai:settings:open-voice');
      return this.createSuccessResponse();
    } catch (error) {
      this.logger.error('打开语音设置失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createErrorResponse(error);
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
      // 确保参数为整数
      const intDeltaX = Math.round(Number(deltaX) || 0);
      const intDeltaY = Math.round(Number(deltaY) || 0);

      // 如果移动距离为0则不处理
      if (intDeltaX === 0 && intDeltaY === 0) return;

      // 获取当前位置并计算新位置
      const [currentX, currentY] = mainWindow.getPosition();
      const newX = currentX + intDeltaX;
      const newY = currentY + intDeltaY;

      // 设置新位置
      mainWindow.setPosition(newX, newY);

      this.logger.debug('窗口移动', {
        from: [currentX, currentY],
        to: [newX, newY],
        delta: [intDeltaX, intDeltaY],
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('移动窗口失败', {
        error: errorMessage,
        deltaX,
        deltaY,
      });
    }
  }

  /** 看板娘窗口左上角；窗口不存在时为 [0, 0] */
  getPosition(): [number, number] {
    const mainWindow = this.windowManager.getMainWindow();
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      this.logger.debug('获取窗口位置', { position: [x, y] });
      return [x ?? 0, y ?? 0];
    }
    return [0, 0];
  }

  /** 设置看板娘窗口位置（取整） */
  setPosition(x: number, y: number): void {
    const mainWindow = this.windowManager.getMainWindow();
    if (!mainWindow) {
      this.logger.warn('主窗口不存在，无法设置位置');
      return;
    }

    try {
      // 验证参数并转换为整数
      const intX = Math.round(Number(x) || 0);
      const intY = Math.round(Number(y) || 0);

      mainWindow.setPosition(intX, intY);
      this.logger.debug('设置窗口位置', { x: intX, y: intY });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('设置窗口位置失败', {
        error: errorMessage,
        x,
        y,
      });
    }
  }

  /** 系统光标的屏幕坐标；读取失败时为 (0, 0) */
  getCursorPosition(): { x: number; y: number } {
    try {
      const cursorPos = screen.getCursorScreenPoint();
      const position = { x: cursorPos.x, y: cursorPos.y };
      this.logger.debug('获取鼠标位置', { position });
      return position;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('获取鼠标位置失败', { error: errorMessage });
      return { x: 0, y: 0 };
    }
  }
}
