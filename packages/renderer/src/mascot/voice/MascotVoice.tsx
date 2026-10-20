/**
 * 看板娘语音：工具栏「按住说话」麦克风 + 状态桥（表情/动作、语音打断、唤醒词）。
 * 识别文本经主进程转交 AI 对话窗口（ai:voice:sendToChat）。
 * 状态胶囊固定在窗口底部，不遮挡角色面部。
 */
import { t } from '@nomi-ai/ui';
import { MicButton, VoiceStatus, useVoice } from '@nomi-ai/voice';
import React, { useCallback, useEffect, useRef } from 'react';

import { directiveForEvent } from '../expressionDirector';
import { applyDirective } from '../mood';
import { useMascotShown } from '../presence';
import { stopAllSpeech } from '../speechStop';

import { voiceDirective } from './voiceMood';

import { useWaifuMessage } from '@/hooks/useWaifuMessage';

let toggleImpl: (() => Promise<void>) | null = null;

/** 工具栏菜单项 / 右键：切换免按键对话 */
export function toggleMascotHandsfree(): Promise<void> {
  return toggleImpl ? toggleImpl() : Promise.resolve();
}

function openChat(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留 preload
  (window as any).electronAPI?.openAiChat?.();
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
      id="waifu-tool-voice-input"
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
          continuous ? t('语音交互\n免按键对话中 · 右键关闭') : t('语音交互\n按住说话 · 右键免按键')
        }
        tooltipPlacement={tipSide}
      />
    </span>
  );
};

export const MascotVoiceBridge: React.FC = () => {
  const { showMessage } = useWaifuMessage();
  const apiRef = useRef<ReturnType<typeof useVoice>['api']>(null);
  const onText = useCallback(
    (text: string, via: string) => {
      // 唤醒词 + 指令一句说完：直接点头回应
      if (via === 'wake') applyDirective({ expression: 'happy', holdMs: 2000, motion: 'nod' });
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

  // 表情 / 动作
  useEffect(() => {
    const d = voiceDirective(v.state.phase, prev.current);
    prev.current = v.state.phase;
    if (d) applyDirective(d);
    if (v.state.phase === 'awake') showMessage(t('我在～请说'), 2500, 9);
  }, [v.state.phase, showMessage]);

  // 语音打断：开口说话即停止朗读
  useEffect(
    () =>
      v.api
        ? v.api.onBargeIn(() => {
            stopAllSpeech();
            // 被打断：轻微受惊，然后专心听
            applyDirective(directiveForEvent({ kind: 'barge-in' }));
          })
        : undefined,
    [v.api],
  );

  // 唤醒词（默认关闭）：开启后看板娘常驻监听
  // 看板娘被关闭（窗口隐藏）时停掉唤醒词 / 免按键监听，不在看不见的窗口里继续开麦（#55）
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
    <div
      data-testid="mascot-voice-status"
      style={{
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: 6,
        display: 'flex',
        justifyContent: 'center',
        zIndex: 30,
        pointerEvents: 'none',
      }}
    >
      <div style={{ pointerEvents: 'auto', maxWidth: '100%' }}>
        <VoiceStatus
          state={v.state}
          wakePhrase={v.config?.settings.wakeWord.phrase}
          onOpenSettings={openChat}
          onDismissError={() => v.controller?.clearError()}
          onStop={() => void v.setContinuous('off')}
          className="cd-voice-status--floating"
        />
      </div>
    </div>
  );
};

export default MascotVoiceBridge;
