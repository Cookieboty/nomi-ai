/**
 * 客户端 UI 错误提示映射 —— 把 IPC 反序列化得到的 `SDKError.code` 转成
 * `{ title, description, action }`，供 ai-chat / 其它渲染进程 UI 直接展示。
 *
 * 与 ai-sdk 侧的默认 hint（`open-settings` / `switch-provider` / `retry` /
 * `dismiss` / `check-profile`）保持对齐；未知 code / hint 会回落到
 * `IPC_ERROR` 的通用提示，保证 UI 始终有可展示的中文文案。
 */

import { SDKError, SDKErrorCodes, type SDKErrorCode } from './errors';

/** UI 层要执行的 CTA 类型；渲染侧根据 `action.kind` 决定按钮行为。 */
export type ErrorAction =
  | { kind: 'open-settings'; label: string }
  | { kind: 'switch-provider'; label: string }
  | { kind: 'retry'; label: string }
  | { kind: 'check-profile'; label: string }
  | { kind: 'dismiss'; label: string };

export interface ErrorHint {
  /** 顶部标题，短句。 */
  title: string;
  /** 详情说明；如果无补充信息则给出通用兜底文案。 */
  description: string;
  /** 是否可一键重试（透传自 `SDKError.retryable`）。 */
  retryable: boolean;
  /** UI 建议动作；未识别时为 `undefined`，UI 侧仅显示"知道了"。 */
  action?: ErrorAction;
  /** 原错误 code；便于埋点/日志。 */
  code: SDKErrorCode;
}

const HINT_ACTION_LABEL: Record<Exclude<ErrorAction, undefined>['kind'], string> = {
  'open-settings': '打开设置',
  'switch-provider': '切换服务商',
  retry: '重试',
  'check-profile': '检查 Profile',
  dismiss: '知道了',
};

/** code → title/description 映射；未列出者走 default。 */
const HINT_TEXT: Partial<Record<SDKErrorCode, { title: string; description: string }>> = {
  [SDKErrorCodes.E_NO_KEY]: {
    title: '尚未配置 API Key',
    description: '当前 Profile 缺少可用的 API Key，请到设置页填写后重试。',
  },
  [SDKErrorCodes.E_QUOTA]: {
    title: '本月配额已用尽',
    description: '当前服务商余额或速率已达上限，可切换到备用 Provider 继续使用。',
  },
  [SDKErrorCodes.E_TIMEOUT]: {
    title: '请求超时',
    description: '与上游模型的连接超时，通常稍后重试即可恢复。',
  },
  [SDKErrorCodes.E_TOOL_DENIED]: {
    title: '工具执行被拒绝',
    description: '该操作被用户或权限策略拒绝，不会对系统造成影响。',
  },
  [SDKErrorCodes.E_PROFILE_MISS]: {
    title: 'Profile 缺失',
    description: '未找到当前会话对应的 Profile 配置，请在 profile 管理中检查或重新指定。',
  },
  [SDKErrorCodes.SEAM_NOT_INJECTED]: {
    title: '依赖未注入',
    description: '缺少对应的运行时依赖（如 ASR / TTS），请确认 Provider 挂载或稍后再试。',
  },
  [SDKErrorCodes.TOOL_NOT_FOUND]: {
    title: '工具不存在',
    description: '请求执行的工具未在当前会话注册。',
  },
  [SDKErrorCodes.TOOL_CONFIRM_INVALID]: {
    title: '工具确认无效',
    description: '工具确认请求的参数不合法（reqId 不匹配或已过期）。',
  },
  [SDKErrorCodes.PROFILE_INVALID]: {
    title: 'Profile 配置错误',
    description: '当前 Profile 校验失败，无法完成操作。',
  },
  [SDKErrorCodes.DISPOSED]: {
    title: '会话已释放',
    description: 'AIClient 已 dispose，请刷新页面重新初始化。',
  },
  [SDKErrorCodes.IPC_STREAM_ABORTED]: {
    title: '流式响应已中断',
    description: '与主进程的流式通道被中止，通常由用户取消或超时触发。',
  },
  [SDKErrorCodes.BRIDGE_MISSING]: {
    title: '未挂载 AIProvider',
    description: '当前 React 树未在 <AIProvider> 内使用相关 hook，请检查根组件。',
  },
  [SDKErrorCodes.IPC_ERROR]: {
    title: '发生了未知错误',
    description: '与后台通信失败，可稍后重试；若持续出现请查看日志或联系维护。',
  },
};

const DEFAULT_HINT_TEXT = HINT_TEXT[SDKErrorCodes.IPC_ERROR]!;

/**
 * 依据 `SDKError.hint` 生成 CTA。未识别时返回 undefined，UI 只显示"知道了"。
 */
function buildAction(hint: string | undefined, retryable: boolean): ErrorAction | undefined {
  if (hint === 'open-settings')
    return { kind: 'open-settings', label: HINT_ACTION_LABEL['open-settings'] };
  if (hint === 'switch-provider')
    return { kind: 'switch-provider', label: HINT_ACTION_LABEL['switch-provider'] };
  if (hint === 'retry' || (hint === undefined && retryable)) {
    return { kind: 'retry', label: HINT_ACTION_LABEL.retry };
  }
  if (hint === 'check-profile')
    return { kind: 'check-profile', label: HINT_ACTION_LABEL['check-profile'] };
  if (hint === 'dismiss') return { kind: 'dismiss', label: HINT_ACTION_LABEL.dismiss };
  return undefined;
}

/**
 * 把任意错误转换为 UI 可直接消费的 `ErrorHint`。
 *
 * - `SDKError` 直接使用；
 * - `Error`（IPC 反序列化的贫瘠错误）→ `SDKError.fromIpc` 还原；
 * - 其它非 Error → `IPC_ERROR` 兜底。
 */
export function toErrorHint(err: unknown): ErrorHint {
  const sdkErr = err instanceof SDKError ? err : SDKError.fromIpc(err);
  const text = HINT_TEXT[sdkErr.code] ?? DEFAULT_HINT_TEXT;
  const description = messageOf(sdkErr) || text.description;
  const action = buildAction(sdkErr.hint, sdkErr.retryable);
  const hint: ErrorHint = {
    title: text.title,
    description,
    retryable: sdkErr.retryable,
    code: sdkErr.code,
  };
  if (action) hint.action = action;
  return hint;
}

/** 剥掉 `[CODE] ` 前缀后得到人类可读的 message；若为空则回落到默认描述。 */
function messageOf(err: SDKError): string {
  const raw = err.message ?? '';
  const stripped = raw.replace(/^\[[A-Z_][A-Z0-9_]*\]\s*/, '').trim();
  return stripped;
}
