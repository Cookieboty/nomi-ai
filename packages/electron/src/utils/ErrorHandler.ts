/**
 * 全局错误处理器 - 统一处理应用中的错误
 * 提供错误分类、日志记录和用户友好提示
 */

import { eventBus } from '@nomi-ai/core/core/EventBus';
import { t } from '@nomi-ai/core/i18n';
import { type ILoggerService } from '@nomi-ai/core/services/LoggerService';
import type { HostPorts } from '@nomi-ai/host-ports';

import { isBrokenStdioError } from './stdioGuard';

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface ErrorContext {
  component?: string;
  action?: string;
  userId?: string;
  sessionId?: string;
  metadata?: any;
}

export interface ErrorInfo {
  id: string;
  message: string;
  stack?: string;
  severity: ErrorSeverity;
  context?: ErrorContext;
  timestamp: number;
  handled: boolean;
}

export interface IErrorHandler {
  handleError(error: Error, context?: ErrorContext): string;
  handleUnhandledRejection(reason: any): void;
  handleUncaughtException(error: Error): void;
  reportError(errorInfo: ErrorInfo): void;
  getErrorHistory(): ErrorInfo[];
  clearErrorHistory(): void;
}

/** 致命错误提示走 dialogs.showError，生产环境退出走 lifecycle.quit */
export type ErrorHandlerPorts = {
  dialogs: Pick<HostPorts['dialogs'], 'showError'>;
  lifecycle: Pick<HostPorts['lifecycle'], 'quit'>;
};

export class GlobalErrorHandler implements IErrorHandler {
  private logger: ILoggerService;
  private readonly ports: ErrorHandlerPorts;
  private errorHistory: ErrorInfo[] = [];
  private maxHistorySize = 100;
  private errorCounter = 0;

  constructor(logger: ILoggerService, ports: ErrorHandlerPorts) {
    this.logger = logger;
    this.ports = ports;
    this.setupGlobalHandlers();
  }

  /**
   * 处理一般错误
   */
  handleError(error: Error, context?: ErrorContext): string {
    const errorInfo = this.createErrorInfo(error, context, ErrorSeverity.MEDIUM, true);
    this.recordError(errorInfo);

    // 根据错误严重程度决定处理方式
    switch (errorInfo.severity) {
      case ErrorSeverity.CRITICAL:
        this.handleCriticalError(errorInfo);
        break;
      case ErrorSeverity.HIGH:
        this.handleHighError(errorInfo);
        break;
      case ErrorSeverity.MEDIUM:
        this.handleMediumError(errorInfo);
        break;
      case ErrorSeverity.LOW:
        this.handleLowError(errorInfo);
        break;
    }

    return errorInfo.id;
  }

  /**
   * 处理未处理的Promise拒绝
   */
  handleUnhandledRejection(reason: any): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const errorInfo = this.createErrorInfo(
      error,
      { component: 'unhandledRejection' },
      ErrorSeverity.HIGH,
      false,
    );

    this.recordError(errorInfo);
    this.logger.error('未处理的Promise拒绝', {
      errorId: errorInfo.id,
      reason: reason,
    });

    // 发送到渲染进程（如果需要）
    eventBus.emit('error:unhandledRejection', errorInfo);
  }

  /**
   * 处理未捕获的异常
   */
  handleUncaughtException(error: Error): void {
    // 终端断开后控制台写入失败（EIO / EPIPE）：只是丢了一行控制台输出，不是应用错误
    if (isBrokenStdioError(error)) return;
    const errorInfo = this.createErrorInfo(
      error,
      { component: 'uncaughtException' },
      ErrorSeverity.CRITICAL,
      false,
    );

    this.recordError(errorInfo);
    this.logger.error('未捕获的异常', {
      errorId: errorInfo.id,
      error: error.message,
      stack: error.stack,
    });

    // 关键错误，显示错误对话框
    this.showCriticalErrorDialog(errorInfo);

    // 在生产环境中退出应用
    if (process.env.NODE_ENV === 'production') {
      setTimeout(() => {
        this.ports.lifecycle.quit();
      }, 5000);
    }
  }

  /**
   * 上报错误信息
   */
  reportError(errorInfo: ErrorInfo): void {
    this.recordError(errorInfo);

    // 这里可以集成错误上报服务，如Sentry、Bugsnag等
    this.logger.info('错误已上报', { errorId: errorInfo.id });
  }

  /**
   * 获取错误历史
   */
  getErrorHistory(): ErrorInfo[] {
    return [...this.errorHistory];
  }

  /**
   * 清空错误历史
   */
  clearErrorHistory(): void {
    this.errorHistory = [];
    this.logger.info('错误历史已清空');
  }

  /**
   * 创建错误信息对象
   */
  private createErrorInfo(
    error: Error,
    context?: ErrorContext,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    handled: boolean = true,
  ): ErrorInfo {
    return {
      id: this.generateErrorId(),
      message: error.message,
      stack: error.stack,
      severity,
      context,
      timestamp: Date.now(),
      handled,
    };
  }

  /**
   * 记录错误
   */
  private recordError(errorInfo: ErrorInfo): void {
    // 添加到历史记录
    this.errorHistory.unshift(errorInfo);

    // 保持历史记录大小
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory = this.errorHistory.slice(0, this.maxHistorySize);
    }

    // 记录日志
    this.logger.error('错误记录', {
      errorId: errorInfo.id,
      message: errorInfo.message,
      severity: errorInfo.severity,
      context: errorInfo.context,
      handled: errorInfo.handled,
    });

    // 发送事件
    eventBus.emit('error:recorded', errorInfo);
  }

  /**
   * 处理关键错误
   */
  private handleCriticalError(errorInfo: ErrorInfo): void {
    this.showCriticalErrorDialog(errorInfo);
    eventBus.emit('error:critical', errorInfo);
  }

  /**
   * 处理高级别错误
   */
  private handleHighError(errorInfo: ErrorInfo): void {
    this.showErrorNotification(errorInfo);
    eventBus.emit('error:high', errorInfo);
  }

  /**
   * 处理中级错误
   */
  private handleMediumError(errorInfo: ErrorInfo): void {
    // 可以选择性显示通知
    eventBus.emit('error:medium', errorInfo);
  }

  /**
   * 处理低级错误
   */
  private handleLowError(errorInfo: ErrorInfo): void {
    // 仅记录日志，不显示用户界面
    eventBus.emit('error:low', errorInfo);
  }

  /**
   * 显示关键错误对话框
   */
  private showCriticalErrorDialog(errorInfo: ErrorInfo): void {
    try {
      this.ports.dialogs.showError(
        t('electron.common.app-error'),
        t('electron.common.the-app-hit-a-serious-error-and-will', errorInfo.message, errorInfo.id),
      );
    } catch (error) {
      console.error('显示错误对话框失败:', error);
    }
  }

  /**
   * 显示错误通知
   */
  private showErrorNotification(errorInfo: ErrorInfo): void {
    try {
      // 发送到渲染进程显示通知
      eventBus.emit('notification:show', {
        type: 'error',
        title: t('electron.common.operation-failed'),
        message: this.getUserFriendlyMessage(errorInfo.message),
        timeout: 5000,
      });
    } catch (error) {
      console.error('显示错误通知失败:', error);
    }
  }

  /**
   * 获取用户友好的错误消息
   */
  private getUserFriendlyMessage(errorMessage: string): string {
    // 错误消息映射表
    const messageMap: { [key: string]: string } = {
      ENOENT: t('electron.common.file-or-folder-doesn-t-exist'),
      EACCES: t('electron.common.permission-denied'),
      ECONNREFUSED: t('electron.common.network-connection-refused'),
      ETIMEDOUT: t('electron.common.operation-timed-out'),
      ENOTFOUND: t('electron.common.network-address-not-found'),
    };

    // 查找匹配的友好消息
    for (const [code, friendlyMessage] of Object.entries(messageMap)) {
      if (errorMessage.includes(code)) {
        return friendlyMessage;
      }
    }

    // 如果没有找到映射，返回简化的错误消息
    return errorMessage.split('\n')[0]; // 只返回第一行
  }

  /**
   * 生成错误ID
   */
  private generateErrorId(): string {
    return `ERR_${Date.now()}_${++this.errorCounter}`;
  }

  /**
   * 设置全局错误处理程序
   */
  private setupGlobalHandlers(): void {
    // 处理未捕获的异常
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', (error) => {
      this.handleUncaughtException(error);
    });

    // 处理未处理的Promise拒绝
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason) => {
      this.handleUnhandledRejection(reason);
    });

    this.logger.info('全局错误处理器已设置');
  }

  /**
   * 获取错误统计信息
   */
  getErrorStats(): { [key in ErrorSeverity]: number } & { total: number } {
    const stats = {
      [ErrorSeverity.LOW]: 0,
      [ErrorSeverity.MEDIUM]: 0,
      [ErrorSeverity.HIGH]: 0,
      [ErrorSeverity.CRITICAL]: 0,
      total: this.errorHistory.length,
    };

    for (const error of this.errorHistory) {
      stats[error.severity]++;
    }

    return stats;
  }

  /**
   * 检查应用健康状态
   */
  getHealthStatus(): { healthy: boolean; issues: string[] } {
    const stats = this.getErrorStats();
    const issues: string[] = [];

    // 检查关键错误
    if (stats.critical > 0) {
      issues.push(t('electron.common.critical-errors-detected', stats.critical));
    }

    // 检查高级错误频率
    const recentHighErrors = this.errorHistory.filter(
      (e) => e.severity === ErrorSeverity.HIGH && Date.now() - e.timestamp < 5 * 60 * 1000, // 5分钟内
    ).length;

    if (recentHighErrors > 5) {
      issues.push(
        t('electron.common.high-severity-errors-in-the-last-5-minutes', recentHighErrors),
      );
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  /**
   * 销毁错误处理器
   */
  destroy(): void {
    this.clearErrorHistory();
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    this.logger.info('全局错误处理器已销毁');
  }
}
