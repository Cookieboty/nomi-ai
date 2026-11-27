/**
 * P9-4 · UI 提示映射测试 —— 校验 `toErrorHint` 能把 SDKError / IPC 反序列化 Error 转成
 * `{ title, description, action, retryable, code }`。
 */

import { describe, expect, it } from 'vitest';

import { toErrorHint } from '../src/errorHint';
import { SDKError, SDKErrorCodes } from '../src/errors';

describe('P9-4 toErrorHint', () => {
  it('E_NO_KEY → 打开设置 CTA', () => {
    const h = toErrorHint(new Error('[E_NO_KEY|0|hint:open-settings] 未配置 API Key'));
    expect(h.code).toBe(SDKErrorCodes.E_NO_KEY);
    expect(h.title).toBe('尚未配置 API Key');
    expect(h.retryable).toBe(false);
    expect(h.action).toEqual({ kind: 'open-settings', label: '打开设置' });
    expect(h.description).toBe('未配置 API Key');
  });

  it('E_QUOTA → 切换服务商 CTA', () => {
    const h = toErrorHint(new Error('[E_QUOTA|1|hint:switch-provider] 上限'));
    expect(h.action).toEqual({ kind: 'switch-provider', label: '切换服务商' });
    expect(h.retryable).toBe(true);
  });

  it('E_TIMEOUT → 重试 CTA', () => {
    const h = toErrorHint(new Error('[E_TIMEOUT|1|hint:retry] 超时'));
    expect(h.action).toEqual({ kind: 'retry', label: '重试' });
    expect(h.retryable).toBe(true);
  });

  it('无 hint 但 retryable=true → 自动派生重试 CTA', () => {
    const h = toErrorHint(new SDKError(SDKErrorCodes.IPC_ERROR, 'x', { retryable: true }));
    expect(h.action).toEqual({ kind: 'retry', label: '重试' });
  });

  it('未识别 code 走 IPC_ERROR 兜底', () => {
    const h = toErrorHint(new Error('[UNKNOWN|1] boom'));
    expect(h.code).toBe(SDKErrorCodes.IPC_ERROR);
    expect(h.title).toBe('发生了未知错误');
    expect(h.action).toBeUndefined();
  });

  it('description 为空时回落默认文案', () => {
    const h = toErrorHint(new Error('[E_TOOL_DENIED|0|hint:dismiss] '));
    expect(h.description).toBe('该操作被用户或权限策略拒绝，不会对系统造成影响。');
    expect(h.action).toEqual({ kind: 'dismiss', label: '知道了' });
  });

  it('E_PROFILE_MISS → 无对应提示或走默认；E_REQUEST_TOO_LARGE → 消息内容过长', () => {
    const h = toErrorHint(
      new SDKError(SDKErrorCodes.E_REQUEST_TOO_LARGE, '当前消息（121 KB）超出上限（59 KB）', {
        retryable: false,
        hint: 'dismiss',
      }),
    );
    expect(h.code).toBe(SDKErrorCodes.E_REQUEST_TOO_LARGE);
    expect(h.title).toBe('消息内容过长');
    expect(h.description).toBe('当前消息（121 KB）超出上限（59 KB）');
    expect(h.action).toEqual({ kind: 'dismiss', label: '知道了' });
  });

  it('非 Error 值也能兜底', () => {
    const h = toErrorHint('some string');
    expect(h.code).toBe(SDKErrorCodes.IPC_ERROR);
  });
});
