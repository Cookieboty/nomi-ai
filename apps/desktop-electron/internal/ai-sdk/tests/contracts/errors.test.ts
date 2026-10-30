/**
 * P9-4 契约测试 —— 锁定 IPC 错误协议在 ai-sdk / ai-sdk-client 双端等价。
 *
 * 覆盖点：
 * - `AIClientError` message 形如 `[CODE|R|hint:XX] xxx`；
 * - `formatIpcMessage` 生成 `parseIpcMessage` 能对称还原；
 * - 保留旧协议兼容：`[CODE] xxx` 也能被解析（无 retryable / hint）；
 * - `isRetryable` / `getDefaultHint` 覆盖 P9-4 新增的 code。
 */

import { describe, expect, it } from 'vitest';

import {
  AIClientError,
  ErrorCodes,
  formatIpcMessage,
  getDefaultHint,
  isRetryable,
  parseIpcMessage,
} from '../../src/errors';

describe('P9-4 errors · IPC 契约', () => {
  it('AIClientError 生成的 message 编码了 code / retryable / hint', () => {
    const e = new AIClientError(ErrorCodes.E_NO_KEY, '未配置 API Key');
    expect(e.code).toBe(ErrorCodes.E_NO_KEY);
    expect(e.retryable).toBe(false);
    expect(e.hint).toBe('open-settings');
    expect(e.message).toBe('[E_NO_KEY|0|hint:open-settings] 未配置 API Key');
  });

  it('E_TIMEOUT 默认 retryable=true 且 hint=retry', () => {
    const e = new AIClientError(ErrorCodes.E_TIMEOUT, 'chat 超时');
    expect(e.retryable).toBe(true);
    expect(e.hint).toBe('retry');
    expect(e.message).toBe('[E_TIMEOUT|1|hint:retry] chat 超时');
  });

  it('未列入默认表的 code 默认 retryable=false / hint=undefined', () => {
    const e = new AIClientError(ErrorCodes.SEAM_NOT_INJECTED, 'x');
    expect(e.retryable).toBe(false);
    expect(e.hint).toBeUndefined();
    expect(e.message).toBe('[SEAM_NOT_INJECTED|0] x');
  });

  it('formatIpcMessage / parseIpcMessage 对称', () => {
    const raw = formatIpcMessage({
      code: 'E_QUOTA',
      retryable: true,
      hint: 'switch-provider',
      message: '本月配额已用尽',
    });
    expect(raw).toBe('[E_QUOTA|1|hint:switch-provider] 本月配额已用尽');
    expect(parseIpcMessage(raw)).toEqual({
      code: 'E_QUOTA',
      retryable: true,
      hint: 'switch-provider',
      message: '本月配额已用尽',
    });
  });

  it('parseIpcMessage 兼容旧的 [CODE] message 格式', () => {
    expect(parseIpcMessage('[TOOL_NOT_FOUND] tool `x` missing')).toEqual({
      code: 'TOOL_NOT_FOUND',
      message: 'tool `x` missing',
    });
  });

  it('parseIpcMessage 支持多行 message', () => {
    const raw = '[E_TIMEOUT|1|hint:retry] line1\nline2';
    expect(parseIpcMessage(raw)).toEqual({
      code: 'E_TIMEOUT',
      retryable: true,
      hint: 'retry',
      message: 'line1\nline2',
    });
  });

  it('parseIpcMessage 无匹配返回 undefined', () => {
    expect(parseIpcMessage('plain error without prefix')).toBeUndefined();
    expect(parseIpcMessage('[lowercase] msg')).toBeUndefined();
  });

  it('isRetryable / getDefaultHint 覆盖新增 code', () => {
    expect(isRetryable(ErrorCodes.E_TIMEOUT)).toBe(true);
    expect(isRetryable(ErrorCodes.E_QUOTA)).toBe(true);
    expect(isRetryable(ErrorCodes.E_NO_KEY)).toBe(false);
    expect(getDefaultHint(ErrorCodes.E_NO_KEY)).toBe('open-settings');
    expect(getDefaultHint(ErrorCodes.E_PROFILE_MISS)).toBe('check-profile');
    expect(getDefaultHint(ErrorCodes.TOOL_NOT_FOUND)).toBeUndefined();
  });

  it('opts.retryable / opts.hint 可覆盖默认', () => {
    const e = new AIClientError(ErrorCodes.E_TIMEOUT, 'x', { retryable: false, hint: 'dismiss' });
    expect(e.retryable).toBe(false);
    expect(e.hint).toBe('dismiss');
    expect(e.message).toBe('[E_TIMEOUT|0|hint:dismiss] x');
  });

  it('opts.cause 保留原始错误但不参与序列化', () => {
    const cause = new Error('inner');
    const e = new AIClientError(ErrorCodes.E_QUOTA, 'x', { cause });
    expect(e.cause).toBe(cause);
    expect(e.message).toBe('[E_QUOTA|1|hint:switch-provider] x');
  });
});
