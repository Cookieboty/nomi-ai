import { t } from '@nomi-ai/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  defaultBridge,
  voiceApi,
  type VoiceApi,
  type VoiceBridge,
  type VoiceStateView,
} from '../bridge';
import { VoiceController, type VoiceMode, type VoiceState } from '../controller';

const controllers = new Map<string, VoiceController>();

/** 每个窗口每种来源一个控制器（多个组件共享同一个麦克风会话） */
export function getController(source: 'chat' | 'mascot', bridge: VoiceBridge): VoiceController {
  let c = controllers.get(source);
  if (!c) {
    c = new VoiceController({ api: voiceApi(bridge), source });
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
  const bridge = useMemo(() => defaultBridge(), []);
  const api = useMemo(() => (bridge ? voiceApi(bridge) : null), [bridge]);
  const controller = useMemo(
    () => (bridge ? getController(source, bridge) : null),
    [bridge, source],
  );
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
    available: !!bridge,
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
      return t('正在打开麦克风…');
    case 'recording':
      return t('正在聆听… {0}s', (s.elapsedMs / 1000).toFixed(1));
    case 'listening':
      return t('免按键：直接说话即可');
    case 'hearing':
      return t('在听你说…');
    case 'transcribing':
      return t('识别中…');
    case 'wake-armed':
      return t('等待唤醒词「{0}」', wakePhrase);
    case 'awake':
      return t('我在，请说～');
    default:
      return '';
  }
}
