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
    this.registerListener('quit-app', () => {
      this.logger.info('收到退出应用请求');
      app.quit();
    });

    // 窗口置顶
    this.registerListener('set-always-on-top', (_, flag: boolean) => {
      this.validateArgs([flag], 1, ['boolean']);
      this.windowManager.setAlwaysOnTop('main', flag);
      this.logger.debug('设置窗口置顶', { flag });
    });

    // 打开AI对话窗口
    this.registerHandler('open-ai-chat', async () => {
      try {
        await this.windowManager.createAiChatWindow();
        this.logger.info('AI对话窗口创建成功');
        return this.createSuccessResponse();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('创建AI对话窗口失败', { error: errorMessage });
        return this.createErrorResponse(error);
      }
    });

    // 看板娘「任务看板」：打开对话窗口并切到「知识 · 记忆 · 日程」的日程页
    this.registerHandler('open-task-board', async () => {
      try {
        await this.windowManager.openProviderPanel('ai:hub:open-schedule');
        return this.createSuccessResponse();
      } catch (error) {
        this.logger.error('打开任务看板失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // 打开TTS配置窗口
    this.registerHandler('open-tts-config', async () => {
      try {
        await this.windowManager.createTTSConfigWindow();
        this.logger.info('TTS配置窗口创建成功');
        return this.createSuccessResponse();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('创建TTS配置窗口失败', { error: errorMessage });
        return this.createErrorResponse(error);
      }
    });

    // 窗口移动
    this.registerListener('move-window', (_, deltaX: number, deltaY: number) => {
      this.validateArgs([deltaX, deltaY], 2, ['number', 'number']);

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
    });

    // 获取窗口位置
    this.registerHandler('get-position', async () => {
      const mainWindow = this.windowManager.getMainWindow();
      if (mainWindow) {
        const position = mainWindow.getPosition();
        this.logger.debug('获取窗口位置', { position });
        return position;
      }
      return [0, 0];
    });

    // 设置窗口位置
    this.registerListener('set-position', (_, x: number, y: number) => {
      this.validateArgs([x, y], 2, ['number', 'number']);

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
    });

    // 获取鼠标位置
    this.registerHandler('get-cursor-position', async () => {
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
    });

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
}
