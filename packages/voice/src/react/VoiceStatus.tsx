/** 语音状态条：聆听 / 识别中 / 等待唤醒…；出错时给出可操作的提示。麦克风打开时始终可见（隐私指示）。 */
import { t } from '@nomi-ai/ui';
import { cx } from '@nomi-ai/ui';
import React, { useEffect, useRef } from 'react';

import type { VoiceState } from '../controller';

import { phaseLabel } from './useVoice';

export interface VoiceStatusProps {
  state: VoiceState;
  wakePhrase?: string;
  onOpenSettings?(): void;
  onDismissError?(): void;
  onStop?(): void;
  className?: string;
}

const NEEDS_SETUP = new Set([
  'no_engine',
  'no_model',
  'no_provider',
  'cloud_not_acked',
  'local_only',
]);

/** 错误提示自动消失的时间；需要去设置的错误留得久一些，让用户来得及点 */
export const ERROR_AUTO_DISMISS_MS = 6000;
export const SETUP_ERROR_AUTO_DISMISS_MS = 15000;

export const VoiceStatus: React.FC<VoiceStatusProps> = ({
  state,
  wakePhrase,
  onOpenSettings,
  onDismissError,
  onStop,
  className,
}) => {
  const text = phaseLabel(state, wakePhrase);
  const errCode = state.error?.code;
  const errMessage = state.error?.message;
  // 回调每次渲染都是新函数：放进 ref，避免父组件重渲染把倒计时重置
  const dismissRef = useRef(onDismissError);
  useEffect(() => {
    dismissRef.current = onDismissError;
  });
  const dismissible = !!onDismissError;
  useEffect(() => {
    if (!errCode || !dismissible) return undefined;
    const ms = NEEDS_SETUP.has(errCode) ? SETUP_ERROR_AUTO_DISMISS_MS : ERROR_AUTO_DISMISS_MS;
    const timer = setTimeout(() => dismissRef.current?.(), ms);
    return () => clearTimeout(timer);
  }, [errCode, errMessage, dismissible]);
  if (state.error) {
    return (
      <div
        className={cx('cd-voice-status', 'is-error', className)}
        role="alert"
        data-testid="voice-error"
      >
        <span className="cd-voice-status__text">{state.error.message}</span>
        {NEEDS_SETUP.has(state.error.code) && onOpenSettings && (
          <button
            type="button"
            className="cd-voice-link"
            onClick={onOpenSettings}
            data-testid="voice-error-setup"
          >
            {t('去设置')}
          </button>
        )}
        {onDismissError && (
          <button
            type="button"
            className="cd-voice-link"
            aria-label={t('关闭提示')}
            onClick={onDismissError}
          >
            ✕
          </button>
        )}
      </div>
    );
  }
  if (!text) return null;
  const continuous = state.mode === 'handsfree' || state.mode === 'wake';
  return (
    <div
      className={cx('cd-voice-status', `is-${state.phase}`, className)}
      role="status"
      aria-live="polite"
      data-testid="voice-status"
      data-phase={state.phase}
    >
      <span className="cd-voice-dot" aria-hidden />
      <span className="cd-voice-status__text">{text}</span>
      {state.partial && (state.phase === 'recording' || state.phase === 'transcribing') && (
        // 流式识别的临时文本：可能被修订，松开后以最终结果为准
        <span className="cd-voice-status__partial" data-testid="voice-partial">
          {state.partial}
        </span>
      )}
      {state.mode !== 'ptt' && state.vad === 'energy' && (
        <span
          className="cd-voice-status__hint"
          title={t('下载 Silero VAD 可更准确地判断你何时说完')}
        >
          {t('基础检测')}
        </span>
      )}
      {continuous && onStop && (
        <button type="button" className="cd-voice-link" onClick={onStop} data-testid="voice-stop">
          {t('停止')}
        </button>
      )}
    </div>
  );
};
