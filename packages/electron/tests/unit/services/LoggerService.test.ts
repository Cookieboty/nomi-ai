/**
 * LoggerService单元测试
 */

import * as fs from 'fs';
import * as path from 'path';

import { LoggerService, LogLevel } from '../../../src/services/LoggerService';
import { testUtils } from '../../setup';

// 模拟app模块
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/tmp/test-logs'),
  },
}));

describe('LoggerService', () => {
  let loggerService: LoggerService;
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(() => {
    jest.clearAllMocks();
    // 复位 fs mock，避免上一 test 的 mockImplementation 泄漏
    mockFs.existsSync.mockReturnValue(true);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.appendFileSync.mockImplementation(() => undefined);
    mockFs.renameSync.mockImplementation(() => undefined);
    mockFs.statSync.mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 1024,
      mtime: new Date(),
      ctime: new Date(),
      atime: new Date(),
    } as any);
    testUtils.silenceConsole();
    loggerService = new LoggerService();
  });

  afterEach(() => {
    testUtils.restoreConsole();
  });

  describe('基本功能', () => {
    test('应该创建LoggerService实例', () => {
      expect(loggerService).toBeInstanceOf(LoggerService);
    });

    test('应该设置和获取日志级别', () => {
      loggerService.setLevel(LogLevel.DEBUG);
      expect(loggerService.getLevel()).toBe(LogLevel.DEBUG);

      loggerService.setLevel(LogLevel.ERROR);
      expect(loggerService.getLevel()).toBe(LogLevel.ERROR);
    });

    test('应该根据日志级别过滤消息', () => {
      const consoleSpy = jest.spyOn(console, 'debug');

      // 设置为INFO级别，DEBUG消息应该被过滤
      loggerService.setLevel(LogLevel.INFO);
      loggerService.debug('debug message');
      expect(consoleSpy).not.toHaveBeenCalled();

      // INFO消息应该被记录
      const infoSpy = jest.spyOn(console, 'info');
      loggerService.info('info message');
      expect(infoSpy).toHaveBeenCalled();
    });
  });

  describe('日志记录', () => {
    test('应该记录错误消息', () => {
      const errorSpy = jest.spyOn(console, 'error');
      loggerService.error('error message', { key: 'value' }, 'TestContext');

      expect(errorSpy).toHaveBeenCalled();
      const callArgs = errorSpy.mock.calls[0][0];
      expect(callArgs).toContain('ERROR');
      expect(callArgs).toContain('error message');
    });

    test('应该记录警告消息', () => {
      const warnSpy = jest.spyOn(console, 'warn');
      loggerService.warn('warning message');

      expect(warnSpy).toHaveBeenCalled();
    });

    test('应该记录信息消息', () => {
      const infoSpy = jest.spyOn(console, 'info');
      loggerService.info('info message');

      expect(infoSpy).toHaveBeenCalled();
    });

    test('应该记录调试消息', () => {
      loggerService.setLevel(LogLevel.DEBUG);
      const debugSpy = jest.spyOn(console, 'debug');
      loggerService.debug('debug message');

      expect(debugSpy).toHaveBeenCalled();
    });
  });

  describe('文件输出', () => {
    test('应该写入日志文件', () => {
      loggerService.info('test message');
      loggerService.flushSync();

      expect(mockFs.appendFileSync).toHaveBeenCalled();
      const writeCall = (mockFs.appendFileSync as jest.Mock).mock.calls[0];
      const logData = JSON.parse(writeCall[1]);

      expect(logData.message).toBe('test message');
      expect(logData.level).toBe(LogLevel.INFO);
      expect(logData.timestamp).toBeDefined();
    });

    test('应该处理文件写入错误', () => {
      mockFs.appendFileSync.mockImplementation(() => {
        throw new Error('File write error');
      });

      const errorSpy = jest.spyOn(console, 'error');
      loggerService.info('test message');
      loggerService.flushSync();

      expect(errorSpy).toHaveBeenCalledWith('Failed to write to log file:', expect.any(Error));
    });
  });

  describe('日志轮转', () => {
    test('应该在文件大小超限时进行轮转', () => {
      // 模拟大文件
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({
        size: 15 * 1024 * 1024, // 15MB，超过10MB限制
      } as any);

      loggerService.info('test message');
      loggerService.flushSync();

      // 应该调用文件重命名来进行轮转
      expect(mockFs.renameSync).toHaveBeenCalled();
    });

    test('应该创建日志目录', () => {
      mockFs.existsSync.mockReturnValue(false);

      loggerService = new LoggerService();
      loggerService.info('test message');
      loggerService.flushSync();

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });
  });

  describe('日志清理', () => {
    test('应该清理旧日志文件', () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8天前

      mockFs.readdirSync.mockReturnValue(['app.1.log', 'app.2.log'] as any);
      mockFs.statSync.mockReturnValue({
        mtime: oldDate,
      } as any);

      loggerService.cleanOldLogs(7);

      expect(mockFs.unlinkSync).toHaveBeenCalledTimes(2);
    });

    test('应该保留新日志文件', () => {
      const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1天前

      mockFs.readdirSync.mockReturnValue(['app.1.log'] as any);
      mockFs.statSync.mockReturnValue({
        mtime: newDate,
      } as any);

      loggerService.cleanOldLogs(7);

      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('错误处理', () => {
    test('应该处理日志目录创建失败', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const errorSpy = jest.spyOn(console, 'error');
      loggerService = new LoggerService();
      loggerService.info('test message');
      loggerService.flushSync();

      expect(errorSpy).toHaveBeenCalledWith('Failed to create log directory:', expect.any(Error));
    });

    test('应该处理轮转失败', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 15 * 1024 * 1024 } as any);
      mockFs.renameSync.mockImplementation(() => {
        throw new Error('Rename failed');
      });

      const errorSpy = jest.spyOn(console, 'error');
      loggerService.info('test message');
      loggerService.flushSync();

      expect(errorSpy).toHaveBeenCalledWith('Failed to rotate log file:', expect.any(Error));
    });
  });

  describe('缓冲写入', () => {
    test('多条日志合成一次异步写入，不再逐条同步写盘', () => {
      jest.useFakeTimers();
      try {
        const logger = new LoggerService();
        (mockFs.appendFile as unknown as jest.Mock).mockImplementation(
          (_f: string, _d: string, cb: (e: null) => void) => cb(null),
        );
        logger.info('a');
        logger.info('b');
        logger.warn('c');
        expect(mockFs.appendFileSync).not.toHaveBeenCalled();
        expect(mockFs.appendFile).not.toHaveBeenCalled();
        jest.advanceTimersByTime(150);
        expect(mockFs.appendFile).toHaveBeenCalledTimes(1);
        const data = (mockFs.appendFile as unknown as jest.Mock).mock.calls[0][1] as string;
        expect(
          data
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l).message),
        ).toEqual(['a', 'b', 'c']);
        // 只在第一次写入前 stat 一次
        const stats = (mockFs.statSync as jest.Mock).mock.calls.length;
        logger.info('d');
        jest.advanceTimersByTime(150);
        expect((mockFs.statSync as jest.Mock).mock.calls.length).toBe(stats);
      } finally {
        jest.useRealTimers();
      }
    });

    test('错误日志立即写出', () => {
      jest.useFakeTimers();
      try {
        const logger = new LoggerService();
        logger.error('boom');
        jest.advanceTimersByTime(0);
        expect(mockFs.appendFile).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('性能', () => {
    test('日志记录应该快速完成', () => {
      const startTime = Date.now();

      for (let i = 0; i < 100; i++) {
        loggerService.info(`message ${i}`);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // 应该在1秒内完成
    });
  });
});
