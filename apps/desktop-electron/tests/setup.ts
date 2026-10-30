/**
 * Jest测试环境设置
 * 配置全局测试环境和模拟
 */

import type * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 测试的临时目录（mkdtemp(os.tmpdir())）被当作「仓库外」的目录。若 TEMP/TMP 被指到仓库内，
// git 会向上找到本仓库，worktree / .git/info/exclude 写进真实仓库。设 GIT_CEILING_DIRECTORIES
// 让 git 不越过临时目录往上找；测试自己 git init 的目录不受影响。
{
  const tmp = os.tmpdir();
  const ceilings = new Set([path.resolve(tmp)]);
  try {
    // 本文件下面 jest.mock('fs') 会被提到最前面，这里必须拿真实的 fs
    ceilings.add(jest.requireActual<typeof fs>('node:fs').realpathSync.native(tmp));
  } catch {
    /* tmp may not exist yet */
  }
  const prev = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = [...ceilings, ...(prev ? [prev] : [])].join(path.delimiter);
}

// 模拟Electron模块
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((name: string) => {
      switch (name) {
        case 'userData':
          return '/tmp/test-userData';
        case 'temp':
          return '/tmp';
        default:
          return '/tmp/test';
      }
    }),
    getVersion: jest.fn(() => '1.0.0'),
    getName: jest.fn(() => 'Test App'),
    isPackaged: false,
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn(),
    loadFile: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    close: jest.fn(),
    minimize: jest.fn(),
    restore: jest.fn(),
    setPosition: jest.fn(),
    getPosition: jest.fn(() => [0, 0]),
    getBounds: jest.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    setBounds: jest.fn(),
    setAlwaysOnTop: jest.fn(),
    isMinimized: jest.fn(() => false),
    isDestroyed: jest.fn(() => false),
    webContents: {
      send: jest.fn(),
      openDevTools: jest.fn(),
      on: jest.fn(),
    },
    on: jest.fn(),
    once: jest.fn(),
  })),
  screen: {
    getPrimaryDisplay: jest.fn(() => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1040 },
      scaleFactor: 1,
      rotation: 0,
    })),
    getCursorScreenPoint: jest.fn(() => ({ x: 100, y: 100 })),
  },
  dialog: {
    showErrorBox: jest.fn(),
  },
}));

// 模拟文件系统
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(() => ({
    isFile: () => true,
    isDirectory: () => false,
    size: 1024,
    mtime: new Date(),
    ctime: new Date(),
    atime: new Date(),
  })),
  unlinkSync: jest.fn(),
  renameSync: jest.fn(),
  copyFileSync: jest.fn(),
  appendFileSync: jest.fn(),
  appendFile: jest.fn(),
}));

// 模拟path模块
jest.mock('path', () => ({
  join: jest.fn((...args: string[]) => args.join('/')),
  dirname: jest.fn((p: string) => p.split('/').slice(0, -1).join('/')),
  basename: jest.fn((p: string) => p.split('/').pop()),
  extname: jest.fn((p: string) => {
    const parts = p.split('.');
    return parts.length > 1 ? '.' + parts.pop() : '';
  }),
  isAbsolute: jest.fn((p: string) => p.startsWith('/')),
  resolve: jest.fn((...args: string[]) => '/' + args.join('/')),
}));

// 全局测试工具
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(min: number, max: number): R;
      toMatchLogEntry(expected: any): R;
    }
  }
}

// 自定义匹配器
expect.extend({
  toBeWithinRange(received: number, min: number, max: number) {
    const pass = received >= min && received <= max;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${min} - ${max}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${min} - ${max}`,
        pass: false,
      };
    }
  },

  toMatchLogEntry(received: any, expected: any) {
    const pass =
      received.timestamp && received.level !== undefined && received.message === expected.message;

    if (pass) {
      return {
        message: () => `expected log entry not to match`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected log entry to match expected format`,
        pass: false,
      };
    }
  },
});

// 测试环境配置
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

// CLI 配置目录必须由用例显式设置，避免继承开发机 / 编程助手的目录并读取真实配置或日志。
for (const key of [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'GROK_HOME',
  'QWEN_HOME',
  'OPENCODE_HOME',
  'XDG_DATA_HOME',
  'COPILOT_HOME',
  'KIMI_HOME',
  'KIMI_CODE_HOME',
]) {
  delete process.env[key];
}

// 静默控制台输出（测试期间）
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

beforeEach(() => {
  // 重置所有模拟
  jest.clearAllMocks();
});

afterEach(() => {
  // 清理定时器
  jest.clearAllTimers();
});

// 导出测试工具
export const testUtils = {
  createMockLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    setLevel: jest.fn(),
    getLevel: jest.fn(),
    cleanOldLogs: jest.fn(),
  }),

  createMockConfig: () => ({
    windowPosition: { x: 100, y: 100 },
    modelName: 'test-model',
    voiceSettings: {
      enabled: true,
      volume: 0.8,
      timeAnnouncement: true,
      voicePackPath: '/test/voice',
      voiceMode: 'fixed' as const,
    },
    window: {
      position: { x: 100, y: 100 },
      alwaysOnTop: true,
      transparent: true,
    },
    debug: false,
    environment: 'test' as const,
  }),

  waitFor: async (condition: () => boolean, timeout = 1000, interval = 10) => {
    const startTime = Date.now();
    while (!condition() && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    if (!condition()) {
      throw new Error('Wait condition timeout');
    }
  },

  createMockEvent: () => ({
    sender: {
      send: jest.fn(),
    },
  }),

  restoreConsole: () => {
    Object.assign(console, originalConsole);
  },

  silenceConsole: () => {
    Object.assign(console, {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    });
  },
};
