/**
 * 对话窗口的语音输入（hook + 小组件），由 MessageInput 摆放：
 * 按住说话按钮、免按键开关、状态条、语音设置弹窗。
 * 快捷键：按住 F2 说话（Esc 取消）；Ctrl/⌘+Shift+H 开关免按键。
 * 看板娘那边说的话（ai:voice:inject）也从这里进入输入框 / 直接发送。
 */
import { t, Icon } from '@nomi-ai/ui';
import { Modal, Tooltip } from '@nomi-ai/ui';
import {
  MicButton,
  VoiceSettingsPanel,
  VoiceStatus,
  useVoice,
  type UseVoice,
} from '@nomi-ai/voice';
import { Headphones } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getBindings, matchShortcut } from '../../services/shortcuts';

export function useChatVoice(opts: {
  disabled?: boolean;
  onText(text: string, autoSend: boolean): void;
}) {
  const { disabled, onText } = opts;
  const [showSettings, setShowSettings] = useState(false);
  const autoSendRef = useRef(true);
  const handle = useCallback((text: string) => onText(text, autoSendRef.current), [onText]);
  const v = useVoice('chat', handle);
  const autoSend = v.config?.settings.autoSend ?? true;
  useEffect(() => {
    autoSendRef.current = autoSend;
  }, [autoSend]);

  useEffect(() => v.api?.onInject((e) => onText(e.text, e.autoSend)), [v.api, onText]);

  const handsFree = v.state.mode === 'handsfree';
  const toggleHandsFree = useCallback(
    () => void v.setContinuous(handsFree ? 'off' : 'handsfree'),
    [v, handsFree],
  );

  const f2Down = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'F2' && !e.repeat && !f2Down.current && !disabled) {
        e.preventDefault();
        f2Down.current = true;
        void v.pttStart();
      } else if (e.key === 'Escape' && f2Down.current) {
        f2Down.current = false;
        void v.pttStop(true);
      } else if (matchShortcut(e, getBindings().handsFree)) {
        e.preventDefault();
        toggleHandsFree();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'F2' && f2Down.current) {
        f2Down.current = false;
        void v.pttStop(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [v, disabled, toggleHandsFree]);

  useEffect(() => () => void v.controller?.stopContinuous(), [v.controller]);

  return { v, handsFree, toggleHandsFree, showSettings, setShowSettings };
}

export type ChatVoice = ReturnType<typeof useChatVoice>;

const HeadsetIcon = () => <Icon icon={Headphones} size={18} />;

export const VoiceButtons: React.FC<{ cv: ChatVoice; disabled?: boolean }> = ({ cv, disabled }) => {
  const { v, handsFree, toggleHandsFree } = cv;
  if (!v.available) return null;
  return (
    <div className="cd-voice-buttons">
      <MicButton
        state={v.state}
        disabled={disabled || handsFree}
        onStart={() => void v.pttStart()}
        onStop={(cancel) => void v.pttStop(cancel)}
        tooltip={t('按住说话（F2）')}
        data-testid="voice-mic"
      />
      <Tooltip
        content={
          handsFree ? t('关闭免按键（Ctrl+Shift+H）') : t('免按键：说完自动识别（Ctrl+Shift+H）')
        }
      >
        <button
          type="button"
          aria-label={handsFree ? t('关闭免按键') : t('开启免按键')}
          aria-pressed={handsFree}
          className={`cd-voice-mic cd-voice-toggle ${handsFree ? 'is-on' : ''}`}
          onClick={toggleHandsFree}
          disabled={disabled}
          data-testid="voice-handsfree"
        >
          <HeadsetIcon />
        </button>
      </Tooltip>
    </div>
  );
};

export const VoiceStatusRow: React.FC<{ cv: ChatVoice }> = ({ cv }) => {
  const { v } = cv;
  if (!v.available) return null;
  return (
    <VoiceStatus
      state={v.state}
      onOpenSettings={() => cv.setShowSettings(true)}
      onDismissError={() => v.controller?.clearError()}
      onStop={() => void v.setContinuous('off')}
    />
  );
};

export const VoiceSettingsModal: React.FC<{ cv: ChatVoice }> = ({ cv }) => {
  const v: UseVoice = cv.v;
  // 输入区有 backdrop-filter（会成为 fixed 定位的包含块）：挂到 body，保证弹窗居中、完整可见
  return createPortal(
    <Modal
      open={cv.showSettings}
      onClose={() => cv.setShowSettings(false)}
      title={t('语音输入')}
      size="lg"
    >
      {v.api && (
        <VoiceSettingsPanel api={v.api} config={v.config} onRefresh={() => void v.refresh()} />
      )}
    </Modal>,
    document.body,
  );
};
