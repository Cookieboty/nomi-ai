/**
 * 桌面角色语音：工具栏「按住说话」麦克风 + 状态桥（表情/动作、语音打断、唤醒词）。
 * 识别文本经主进程转交 AI 对话窗口（ai:voice:sendToChat）。
 * 状态胶囊固定在窗口底部，不遮挡角色面部。
 */
import { t } from '@nomi-ai/ui';
import { MicButton, VoiceStatus, useVoice } from '@nomi-ai/voice';
import React, { useCallback, useEffect, useRef } from 'react';

import { avatarEvents } from '../../avatar/events';
import { openVoiceSettings } from '../openVoiceSettings';
import { useMascotShown } from '../presence';
import { stopAllSpeech } from '../speechStop';

import styles from './MascotVoice.module.css';
import { CLIP_HINTS } from './promptClips';

import { playBubbleClip, useCompanionMessage } from '@/hooks/useCompanionMessage';

let toggleImpl: (() => Promise<void>) | null = null;

/** 工具栏菜单项 / 右键：切换免按键对话 */
export function toggleMascotHandsfree(): Promise<void> {
  return toggleImpl ? toggleImpl() : Promise.resolve();
}

export const MascotMicTool: React.FC<{
  className?: string;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
}> = ({ className, tipSide }) => {
  const v = useVoice('mascot');
  if (!v.available) return null;
  const continuous = v.state.mode === 'handsfree';
  return (
    <span
      id="companion-tool-voice-input"
      onContextMenu={(e) => {
        e.preventDefault();
        // 右键后让出焦点：否则聚焦触发的提示会一直挡在角色脸前
        (e.currentTarget.querySelector('button') as HTMLButtonElement | null)?.blur();
        void toggleMascotHandsfree();
      }}
    >
      <MicButton
        state={v.state}
        className={className}
        size="sm"
        data-testid="tool-voice-input"
        onStart={() => void v.pttStart()}
        onStop={(cancel) => void v.pttStop(cancel)}
        tooltip={
          continuous
            ? t('ui.voice-mascot.voice-hands-free-on-right-click-to-stop')
            : t('ui.voice-mascot.voice-hold-to-talk-right-click-for-hands')
        }
        tooltipPlacement={tipSide}
      />
    </span>
  );
};

export const MascotVoiceBridge: React.FC = () => {
  const { showMessage } = useCompanionMessage();
  const apiRef = useRef<ReturnType<typeof useVoice>['api']>(null);
  const onText = useCallback(
    (text: string, via: string) => {
      // 唤醒词 + 指令一句说完：直接点头回应
      if (via === 'wake') avatarEvents.emit({ type: 'cue', cue: { kind: 'voice:wake' } });
      showMessage(`🎙「${text.length > 40 ? `${text.slice(0, 40)}…` : text}」`, 3000, 8);
      void apiRef.current?.sendToChat(text);
    },
    [showMessage],
  );
  const v = useVoice('mascot', onText);
  const prev = useRef('idle');
  useEffect(() => {
    apiRef.current = v.api;
  }, [v.api]);

  const { setContinuous, state, config } = v;
  useEffect(() => {
    toggleImpl = async () => {
      await setContinuous(
        state.mode === 'handsfree'
          ? config?.settings.wakeWord.enabled
            ? 'wake'
            : 'off'
          : 'handsfree',
      );
    };
    return () => {
      toggleImpl = null;
    };
  }, [setContinuous, state.mode, config]);

  // 语音出错：角色提示语音念出固定句（详情只在状态胶囊里显示）
  const err = v.state.error;
  useEffect(() => {
    if (!err) return;
    playBubbleClip(err.message, err.code === 'mic_failed' ? CLIP_HINTS.micFailed : undefined);
  }, [err]);

  // 表情 / 动作（avatar-runtime 按语音状态决定）
  useEffect(() => {
    avatarEvents.emit({ type: 'voice', phase: v.state.phase, prev: prev.current });
    prev.current = v.state.phase;
    if (v.state.phase === 'awake') showMessage(t('ui.voice-mascot.i-m-here-go-ahead'), 2500, 9);
  }, [v.state.phase, showMessage]);

  // 语音打断：开口说话即停止朗读
  useEffect(
    () =>
      v.api
        ? v.api.onBargeIn(() => {
            stopAllSpeech();
            // 被打断：轻微受惊，然后专心听
            avatarEvents.emit({ type: 'cue', cue: { kind: 'barge-in' } });
          })
        : undefined,
    [v.api],
  );

  // 唤醒词（默认关闭）：开启后桌面角色常驻监听
  // 桌面角色被关闭（窗口隐藏）时停掉唤醒词 / 免按键监听，不在看不见的窗口里继续开麦（#55）
  const shown = useMascotShown();
  const wake = (v.config?.settings.wakeWord.enabled ?? false) && shown;
  const ready = v.config?.readiness.ok ?? false;
  useEffect(() => {
    if (!v.controller) return;
    if (!shown && v.state.mode !== 'off') {
      void v.setContinuous('off');
      return;
    }
    if (wake && ready && v.state.mode === 'off') void v.setContinuous('wake');
    if (!wake && v.state.mode === 'wake') void v.setContinuous('off');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在开关/就绪/显示变化时
  }, [wake, ready, shown, v.controller]);

  if (!v.available) return null;
  const visible = v.state.phase !== 'idle' || !!v.state.error;
  if (!visible) return null;
  return (
    <div className={styles.wrap} data-testid="mascot-voice-status">
      <div className={styles.inner}>
        <VoiceStatus
          state={v.state}
          wakePhrase={v.config?.settings.wakeWord.phrase}
          onOpenSettings={() => void openVoiceSettings()}
          onDismissError={() => v.controller?.clearError()}
          onStop={() => void v.setContinuous('off')}
          className="cd-voice-status--floating"
        />
      </div>
    </div>
  );
};

export default MascotVoiceBridge;
