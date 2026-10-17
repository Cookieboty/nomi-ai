/**
 * IPC处理器基类
 * 提供统一的IPC处理器接口和公共功能
 */

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import { t } from '../../i18n';
import { type ILoggerService } from '../../services/LoggerService';

import { claimIpcChannel, releaseIpcChannel } from './channelRegistry';

export abstract class BaseIpcHandler {
  protected logger: ILoggerService;
  protected registeredHandlers: Set<string> = new Set();

  constructor(logger: ILoggerService) {
    this.logger = logger;
  }

  /**
   * 初始化处理器，注册所有IPC事件
   */
  abstract initialize(): void;

  /**
   * 清理处理器，移除所有IPC事件监听
   */
  cleanup(): void {
    for (const channel of this.registeredHandlers) {
      ipcMain.removeAllListeners(channel);
      // handle() 注册的通道要用 removeHandler 才能移除；否则重新初始化会因重复注册而抛错
      ipcMain.removeHandler?.(channel);
      releaseIpcChannel(channel, this.getName());
    }
    this.registeredHandlers.clear();
    this.logger.info(`${this.constructor.name} 已清理`);
  }

  /**
   * 注册IPC事件处理器（异步）
   */
  protected registerHandler(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ): void {
    // 全局重名检测：与其他 Handler / 服务重名时在启动阶段就抛错
    claimIpcChannel(channel, this.getName());
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        this.logger.debug(`IPC请求: ${channel}`, { args });
        const result = await handler(event, ...args);
        this.logger.debug(`IPC响应: ${channel}`, { success: true });
        return result;
      } catch (error) {
        this.logger.error(`IPC处理失败: ${channel}`, {
          error: error instanceof Error ? error.message : String(error),
          args,
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    });

    this.registeredHandlers.add(channel);
  }

  /**
   * 注册IPC事件监听器（同步）
   */
  protected registerListener(
    channel: string,
    handler: (event: IpcMainEvent, ...args: any[]) => void,
  ): void {
    claimIpcChannel(channel, this.getName());
    ipcMain.on(channel, (event, ...args) => {
      try {
        this.logger.debug(`IPC事件: ${channel}`, { args });
        handler(event, ...args);
      } catch (error) {
        this.logger.error(`IPC事件处理失败: ${channel}`, {
          error: error instanceof Error ? error.message : String(error),
          args,
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });

    this.registeredHandlers.add(channel);
  }

  /**
   * 验证参数
   */
  protected validateArgs(args: any[], requiredCount: number, types?: string[]): void {
    if (args.length < requiredCount) {
      throw new Error(t('参数不足，需要{0}个参数，实际{1}个', requiredCount, args.length));
    }

    if (types) {
      for (let i = 0; i < types.length; i++) {
        const expectedType = types[i];
        const actualType = typeof args[i];
        if (actualType !== expectedType) {
          throw new Error(t('参数{0}类型错误，期望{1}，实际{2}', i, expectedType, actualType));
        }
      }
    }
  }

  /**
   * 包装错误响应
   */
  protected createErrorResponse(error: unknown): { success: false; error: string } {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * 包装成功响应
   */
  protected createSuccessResponse<T>(data?: T): { success: true; data?: T } {
    return {
      success: true,
      ...(data !== undefined && { data }),
    };
  }

  /**
   * 获取处理器名称
   */
  getName(): string {
    return this.constructor.name;
  }

  /**
   * 获取已注册的通道列表
   */
  getRegisteredChannels(): string[] {
    return Array.from(this.registeredHandlers);
  }
}
