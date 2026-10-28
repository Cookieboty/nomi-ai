/**
 * 看板娘事件台词编排：多条随机、冷却、优先级打断、尊重语音开关与音量。
 * 不修改 mascot 源文件；由桥接订阅已有事件后调用。
 */
import { createLogger, t } from '@nomi-ai/ui';

import { speakForActiveCharacter } from '../../mascot/characterVoice';
import type { SoftSpeechPrefs } from '../../mascot/softSpeech';
import { stopAllSpeech } from '../../mascot/speechStop';
import { sfxService } from '../sfx/SfxService';
import type { SfxId } from '../sfx/types';

import { CUE_LINES, CUE_META, type CueEvent } from './lines';

const log = createLogger('mascot-cue');

export interface CueSpeakOpts {
  /** 覆盖默认台词 */
  text?: string;
  /** 角色提示语音片段 key（变量台词播固定句）；null 表示不播预录片段 */
  clip?: string | null;
  /** 是否同时播音效（默认 true） */
  sfx?: boolean;
  /** 强制打断同级或更低优先级 */
  force?: boolean;
  /** 仅音效不朗读 */
  sfxOnly?: boolean;
  /** 仅朗读不音效 */
  speechOnly?: boolean;
  now?: number;
}

export interface CueGate {
  /** 语音总开关 */
  voiceEnabled: boolean;
  /** 语音音量 0..1 */
  voiceVolume: number;
  /** 勿扰（静音一切主动播报） */
  quiet?: boolean;
}

type Listener = (gate: CueGate) => void;

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)]!;
}

export class MascotCueService {
  private gate: CueGate = { voiceEnabled: true, voiceVolume: 0.8, quiet: false };
  private lastByEvent = new Map<string, number>();
  private currentPriority = 0;
  private speaking = false;
  private readonly listeners = new Set<Listener>();

  getGate(): CueGate {
    return { ...this.gate };
  }

  setGate(patch: Partial<CueGate>): void {
    this.gate = { ...this.gate, ...patch };
    sfxService.setMuted(!!this.gate.quiet || this.gate.voiceVolume <= 0);
    if (typeof patch.voiceVolume === 'number') {
      sfxService.setSettings({ volume: Math.min(1, Math.max(0, patch.voiceVolume * 0.9)) });
    }
    for (const l of this.listeners) l(this.getGate());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 当前是否允许朗读 */
  canSpeak(): boolean {
    return this.gate.voiceEnabled && !this.gate.quiet && this.gate.voiceVolume > 0.001;
  }

  /**
   * 触发一个命名事件：冷却 → 优先级 → 随机台词 → TTS + 可选 SFX。
   * 返回是否实际播出了语音或音效。
   */
  trigger(event: CueEvent, opts: CueSpeakOpts = {}): boolean {
    const meta = CUE_META[event];
    const lines = CUE_LINES[event];
    if (!meta) return false;
    const now = opts.now ?? performance.now();
    const last = this.lastByEvent.get(event) ?? -Infinity;
    if (now - last < meta.cooldownMs && !opts.force) return false;

    const wantSfx = opts.sfx !== false && !opts.speechOnly;
    const wantSpeech = !opts.sfxOnly;
    const priority = meta.priority;

    if (wantSpeech && this.speaking && priority < this.currentPriority && !opts.force) {
      // 低优先级不打断；仍可播轻音效
      if (wantSfx && meta.sfx) sfxService.play(meta.sfx as SfxId, { cooldownMs: 200 });
      return false;
    }

    this.lastByEvent.set(event, now);

    let did = false;
    if (wantSfx && meta.sfx) {
      did = sfxService.play(meta.sfx as SfxId, { cooldownMs: 80 }) || did;
    }

    if (wantSpeech && this.canSpeak()) {
      // CUE_LINES 存的是 key：key 原样交给朗读（便于匹配预录片段），普通文本截断
      // 台词被精简掉的事件（lines 为空）不说话，只保留音效
      const custom = opts.text?.trim();
      const text = custom ? t(custom).slice(0, 160) : lines?.length ? pick(lines) : '';
      if (text) {
        if (this.speaking && priority >= this.currentPriority) stopAllSpeech();
        this.speaking = true;
        this.currentPriority = priority;
        try {
          speakForActiveCharacter(text, {
            clip: opts.clip,
            prefs: { volume: this.gate.voiceVolume } as SoftSpeechPrefs,
            onEnd: () => {
              this.speaking = false;
              this.currentPriority = 0;
            },
          });
          did = true;
        } catch (e) {
          log.warn('speak failed', event, e);
          this.speaking = false;
          this.currentPriority = 0;
        }
      }
    }
    return did;
  }

  /** 仅播放与动作名对应的音效（工具栏随机动作等） */
  motionSfx(motionName: string): boolean {
    const map: Record<string, CueEvent> = {
      wave: 'wave',
      think: 'think',
      celebrate: 'celebrate',
      sorry: 'sorry',
      thumbs_up: 'thumbs_up',
      goodnight: 'goodnight',
      nod: 'nod',
      clap: 'clap',
      poke: 'poke',
      flinch: 'poke',
      shake: 'angry',
      interact: 'confirm',
      work: 'think',
      surprise: 'file:drop',
      random: 'nod',
    };
    const ev = map[motionName];
    if (!ev) {
      return sfxService.play('pop', { cooldownMs: 150 });
    }
    return this.trigger(ev, { sfxOnly: true });
  }

  /** 测试用 */
  resetForTests(): void {
    this.lastByEvent.clear();
    this.speaking = false;
    this.currentPriority = 0;
  }

  /** 暴露给单测：冷却是否挡住 */
  wouldCooldown(event: CueEvent, now = performance.now()): boolean {
    const meta = CUE_META[event];
    if (!meta) return true;
    return now - (this.lastByEvent.get(event) ?? -Infinity) < meta.cooldownMs;
  }

  getCurrentPriority(): number {
    return this.currentPriority;
  }

  /** 标记正在说话（供外部 SPEAK_KINDS 同步优先级，避免立刻被低优打断） */
  markSpeaking(priority: number): void {
    this.speaking = true;
    this.currentPriority = priority;
  }

  markIdle(): void {
    this.speaking = false;
    this.currentPriority = 0;
  }
}

export const mascotCueService = new MascotCueService();
