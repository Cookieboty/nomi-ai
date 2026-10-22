const { pathsToModuleNameMapper } = require('ts-jest');

const { compilerOptions } = require('./tsconfig.json');

module.exports = {
  // 基础配置
  preset: 'ts-jest',
  testEnvironment: 'node',

  // 源码目录
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  // 测试文件匹配模式
  testMatch: [
    '**/tests/**/*.test.ts',
    '**/src/**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts',
  ],

  // TypeScript配置
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          // TypeScript 6 起 types 默认为 []，测试需显式引入 node / jest 全局类型
          types: ['node', 'jest'],
        },
      },
    ],
  },

  // 模块路径映射
  moduleNameMapper: {
    ...pathsToModuleNameMapper(compilerOptions.paths || {}, {
      prefix: '<rootDir>/',
    }),
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
  },

  // 覆盖率配置
  collectCoverage: true,
  // 独立启动器通过函数序列化在子进程执行；插桩会引入无法序列化的覆盖率闭包。
  coveragePathIgnorePatterns: ['/src/gateway/windowsTerminal.ts$'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/main.ts',
    '!src/main-new.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts',
  ],
  coverageThreshold: {
    // TODO(P8): electron 遗留代码大量缺测，先放宽阈值，待 P8 消费方迁移时统一补齐
    global: {
      branches: 0,
      functions: 0,
      lines: 0,
      statements: 0,
    },
  },

  // 测试设置
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],

  // 模块文件扩展名
  moduleFileExtensions: ['ts', 'js', 'json'],

  // 清除模拟
  clearMocks: true,
  restoreMocks: true,

  // 测试超时
  testTimeout: 10000,

  // 详细输出
  verbose: true,

  // 禁用 watchman（沙箱 / 无 watchman 环境不可用；CI 上 fs 巡检足够）
  watchman: false,

  // Electron特定配置
  testEnvironmentOptions: {
    // 模拟Electron环境
    url: 'file://test',
  },

  // 忽略模式
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/coverage/'],
};
