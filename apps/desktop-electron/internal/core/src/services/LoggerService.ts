/* eslint-disable no-console -- LoggerService：集中日志实现 */
/**
 * 日志服务 - 提供分级日志功能
 * 支持控制台输出和文件输出
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HostPorts } from '@nomi-ai/host-ports';

import { redact } from '../utils/redact';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  meta?: any;
  context?: string;
}

export interface ILoggerService {
  error(message: string, meta?: any, context?: string): void;
  warn(message: string, meta?: any, context?: string): void;
  info(message: string, meta?: any, context?: string): void;
  debug(message: string, meta?: any, context?: string): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}

export interface LoggerServiceDeps {
  /** 日志目录来自 paths.logs()；打包产物降噪看 app.isPackaged() */
  ports: Pick<HostPorts, 'paths' | 'app'>;
}

export class LoggerService implements ILoggerService {
  private readonly appInfo: LoggerServiceDeps['ports']['app'];
  private level: LogLevel = LogLevel.INFO;
  private logDir: string;
  private logFile: string;
  private maxLogSize = 10 * 1024 * 1024; // 10MB
  private maxLogFiles = 5;
  /**
   * 写盘缓冲：原来每条日志都同步 existsSync ×2 + statSync + appendFileSync，流式对话时日志密集，
   * 直接卡主进程。现在攒一批（FLUSH_MS）异步追加，错误级别立即写；文件大小在内存里累计，用于轮转；
   * 进程退出时把剩下的同步写完。
   */
  private pending: string[] = [];
  private fileSize = -1;
  private writing = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private dirReady = false;
  private static readonly FLUSH_MS = 100;

  constructor(deps: LoggerServiceDeps) {
    this.appInfo = deps.ports.app;
    this.logDir = deps.ports.paths.logs();
    this.logFile = path.join(this.logDir, 'app.log');
    this.ensureLogDirectory();
    process.once('exit', () => this.flushSync());
  }

  /**
   * 记录错误日志
   */
  error(message: string, meta?: any, context?: string): void {
    this.log(LogLevel.ERROR, message, meta, context);
  }

  /**
   * 记录警告日志
   */
  warn(message: string, meta?: any, context?: string): void {
    this.log(LogLevel.WARN, message, meta, context);
  }

  /**
   * 记录信息日志
   */
  info(message: string, meta?: any, context?: string): void {
    this.log(LogLevel.INFO, message, meta, context);
  }

  /**
   * 记录调试日志
   */
  debug(message: string, meta?: any, context?: string): void {
    this.log(LogLevel.DEBUG, message, meta, context);
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * 获取当前日志级别
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * 内部日志记录方法
   */
  private log(level: LogLevel, message: string, meta?: any, context?: string): void {
    if (level > this.level) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta: meta === undefined ? undefined : redact(meta),
      context,
    };

    // 控制台输出
    this.logToConsole(entry);

    // 文件输出
    this.logToFile(entry);
  }

  /**
   * 输出到控制台
   */
  private logToConsole(entry: LogEntry): void {
    // 打包后控制台只输出 WARN / ERROR（INFO / DEBUG 仍写入日志文件）；NOMI_DEBUG=1 可恢复
    if (entry.level > LogLevel.WARN && this.appInfo.isPackaged() && process.env.NOMI_DEBUG !== '1')
      return;
    const levelName = LogLevel[entry.level];
    const contextStr = entry.context ? `[${entry.context}] ` : '';
    const metaStr = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';

    const message = `${entry.timestamp} ${levelName} ${contextStr}${entry.message}${metaStr}`;

    switch (entry.level) {
      case LogLevel.ERROR:
        console.error(message);
        break;
      case LogLevel.WARN:
        console.warn(message);
        break;
      case LogLevel.INFO:
        console.info(message);
        break;
      case LogLevel.DEBUG:
        console.debug(message);
        break;
    }
  }

  /**
   * 输出到文件（缓冲 + 异步批量追加）
   */
  private logToFile(entry: LogEntry): void {
    try {
      this.pending.push(JSON.stringify(entry) + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error);
      return;
    }
    if (entry.level === LogLevel.ERROR) this.scheduleFlush(0);
    else this.scheduleFlush(LoggerService.FLUSH_MS);
  }

  private scheduleFlush(ms: number): void {
    if (this.flushTimer) {
      if (ms > 0) return;
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, ms);
    this.flushTimer.unref?.();
  }

  /** 取出缓冲并在需要时先轮转；返回要写的内容（没有则 null） */
  private takeBatch(): string | null {
    if (!this.pending.length) return null;
    if (!this.dirReady) this.ensureLogDirectory();
    const batch = this.pending.join('');
    this.pending = [];
    if (this.fileSize < 0) {
      try {
        this.fileSize = fs.existsSync(this.logFile) ? fs.statSync(this.logFile).size : 0;
      } catch {
        this.fileSize = 0;
      }
    }
    if (this.fileSize > this.maxLogSize) {
      this.rotateLogFile();
      this.fileSize = 0;
    }
    return batch;
  }

  /** 异步写出缓冲（同一时间只有一次写入在途，写完若又有新日志就接着写） */
  flush(): void {
    if (this.writing) return;
    const batch = this.takeBatch();
    if (batch === null) return;
    this.writing = true;
    const done = (error: NodeJS.ErrnoException | null) => {
      this.writing = false;
      if (error) console.error('Failed to write to log file:', error);
      else this.fileSize += Buffer.byteLength(batch);
      if (this.pending.length) this.scheduleFlush(0);
    };
    fs.appendFile(this.logFile, batch, (error) => {
      // 运行中日志目录被删了：重建后再试一次
      if (error?.code === 'ENOENT') {
        this.ensureLogDirectory();
        this.fileSize = 0;
        fs.appendFile(this.logFile, batch, done);
        return;
      }
      done(error);
    });
  }

  /** 同步写出缓冲（进程退出 / 测试） */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.takeBatch();
    if (batch === null) return;
    try {
      fs.appendFileSync(this.logFile, batch);
      this.fileSize += Buffer.byteLength(batch);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  /**
   * 确保日志目录存在
   */
  private ensureLogDirectory(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      this.dirReady = true;
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  /**
   * 日志文件轮转
   */
  private rotateLogFile(): void {
    try {
      // 删除最老的日志文件
      const oldestLog = path.join(this.logDir, `app.${this.maxLogFiles - 1}.log`);
      if (fs.existsSync(oldestLog)) {
        fs.unlinkSync(oldestLog);
      }

      // 重命名现有日志文件
      for (let i = this.maxLogFiles - 2; i >= 0; i--) {
        const currentFile = i === 0 ? this.logFile : path.join(this.logDir, `app.${i}.log`);
        const newFile = path.join(this.logDir, `app.${i + 1}.log`);

        if (fs.existsSync(currentFile)) {
          fs.renameSync(currentFile, newFile);
        }
      }
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  /**
   * 获取日志文件路径
   */
  getLogFilePath(): string {
    return this.logFile;
  }

  /**
   * 清理旧日志文件
   */
  cleanOldLogs(daysToKeep: number = 7): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

      files.forEach((file) => {
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);

        if (stats.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          this.info(`Cleaned old log file: ${file}`);
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.error('Failed to clean old logs', { error: errorMessage });
    }
  }
}
