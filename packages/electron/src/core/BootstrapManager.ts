/**
 * 启动管理器 - 优化应用启动流程
 * 实现延迟加载、异步初始化和启动性能监控
 */

import { t as tr } from '../i18n';
import { type ILoggerService } from '../services/LoggerService';

import { eventBus } from './EventBus';

export interface BootstrapTask {
  name: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  delay?: number; // 延迟执行时间（毫秒）
  execute: () => Promise<void>;
  dependencies?: string[]; // 依赖的任务名称
  timeout?: number; // 超时时间
}

export interface BootstrapMetrics {
  totalStartTime: number;
  totalEndTime: number;
  totalDuration: number;
  taskMetrics: Array<{
    name: string;
    startTime: number;
    endTime: number;
    duration: number;
    success: boolean;
    error?: string;
  }>;
}

export interface IBootstrapManager {
  addTask(task: BootstrapTask): void;
  removeTask(name: string): boolean;
  start(): Promise<BootstrapMetrics>;
  getMetrics(): BootstrapMetrics | null;
}

export class BootstrapManager implements IBootstrapManager {
  private tasks = new Map<string, BootstrapTask>();
  private completedTasks = new Set<string>();
  private runningTasks = new Set<string>();
  private metrics: BootstrapMetrics | null = null;
  private logger: ILoggerService;

  constructor(logger: ILoggerService) {
    this.logger = logger;
  }

  /**
   * 添加启动任务
   */
  addTask(task: BootstrapTask): void {
    if (this.tasks.has(task.name)) {
      this.logger.warn(`启动任务已存在，将被替换: ${task.name}`);
    }

    this.tasks.set(task.name, task);
    this.logger.debug(`启动任务已添加: ${task.name}`, {
      priority: task.priority,
      delay: task.delay,
      dependencies: task.dependencies,
    });
  }

  /**
   * 移除启动任务
   */
  removeTask(name: string): boolean {
    const removed = this.tasks.delete(name);
    if (removed) {
      this.logger.debug(`启动任务已移除: ${name}`);
    } else {
      this.logger.warn(`尝试移除不存在的启动任务: ${name}`);
    }
    return removed;
  }

  /**
   * 开始执行启动任务
   */
  async start(): Promise<BootstrapMetrics> {
    const startTime = Date.now();
    this.logger.info('开始执行启动任务序列...', { taskCount: this.tasks.size });

    this.metrics = {
      totalStartTime: startTime,
      totalEndTime: 0,
      totalDuration: 0,
      taskMetrics: [],
    };

    try {
      // 按优先级排序任务
      const sortedTasks = this.sortTasksByPriority();

      // 分批执行任务
      await this.executeCriticalTasks(sortedTasks.critical);
      await this.executeHighPriorityTasks(sortedTasks.high);

      // 异步执行低优先级任务
      this.executeMediumAndLowPriorityTasks(sortedTasks.medium, sortedTasks.low);

      const endTime = Date.now();
      this.metrics.totalEndTime = endTime;
      this.metrics.totalDuration = endTime - startTime;

      this.logger.info('关键启动任务执行完成', {
        duration: this.metrics.totalDuration,
        successfulTasks: this.completedTasks.size,
        totalTasks: this.tasks.size,
      });

      eventBus.emit('bootstrap:critical-complete', this.metrics);
      return this.metrics;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('启动任务执行失败', { error: errorMessage });
      throw error;
    }
  }

  /**
   * 获取启动指标
   */
  getMetrics(): BootstrapMetrics | null {
    return this.metrics;
  }

  /**
   * 按优先级排序任务
   */
  private sortTasksByPriority(): {
    critical: BootstrapTask[];
    high: BootstrapTask[];
    medium: BootstrapTask[];
    low: BootstrapTask[];
  } {
    const result = {
      critical: [] as BootstrapTask[],
      high: [] as BootstrapTask[],
      medium: [] as BootstrapTask[],
      low: [] as BootstrapTask[],
    };

    for (const task of this.tasks.values()) {
      result[task.priority].push(task);
    }

    return result;
  }

  /**
   * 执行关键任务（同步阻塞）
   */
  private async executeCriticalTasks(tasks: BootstrapTask[]): Promise<void> {
    this.logger.info('执行关键启动任务...', { count: tasks.length });

    for (const task of tasks) {
      await this.executeTask(task);
    }
  }

  /**
   * 执行高优先级任务（有序异步）
   */
  private async executeHighPriorityTasks(tasks: BootstrapTask[]): Promise<void> {
    this.logger.info('执行高优先级启动任务...', { count: tasks.length });

    // 并行执行没有依赖的任务
    const independentTasks = tasks.filter(
      (task) => !task.dependencies || task.dependencies.length === 0,
    );
    const dependentTasks = tasks.filter(
      (task) => task.dependencies && task.dependencies.length > 0,
    );

    // 先执行独立任务
    await Promise.all(independentTasks.map((task) => this.executeTask(task)));

    // 再执行有依赖的任务
    for (const task of dependentTasks) {
      await this.executeTask(task);
    }
  }

  /**
   * 异步执行中低优先级任务
   */
  private executeMediumAndLowPriorityTasks(
    mediumTasks: BootstrapTask[],
    lowTasks: BootstrapTask[],
  ): void {
    this.logger.info('异步执行中低优先级任务...', {
      mediumCount: mediumTasks.length,
      lowCount: lowTasks.length,
    });

    // 延迟执行中优先级任务
    setTimeout(async () => {
      try {
        await Promise.all(mediumTasks.map((task) => this.executeTask(task)));
        this.logger.info('中优先级任务执行完成');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('中优先级任务执行失败', { error: errorMessage });
      }
    }, 100);

    // 更长延迟执行低优先级任务
    setTimeout(async () => {
      try {
        for (const task of lowTasks) {
          await this.executeTask(task);
          // 低优先级任务之间增加间隔，避免影响性能
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        this.logger.info('低优先级任务执行完成');
        eventBus.emit('bootstrap:all-complete', this.metrics);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('低优先级任务执行失败', { error: errorMessage });
      }
    }, 1000);
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: BootstrapTask): Promise<void> {
    const taskStartTime = Date.now();

    try {
      // 检查依赖
      if (task.dependencies) {
        for (const dep of task.dependencies) {
          if (!this.completedTasks.has(dep)) {
            throw new Error(tr('electron.common.dependency-task-not-finished', dep));
          }
        }
      }

      // 检查是否已在运行
      if (this.runningTasks.has(task.name)) {
        this.logger.warn(`任务已在运行中: ${task.name}`);
        return;
      }

      this.runningTasks.add(task.name);
      this.logger.debug(`开始执行启动任务: ${task.name}`);

      // 应用延迟
      if (task.delay && task.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, task.delay));
      }

      // 执行任务（带超时）
      if (task.timeout) {
        await Promise.race([
          task.execute(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(tr('electron.common.task-timed-out', task.name))),
              task.timeout,
            ),
          ),
        ]);
      } else {
        await task.execute();
      }

      const taskEndTime = Date.now();
      const duration = taskEndTime - taskStartTime;

      this.completedTasks.add(task.name);
      this.runningTasks.delete(task.name);

      // 记录任务指标
      this.metrics?.taskMetrics.push({
        name: task.name,
        startTime: taskStartTime,
        endTime: taskEndTime,
        duration,
        success: true,
      });

      this.logger.info(`启动任务执行成功: ${task.name}`, { duration: `${duration}ms` });
      eventBus.emit('bootstrap:task-complete', { name: task.name, duration });
    } catch (error) {
      const taskEndTime = Date.now();
      const duration = taskEndTime - taskStartTime;

      this.runningTasks.delete(task.name);

      // 记录失败的任务指标
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.metrics?.taskMetrics.push({
        name: task.name,
        startTime: taskStartTime,
        endTime: taskEndTime,
        duration,
        success: false,
        error: errorMessage,
      });

      this.logger.error(`启动任务执行失败: ${task.name}`, {
        error: errorMessage,
        duration: `${duration}ms`,
      });

      eventBus.emit('bootstrap:task-error', { name: task.name, error: errorMessage });

      // 关键和高优先级任务失败时抛出错误
      if (task.priority === 'critical' || task.priority === 'high') {
        throw error;
      }
    }
  }

  /**
   * 获取启动性能报告
   */
  getPerformanceReport(): {
    overview: {
      totalDuration: number;
      taskCount: number;
      successCount: number;
      failureCount: number;
    };
    slowestTasks: Array<{ name: string; duration: number }>;
    failedTasks: Array<{ name: string; error: string }>;
  } | null {
    if (!this.metrics) {
      return null;
    }

    const successfulTasks = this.metrics.taskMetrics.filter((t) => t.success);
    const failedTasks = this.metrics.taskMetrics.filter((t) => !t.success);

    const slowestTasks = [...this.metrics.taskMetrics]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5)
      .map((t) => ({ name: t.name, duration: t.duration }));

    return {
      overview: {
        totalDuration: this.metrics.totalDuration,
        taskCount: this.metrics.taskMetrics.length,
        successCount: successfulTasks.length,
        failureCount: failedTasks.length,
      },
      slowestTasks,
      failedTasks: failedTasks.map((t) => ({
        name: t.name,
        error: t.error || 'Unknown error',
      })),
    };
  }

  /**
   * 重置管理器状态
   */
  reset(): void {
    this.completedTasks.clear();
    this.runningTasks.clear();
    this.metrics = null;
    this.logger.debug('启动管理器已重置');
  }

  /**
   * 获取任务状态
   */
  getTaskStatus(): {
    total: number;
    completed: number;
    running: number;
    pending: number;
  } {
    return {
      total: this.tasks.size,
      completed: this.completedTasks.size,
      running: this.runningTasks.size,
      pending: this.tasks.size - this.completedTasks.size - this.runningTasks.size,
    };
  }
}
