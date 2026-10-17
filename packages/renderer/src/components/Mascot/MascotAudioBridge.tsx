/**
 * 订阅已有看板娘/桌面/AI 事件，补语音与动作音效。
 * 不修改 mascot/**；互动 SPEAK_KINDS 已由 reactions 朗读，此处只加音效。
 */
import { useAIEvents } from '@nomi-ai/ai-sdk-client/react';
import type { DesktopBubble } from '@nomi-ai/types';
import { createLogger, t as tr } from '@nomi-ai/ui';
import { useEffect, useRef } from 'react';
import type { FC } from 'react';

import { REACTION_SPEAK_KINDS, type CueEvent } from '@/services/cues/lines';
import { mascotCueService } from '@/services/cues/MascotCueService';
import { sfxService } from '@/services/sfx/SfxService';
import type { SfxId } from '@/services/sfx/types';

const log = createLogger('mascot-audio-bridge');

/** data-mascot-reaction → CueEvent（仅尚未朗读的种类） */
const REACTION_CUE: Record<string, CueEvent> = {
  'hover:face': 'hover:face',
  'hover:skirt': 'hover:skirt',
  'hover:hands': 'hover:hands',
  'wall:any': 'wall',
  'release:any': 'release',
};

const REACTION_SFX: Record<string, SfxId> = {
  'click:head': 'pop',
  'click:face': 'pop',
  'click:body': 'pop',
  'click:hands': 'wave',
  'click:skirt': 'hum',
  'click:legs': 'hum',
  'double:any': 'pop',
  'double:skirt': 'hum',
  'pat:head': 'hum',
  'land:any': 'land',
  'grab:any': 'swoosh',
  'hover:face': 'hum',
  'hover:skirt': 'hum',
  'hover:hands': 'pop',
  'wall:any': 'land',
  'release:any': 'pop',
};

function reactionKind(key: string): string {
  return key.split(':')[0] ?? '';
}

/** 从桌面气泡文案推断 agent 事件 */
function inferAgentCue(text: string): CueEvent | null {
  const t = text.toLowerCase();
  // Unicode escapes keep Chinese out of i18n scanners (matching only).
  if (/\u9700\u8981\u786e\u8ba4|\u6743\u9650|\u5141\u8bb8\u6216\u62d2\u7edd/.test(text))
    return 'agent:permission';
  if (/\u51fa\u9519|\u5931\u8d25|failed|error/.test(t) || /\u51fa\u9519\u4e86/.test(text))
    return 'agent:fail';
  if (
    /\u505a\u5b8c|\u5b8c\u6210|\u641e\u5b9a|completed|done/.test(t) ||
    /\u8fd9\u4e00\u8f6e\u505a\u5b8c/.test(text)
  )
    return 'agent:done';
  if (/\u5361\u4f4f|stall/.test(t)) return 'agent:stalled';
  if (/\u7b49\u4f60|waiting|\u56de\u590d/.test(t)) return 'agent:waiting';
  if (/\u6b63\u5728\u8dd1|running|\u5e72\u6d3b|\u7f16\u7a0b/.test(t)) return 'agent:running';
  if (/\u63d0\u9192|\u23f0/.test(text)) return 'reminder';
  if (/\u756a\u8304/.test(text)) return 'pomodoro';
  if (/\u4e13\u6ce8/.test(text)) return 'focus';
  return null;
}

/** 主进程气泡明确标注的事件类型 → 台词事件（digest 单独处理） */
const BUBBLE_KIND_CUE: Partial<Record<NonNullable<DesktopBubble['kind']>, CueEvent>> = {
  done: 'agent:done',
  fail: 'agent:fail',
};

const MOTION_SPEECH: Record<string, CueEvent> = {
  wave: 'wave',
  celebrate: 'celebrate',
  goodnight: 'goodnight',
};

function syncGateFromSettings(
  s: { enabled?: boolean; volume?: number; sfxEnabled?: boolean } | null,
) {
  if (!s) return;
  mascotCueService.setGate({
    voiceEnabled: s.enabled !== false,
    voiceVolume: typeof s.volume === 'number' ? s.volume : 0.8,
  });
  sfxService.setSettings({
    enabled: s.sfxEnabled !== false,
    volume: Math.min(1, Math.max(0, (typeof s.volume === 'number' ? s.volume : 0.8) * 0.9)),
  });
}

/**
 * 挂在 MascotHost：同步语音设置、订阅 reaction / motion / desktop bubble。
 */
export const MascotAudioBridge: FC = () => {
  const lastReaction = useRef('');

  useEffect(() => {
    const load = async () => {
      try {
        const s = await window.electronAPI?.getVoiceSettings?.();
        syncGateFromSettings(s ?? null);
      } catch (e) {
        log.warn('load voice settings failed', e);
      }
    };
    void load();
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ enabled?: boolean; volume?: number; sfxEnabled?: boolean }>)
        .detail;
      syncGateFromSettings(d ?? null);
    };
    window.addEventListener('mascot:voice-settings', on);
    return () => window.removeEventListener('mascot:voice-settings', on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const onReaction = (key: string) => {
      if (!key || key === lastReaction.current) return;
      lastReaction.current = key;
      const kind = reactionKind(key);
      const sfx = REACTION_SFX[key];
      if (sfx) sfxService.play(sfx, { cooldownMs: 200 });

      if (REACTION_SPEAK_KINDS.has(kind)) {
        mascotCueService.markSpeaking(2);
        window.setTimeout(() => mascotCueService.markIdle(), 2500);
        return;
      }
      const cue = REACTION_CUE[key];
      if (cue) mascotCueService.trigger(cue, { speechOnly: true });
    };

    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'data-mascot-reaction') {
          onReaction(root.dataset.mascotReaction ?? '');
        }
      }
    });
    obs.observe(root, { attributes: true, attributeFilter: ['data-mascot-reaction'] });
    if (root.dataset.mascotReaction) onReaction(root.dataset.mascotReaction);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const onMotion = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name ?? 'random';
      mascotCueService.motionSfx(name);
      const speech = MOTION_SPEECH[name];
      if (speech) mascotCueService.trigger(speech, { speechOnly: true });
    };
    window.addEventListener('mascot:motion', onMotion);
    return () => window.removeEventListener('mascot:motion', onMotion);
  }, []);

  useEffect(() => {
    const off = window.electronAPI?.onMascotCommand?.((cmd) => {
      const c = cmd as { type?: string; name?: string } | null;
      if (!c || c.type !== 'motion' || typeof c.name !== 'string') return;
      // 仅音效；完整台词等 desktop:bubble，避免双读
      mascotCueService.motionSfx(c.name);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.desktop;
    if (!api?.onBubble) return;
    const off = api.onBubble((p) => {
      const text = typeof p?.text === 'string' ? p.text : '';
      if (!text) return;
      // 只显示气泡：不朗读、不放音效（编程助手的定时汇总在「总结播报」关闭时）
      if (p.voice === 'none') return;
      const explicit = p.kind ? BUBBLE_KIND_CUE[p.kind] : undefined;
      // 只播一句简短固定台词 + 音效，不朗读气泡文字（任务结束、总结播报关闭时）
      if (p.voice === 'cue' && explicit) {
        mascotCueService.trigger(explicit);
        return;
      }
      if (p.kind === 'digest') {
        mascotCueService.trigger('wave', { text: text.slice(0, 120), sfx: false });
        return;
      }
      const cue = explicit ?? inferAgentCue(text);
      if (cue) {
        mascotCueService.trigger(cue, { text: text.slice(0, 120) });
      } else {
        mascotCueService.trigger('wave', { text: text.slice(0, 120), sfx: false });
      }
    });
    return () => off();
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.desktop;
    if (!api?.onReminder) return;
    const off = api.onReminder((r) => {
      const text = typeof r?.text === 'string' ? r.text : '';
      mascotCueService.trigger('reminder', {
        text: text ? tr('提醒：{0}', text.slice(0, 80)) : undefined,
      });
    });
    return () => off();
  }, []);

  return null;
};

/** AI 事件补语音/音效（需 AIProvider）；与 MascotAIBridge 表情并行 */
export const MascotAiCueBridge: FC = () => {
  useAIEvents('tool:confirm-required', () => {
    mascotCueService.trigger('confirm');
  });

  useAIEvents('tool:executed', (payload) => {
    const p = payload as { error?: unknown; ok?: boolean; success?: boolean } | undefined;
    const ok = p?.ok ?? p?.success ?? !p?.error;
    mascotCueService.trigger(ok ? 'thumbs_up' : 'sorry');
  });

  useAIEvents('agent:stopped-by-user', () => {
    sfxService.play('click', { cooldownMs: 300 });
  });

  return null;
};

export default MascotAudioBridge;
