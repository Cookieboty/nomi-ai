/**
 * 按住说话按钮：按下开始录音，松开识别；按住时把指针移出按钮 → 松开即取消。
 * 键盘：聚焦后按住 空格 / 回车 说话，Esc 取消。光环随音量起伏。
 */
import { t } from '@nomi-ai/ui';
import { Tooltip, cx } from '@nomi-ai/ui';
import React, { useRef, useState } from 'react';

import type { VoiceState } from '../controller';

export interface MicButtonProps {
  state: VoiceState;
  disabled?: boolean;
  onStart(): void;
  onStop(cancel: boolean): void;
  size?: 'sm' | 'md';
  tooltip?: string;
  tooltipPlacement?: 'top' | 'top-end' | 'bottom' | 'left' | 'right';
  className?: string;
  'data-testid'?: string;
}

export const MicIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M12 17v4" />
  </svg>
);

export const MicButton: React.FC<MicButtonProps> = ({
  state,
  disabled,
  onStart,
  onStop,
  size = 'md',
  tooltip,
  tooltipPlacement,
  className,
  ...rest
}) => {
  const [armedCancel, setArmedCancel] = useState(false);
  const holding = useRef(false);
  const recording =
    state.mode === 'ptt' && (state.phase === 'recording' || state.phase === 'starting');
  const busy = state.mode === 'ptt' && state.phase === 'transcribing';

  const begin = () => {
    if (disabled || holding.current) return;
    holding.current = true;
    setArmedCancel(false);
    onStart();
  };
  const end = (cancel: boolean) => {
    if (!holding.current) return;
    holding.current = false;
    setArmedCancel(false);
    onStop(cancel);
  };

  const label = recording
    ? armedCancel
      ? t('松开取消')
      : t('松开发送')
    : busy
      ? t('识别中…')
      : (tooltip ?? t('按住说话（聚焦后按住空格）'));

  return (
    <Tooltip content={label} placement={tooltipPlacement}>
      <button
        type="button"
        className={cx(
          'cd-voice-mic',
          `cd-voice-mic--${size}`,
          recording && 'is-recording',
          armedCancel && 'is-cancel',
          busy && 'is-busy',
          className,
        )}
        style={{ ['--cd-voice-level' as string]: recording ? state.level.toFixed(2) : '0' }}
        aria-label={label}
        aria-pressed={recording}
        disabled={disabled}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          begin();
        }}
        onPointerUp={() => end(armedCancel)}
        onPointerCancel={() => end(true)}
        onPointerMove={(e) => {
          if (!holding.current) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const out =
            e.clientX < r.left - 24 ||
            e.clientX > r.right + 24 ||
            e.clientY < r.top - 48 ||
            e.clientY > r.bottom + 24;
          if (out !== armedCancel) setArmedCancel(out);
        }}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            begin();
          } else if (e.key === 'Escape') end(true);
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            end(false);
          }
        }}
        onBlur={() => end(true)}
        {...rest}
      >
        {busy ? (
          <span className="cd-voice-spinner" aria-hidden />
        ) : (
          <MicIcon size={size === 'sm' ? 16 : 18} />
        )}
      </button>
    </Tooltip>
  );
};
