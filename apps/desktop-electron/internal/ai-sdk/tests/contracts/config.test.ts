/**
 * AppConfig zod 校验测试：正例 10 条 / 负例 10 条（P5-5 要求）。
 */

import { describe, expect, it } from 'vitest';

import { AppConfigInvalidError, DEFAULT_APP_CONFIG, loadAppConfig } from '../../src/config';

describe('loadAppConfig — positive cases', () => {
  it.each([
    [{ providers: [] }, 'empty providers ok'],
    [{ providers: [{ id: 'deepseek', model: 'chat', default: true }] }, 'single default provider'],
    [
      {
        providers: [
          { id: 'deepseek', model: 'chat', default: true },
          { id: 'openai', model: 'gpt-4' },
        ],
      },
      'multi providers with one default',
    ],
    [{ ui: {} }, 'empty ui ok'],
    [{ ui: { theme: 'dark', language: 'zh-CN' } }, 'ui full fields'],
    [{ shortcuts: [{ command: 'agent.stop', accelerator: 'Esc' }] }, 'shortcut ok'],
    [{ autoAcceptTools: ['echo'] }, 'auto accept tools'],
    [DEFAULT_APP_CONFIG, 'default config'],
    [
      {
        providers: [{ id: 'a', model: 'b' }],
        shortcuts: [{ command: 'a', accelerator: 'A' }],
        ui: { theme: 'system', fontSizePx: 14 },
        autoAcceptTools: [],
      },
      'fully populated valid',
    ],
  ])('%o (%s)', (raw) => {
    expect(() => loadAppConfig(raw)).not.toThrow();
  });
});

describe('loadAppConfig — negative cases', () => {
  it.each([
    [{ providers: [{ id: '', model: 'x' }] }, 'empty provider id'],
    [{ providers: [{ id: 'x', model: '' }] }, 'empty model id'],
    [{ providers: 'not-array' }, 'providers must be array'],
    [
      {
        providers: [
          { id: 'a', model: 'b', default: true },
          { id: 'c', model: 'd', default: true },
        ],
      },
      'multiple defaults',
    ],
    [
      {
        providers: [
          { id: 'a', model: 'b' },
          { id: 'a', model: 'b' },
        ],
      },
      'duplicate providers',
    ],
    [{ ui: { theme: 'purple' } }, 'invalid theme enum'],
    [{ ui: { fontSizePx: -1 } }, 'invalid font size'],
    [{ shortcuts: [{ command: '', accelerator: 'A' }] }, 'empty command id'],
    [
      {
        shortcuts: [
          { command: 'a', accelerator: 'A' },
          { command: 'a', accelerator: 'B' },
        ],
      },
      'duplicate shortcut command',
    ],
    [{ unknownField: 1 }, 'strict rejects unknown field'],
  ])('%o (%s)', (raw) => {
    expect(() => loadAppConfig(raw)).toThrow(AppConfigInvalidError);
  });

  it('exposes user-friendly issues', () => {
    try {
      loadAppConfig({ providers: [{ id: '', model: '' }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppConfigInvalidError);
      expect((e as AppConfigInvalidError).issues.length).toBeGreaterThan(0);
      expect((e as AppConfigInvalidError).message).toContain('AppConfig 无效');
    }
  });
});
