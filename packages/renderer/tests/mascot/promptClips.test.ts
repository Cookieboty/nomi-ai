import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  CLIP_HINTS,
  __resetPromptClipsForTests,
  isNoAudioLine,
  playPromptClip,
} from '../../src/mascot/voice/promptClips';

const manifest = {
  clips: [
    { key: 'ui.cli-monitor.okay', text: '好的～', file: 'ui.cli-monitor.okay.mp3' },
    {
      key: 'ui.cli-monitor.reminder-time',
      text: '提醒时间到！',
      file: 'ui.cli-monitor.reminder-time.mp3',
    },
  ],
};

let promptVoice = true;

beforeEach(() => {
  __resetPromptClipsForTests();
  h.locale = 'zh-CN';
  h.muted = false;
  promptVoice = true;
  h.play.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => manifest })),
  );
  vi.stubGlobal('window', { electronAPI: { ttsPromptVoice: async () => promptVoice } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('promptClips', () => {
  it('plays the clip for a Nomi line by key', async () => {
    await expect(playPromptClip('ui.cli-monitor.okay', { modelName: 'nomi' })).resolves.toBe(
      'played',
    );
    expect(h.play).toHaveBeenCalledWith('./voice/nomi/zh/ui.cli-monitor.okay.mp3', {
      volume: undefined,
      onEnd: undefined,
    });
  });

  it('matches translated text back to its clip', async () => {
    await expect(playPromptClip('好的～', { modelName: 'nomi' })).resolves.toBe('played');
  });

  it('uses an explicit clip hint for variable lines', async () => {
    await playPromptClip('提醒：交周报', { modelName: 'nomi', clip: CLIP_HINTS.reminder });
    expect(h.play.mock.calls[0]![0]).toContain('ui.cli-monitor.reminder-time.mp3');
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
    const dir = path.resolve(__dirname, '../../public/voice/nomi/zh');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      voice: string;
      clips: Array<{ key: string; file: string }>;
    };
    expect(m.voice).toBe('zh-CN-XiaoyiNeural');
    for (const c of m.clips) expect(fs.existsSync(path.join(dir, c.file))).toBe(true);
    const keys = new Set(m.clips.map((c) => c.key));
    for (const k of Object.values(CLIP_HINTS)) expect(keys.has(k)).toBe(true);
    expect(keys.has('ui.voice-mascot.canvas-not-found-can-t-take-a-screenshot')).toBe(true);
  });
});
