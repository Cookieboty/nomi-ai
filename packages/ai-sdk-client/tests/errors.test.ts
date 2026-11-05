/**
 * P9-4 客户端错误恢复测试 —— 确保 IPC 序列化后原型丢失的 Error 能被 `SDKError.fromIpc`
 * 还原成带 code / retryable / hint 的领域错误，与内核的错误前缀约定保持一致。
 */

import { describe, expect, it } from 'vitest';

import { parseIpcMessage, SDKError, SDKErrorCodes } from '../src/errors';

describe('P9-4 SDKError.fromIpc', () => {
  it('识别新格式：还原 code / retryable / hint / message', () => {
    const raw = new Error('[E_NO_KEY|0|hint:open-settings] 未配置 API Key');
    const e = SDKError.fromIpc(raw);
    expect(e).toBeInstanceOf(SDKError);
    expect(e.code).toBe(SDKErrorCodes.E_NO_KEY);
    expect(e.retryable).toBe(false);
    expect(e.hint).toBe('open-settings');
    expect(e.message).toBe('[E_NO_KEY] 未配置 API Key');
    expect(e.cause).toBe(raw);
  });

  it('识别 retryable=true 的错误（如 E_TIMEOUT）', () => {
    const e = SDKError.fromIpc(new Error('[E_TIMEOUT|1|hint:retry] 上游超时'));
    expect(e.code).toBe(SDKErrorCodes.E_TIMEOUT);
    expect(e.retryable).toBe(true);
    expect(e.hint).toBe('retry');
  });

  it('兼容旧格式 [CODE] msg', () => {
    const e = SDKError.fromIpc(new Error('[TOOL_NOT_FOUND] tool `x` missing'));
    expect(e.code).toBe(SDKErrorCodes.TOOL_NOT_FOUND);
    expect(e.retryable).toBe(false);
    expect(e.hint).toBeUndefined();
    expect(e.message).toBe('[TOOL_NOT_FOUND] tool `x` missing');
  });

  it('未知 code 落到 IPC_ERROR，保留原 message 与 cause', () => {
    const raw = new Error('[UNKNOWN_CODE|1] weird');
    const e = SDKError.fromIpc(raw);
    expect(e.code).toBe(SDKErrorCodes.IPC_ERROR);
    expect(e.message).toBe('[IPC_ERROR] [UNKNOWN_CODE|1] weird');
    expect(e.cause).toBe(raw);
  });

  it('无前缀落到 IPC_ERROR', () => {
    const e = SDKError.fromIpc(new Error('boom'));
    expect(e.code).toBe(SDKErrorCodes.IPC_ERROR);
    expect(e.message).toBe('[IPC_ERROR] boom');
  });

  it('非 Error 值也能兜底', () => {
    const e = SDKError.fromIpc('string error');
    expect(e.code).toBe(SDKErrorCodes.IPC_ERROR);
    expect(e.message).toBe('[IPC_ERROR] string error');
  });

  it('已是 SDKError 时直通', () => {
    const orig = new SDKError(SDKErrorCodes.E_QUOTA, 'quota', {
      retryable: true,
      hint: 'switch-provider',
    });
    expect(SDKError.fromIpc(orig)).toBe(orig);
  });

  it('parseIpcMessage 与 ai-sdk 侧字段一致（多行、无 flag、hint-only）', () => {
    expect(parseIpcMessage('[E_TIMEOUT|1] a\nb')).toEqual({
      code: 'E_TIMEOUT',
      retryable: true,
      message: 'a\nb',
    });
    expect(parseIpcMessage('[X] y')).toEqual({ code: 'X', message: 'y' });
    expect(parseIpcMessage('[X|0|hint:H] y')).toEqual({
      code: 'X',
      retryable: false,
      hint: 'H',
      message: 'y',
    });
    expect(parseIpcMessage('no prefix')).toBeUndefined();
  });

  it('构造签名兼容旧的 (code, message, cause) 三参', () => {
    const cause = new Error('inner');
    const e = new SDKError(SDKErrorCodes.DISPOSED, 'disposed', cause);
    expect(e.cause).toBe(cause);
    expect(e.retryable).toBe(false);
    expect(e.hint).toBeUndefined();
  });
});
