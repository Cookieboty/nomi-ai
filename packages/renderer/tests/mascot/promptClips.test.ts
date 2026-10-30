import { repoPath } from '@nomi-ai/repo-paths';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as 'zh-CN' | 'en',
  muted: false,
  play: vi.fn(async (_src: string, _o?: { onEnd?: () => void }) => true),
}));

vi.mock('@nomi-ai/ui', async (orig) => ({
  ...(await orig<typeof import('@nomi-ai/ui')>()),
  getLocale: () => h.locale,
  t: (k: string) => (k === 'ui.cli-monitor.okay' ? '好的～' : k),
}));
vi.mock('../../src/mascot/presence', () => ({ isMascotMuted: () => h.muted }));
vi.mock('../../src/mascot/tts/audioPlayback', () => ({ playAudioClip: h.play }));
// 角色包快照经契约 character.getActivePack（D5）；没装假宿主时视图按「没有主进程」处理
vi.mock('../../src/services/api', async () => (await import('./mascotHost')).mascotApiModule());

import { resetCharacterPackOverlayForTest } from '../../src/mascot/characterConfig';
import {
  CLIP_HINTS,
  __resetPromptClipsForTests,
  isNoAudioLine,
  playPromptClip,
} from '../../src/mascot/voice/promptClips';

import { installMascotHost, packSnapshot, resetMascotHost } from './mascotHost';

const manifest = {
  idSchema: 'stable-v1',
  clips: [
    {
      id: 'ack-okay',
      key: 'ack-okay',
      i18nKey: 'ui.cli-monitor.okay',
      text: '好的～',
      file: 'ack-okay.mp3',
    },
    {
      id: 'remind-time',
      key: 'remind-time',
      i18nKey: 'ui.cli-monitor.reminder-time',
      text: '提醒时间到！',
      file: 'remind-time.mp3',
    },
  ],
};

let promptVoice = true;

beforeEach(() => {
  __resetPromptClipsForTests();
  resetCharacterPackOverlayForTest();
  h.locale = 'zh-CN';
  h.muted = false;
  promptVoice = true;
  h.play.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => manifest })),
  );
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('promptClips', () => {
  it('plays the clip for a Nomi line by legacy i18n key (one-release alias)', async () => {
    await expect(playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' })).resolves.toBe(
      'played',
    );
    expect(h.play).toHaveBeenCalledWith('./character/voice/zh/ack-okay.mp3', {
      volume: undefined,
      onEnd: undefined,
    });
  });

  it('plays by stable id', async () => {
    await expect(playPromptClip('ack-okay', { modelName: 'nomi' })).resolves.toBe('played');
    expect(h.play.mock.calls[0]![0]).toContain('ack-okay.mp3');
  });

  it('matches translated text back to its clip', async () => {
    await expect(playPromptClip('好的～', { modelName: 'nomi' })).resolves.toBe('played');
  });

  it('uses an explicit clip hint for variable lines', async () => {
    await playPromptClip('提醒：交周报', { modelName: 'nomi', clip: CLIP_HINTS.reminder });
    expect(h.play.mock.calls[0]![0]).toContain('remind-time.mp3');
  });

  it('dedupes the bubble and speech paths firing together', async () => {
    const [a, b] = await Promise.all([
      playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' }),
      playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' }),
    ]);
    expect([a, b].sort()).toEqual(['duplicate', 'played']);
    expect(h.play).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way for other models, English UI, muted or prompt voice off', async () => {
    expect(await playPromptClip('ui.cli-monitor.okay', { modelName: 'other' })).toBe('none');
    h.locale = 'en';
    expect(await playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' })).toBe('none');
    h.locale = 'zh-CN';
    h.muted = true;
    expect(await playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' })).toBe('none');
    h.muted = false;
    promptVoice = false;
    // 提示语音开关经契约 tts.promptVoice（D1）
    installMascotHost({
      'tts.promptVoice': () => promptVoice,
      'character.getActivePack': () => packSnapshot({}),
    });
    onTestFinished(resetMascotHost);
    expect(await playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' })).toBe('none');
    expect(await playPromptClip('没有这句', { modelName: 'nomi' })).toBe('none');
    expect(h.play).not.toHaveBeenCalled();
  });

  it('keeps text-only lines silent', () => {
    expect(isNoAudioLine('ui.voice-mascot.canvas-not-found-can-t-take-a-screenshot')).toBe(true);
    expect(isNoAudioLine('ui.voice-mascot.ai-chat-requires-the-electron-environment')).toBe(true);
    expect(isNoAudioLine('ui.cli-monitor.okay')).toBe(false);
  });
});

describe('bundled manifest', () => {
  it('has a file for every clip and covers the variable-line hints', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = repoPath('characters/nomi/voice/zh');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      voice: string;
      idSchema?: string;
      clips: Array<{ id?: string; key: string; i18nKey?: string; file: string }>;
    };
    expect(m.voice).toBe('zh-CN-XiaoyiNeural');
    expect(m.idSchema).toBe('stable-v1');
    for (const c of m.clips) expect(fs.existsSync(path.join(dir, c.file))).toBe(true);
    const ids = new Set(m.clips.map((c) => c.id || c.key));
    for (const k of Object.values(CLIP_HINTS)) expect(ids.has(k)).toBe(true);
    const i18n = new Set(m.clips.map((c) => c.i18nKey).filter(Boolean));
    expect(i18n.has('ui.voice-mascot.canvas-not-found-can-t-take-a-screenshot')).toBe(true);
  });
});

describe('legacyClipIds rename mapping', () => {
  it('maps every legacy i18n key to a stable id present in the bundled manifest', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const legacy = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../src/mascot/voice/legacyClipIds.json'), 'utf8'),
    ) as { byLegacyKey: Record<string, string> };
    const dir = repoPath('characters/nomi/voice/zh');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      clips: Array<{ id?: string; key: string }>;
    };
    const ids = new Set(m.clips.map((c) => c.id || c.key));
    const missing: string[] = [];
    for (const [legacyKey, id] of Object.entries(legacy.byLegacyKey)) {
      if (!ids.has(id)) missing.push(`${legacyKey} → ${id}`);
    }
    expect(missing).toEqual([]);
    expect(Object.keys(legacy.byLegacyKey).length).toBeGreaterThan(50);
  });
});

describe('Scheme B overlay voice', () => {
  it('loads the overlay manifest and plays for the built-in model slot', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => manifest }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {});
    installMascotHost({
      'tts.promptVoice': () => true,
      'character.getActivePack': () =>
        packSnapshot({
          source: 'userData',
          id: 'alt',
          mode: 'static',
          voiceBaseUrl: 'character-pack://pack/voice/zh/',
        }),
    });
    onTestFinished(resetMascotHost);
    const r = await playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' });
    expect(r).toBe('played');
    // Manifest fetch waits for the overlay, so index and clip share the overlay base.
    expect(fetchMock).toHaveBeenCalledWith('character-pack://pack/voice/zh/manifest.json');
    expect(h.play.mock.calls[0][0]).toBe('character-pack://pack/voice/zh/ack-okay.mp3');
  });
});
