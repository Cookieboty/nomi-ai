import { t } from '@nomi-ai/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  defaultVoiceApi,
  voiceApi,
  type VoiceApi,
  type VoiceBridge,
  type VoiceStateView,
} from '../bridge';
import { VoiceController, type VoiceMode, type VoiceState } from '../controller';

const controllers = new Map<string, VoiceController>();

/** 每个窗口每种来源一个控制器（多个组件共享同一个麦克风会话） */
export function getController(
  source: 'chat' | 'mascot',
  bridge: VoiceBridge | VoiceApi,
): VoiceController {
  let c = controllers.get(source);
  if (!c) {
    const api = 'invoke' in bridge ? voiceApi(bridge) : bridge;
    c = new VoiceController({ api, source });
    controllers.set(source, c);
  }
  return c;
}

export interface UseVoice {
  available: boolean;
  api: VoiceApi | null;
  controller: VoiceController | null;
  state: VoiceState;
  config: VoiceStateView | null;
  refresh(): Promise<void>;
  pttStart(): Promise<void>;
  pttStop(cancel?: boolean): Promise<string>;
  setContinuous(mode: Extract<VoiceMode, 'handsfree' | 'wake'> | 'off'): Promise<void>;
}

const IDLE: VoiceState = {
  mode: 'off',
  phase: 'idle',
  level: 0,
  elapsedMs: 0,
  vad: null,
  error: null,
  lastText: '',
  partial: '',
};

export function useVoice(
  source: 'chat' | 'mascot',
  onText?: (text: string, via: VoiceMode) => void,
): UseVoice {
  const api = useMemo(() => defaultVoiceApi(), []);
  const controller = useMemo(() => (api ? getController(source, api) : null), [api, source]);
  const [state, setState] = useState<VoiceState>(controller?.state ?? IDLE);
  const [config, setConfig] = useState<VoiceStateView | null>(null);

  const refresh = useCallback(async () => {
    if (api) setConfig(await api.state());
  }, [api]);

  useEffect(() => controller?.subscribe(setState), [controller]);
  useEffect(
    () => (onText && controller ? controller.onTranscript(onText) : undefined),
    [controller, onText],
  );
  useEffect(() => {
    if (!api) return;
    void refresh();
    const offs = [api.onChanged(() => void refresh()), api.onProgress(() => void refresh())];
    return () => offs.forEach((f) => f());
  }, [api, refresh]);

  const s0 = config?.settings;
  useEffect(() => {
    if (!controller || !s0) return;
    controller.updateSettings({
      vadThreshold: s0.vadThreshold,
      wakePhrase: s0.wakeWord.phrase,
      wakeWindowSec: s0.wakeWord.windowSec,
      streaming: s0.engine === 'volc',
    });
  }, [controller, s0]);

  const pttStart = useCallback(async () => {
    await controller?.pttStart();
  }, [controller]);
  const pttStop = useCallback(
    async (cancel?: boolean) => (controller ? controller.pttStop(cancel) : ''),
    [controller],
  );
  const setContinuous = useCallback(
    async (mode: 'handsfree' | 'wake' | 'off') => {
      if (!controller) return;
      if (mode === 'off') return controller.stopContinuous();
      const s = config?.settings ?? (await api?.state())?.settings;
      return controller.startContinuous(mode, {
        vadThreshold: s?.vadThreshold,
        wakePhrase: s?.wakeWord.phrase,
        wakeWindowSec: s?.wakeWord.windowSec,
      });
    },
    [controller, config, api],
  );

  return {
    available: !!api,
    api,
    controller,
    state,
    config,
    refresh,
    pttStart,
    pttStop,
    setContinuous,
  };
}

export function phaseLabel(s: VoiceState, wakePhrase = ''): string {
  switch (s.phase) {
    case 'starting':
      return t('ui.mascot-theme.opening-microphone');
    case 'recording':
      return t('ui.mascot-theme.listening-s', (s.elapsedMs / 1000).toFixed(1));
    case 'listening':
      return t('ui.mascot-theme.hands-free-just-start-talking');
    case 'hearing':
      return t('ui.chat-settings.listening');
    case 'transcribing':
      return t('ui.voice-mascot.recognizing');
    case 'wake-armed':
      return t('ui.mascot-theme.waiting-for-wake-word', wakePhrase);
    case 'awake':
      return t('ui.mascot-theme.i-m-here-go-ahead');
    default:
      return '';
  }
}
