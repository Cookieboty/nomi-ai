/** 内存角色包样例（测试用；名字刻意与官方角色无关）。 */
import { CONTRACT } from '../src';

export const ONBOARDING = {
  'onboarding/welcome.webp': true,
  'onboarding/profile.webp': true,
  'onboarding/provider.webp': true,
  'onboarding/privacy.webp': true,
};

/** 新形状的 static 包：persona.json + mapping.json + locales/ + manifest.layout。 */
export function staticPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'manifest.json': {
      schema: 1,
      id: 'test-dummy',
      contractVersion: 1,
      version: '1.0.0',
      assets: { mode: 'static', static: 'static/character.webp' },
      capabilities: { spriteActions: ['wave', 'nod'] },
      layout: {
        window: { width: 320, height: 480 },
        hitboxes: { head: { top: 0, bottom: 0.3, left: 0.2, right: 0.8 } },
        bubbleAnchor: { x: 0.7, y: 0.2 },
      },
    },
    'static/character.webp': true,
    ...ONBOARDING,
    'persona.json': {
      displayName: '替身',
      systemPromptIdentity: '你是替身，一个测试角色。',
      addressUser: '同学',
      greetings: ['你好呀'],
      tips: ['记得喝水'],
    },
    'mapping.json': {
      emotions: { happy: 'wave' },
      activities: { thinking: ['nod'] },
      gestures: { wave: 'wave' },
    },
    'locales/zh.json': {
      wakePhrase: '你好，替身',
      lines: { 'greet-hello': '你好！', 'tip-ask-me-anything': '问我吧' },
    },
    'locales/en.json': {
      persona: { displayName: 'Dummy', systemPromptIdentity: 'You are Dummy, a test character.' },
      wakePhrase: 'Hi, Dummy',
      lines: { 'greet-hello': 'Hello!', 'tip-ask-me-anything': 'Ask me' },
    },
    ...overrides,
  };
}

/** 旧形状的 rive 包：无 contractVersion、copy/、persona/system-prompt.md、layout/hitboxes.json(skirt)。 */
export function legacyRivePack(): Record<string, unknown> {
  const clips = CONTRACT.voice.requiredClipIds.map((id) => ({ id, file: `${id}.mp3` }));
  const voiceFiles = Object.fromEntries(clips.map((c) => [`voice/zh/${c.file}`, true]));
  return {
    'manifest.json': {
      schema: 1,
      id: 'legacy-rive',
      displayName: { zh: '旧角色', en: 'Legacy' },
      engines: { nomiPack: '>=1 <2' },
      assets: { rive: 'rive/character.riv', sprite: 'sprite/', layout: 'layout/' },
      mode: 'rive',
      capabilities: {
        voiceClipIds: ['ui.cli-monitor.hi-i-m-nomi', 'greet-hello'],
      },
    },
    'rive/character.riv': true,
    'sprite/manifest.json': { layers: [] },
    'sprite/thumb.png': true,
    ...ONBOARDING,
    'layout/hitboxes.json': {
      regions: {
        head: { top: 0.04, bottom: 0.28, left: 0.16, right: 0.84 },
        skirt: { top: 0.6, bottom: 1, left: 0.15, right: 0.85 },
      },
      bubbleAnchor: { x: 0.72, y: 0.18 },
    },
    'copy/zh.json': {
      displayName: '旧角色',
      wakePhrase: '你好，旧角色',
      systemPromptIdentity: '你是旧角色。',
    },
    'copy/en.json': { displayName: 'Legacy', wakePhrase: 'Hi, Legacy' },
    'persona/system-prompt.md': '你是旧角色（system prompt）。\n保持简短。',
    'voice/zh/manifest.json': { idSchema: 'stable-v1', clips },
    ...voiceFiles,
  };
}
