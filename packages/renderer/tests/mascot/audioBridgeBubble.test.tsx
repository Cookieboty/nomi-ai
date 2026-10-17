// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trigger = vi.fn();
vi.mock('@/services/cues/MascotCueService', () => ({
  mascotCueService: {
    trigger: (...a: unknown[]) => trigger(...a),
    setGate: vi.fn(),
    motionSfx: vi.fn(),
    markSpeaking: vi.fn(),
    markIdle: vi.fn(),
  },
}));
vi.mock('@/services/sfx/SfxService', () => ({
  sfxService: { play: vi.fn(), setSettings: vi.fn(), setMuted: vi.fn() },
}));
vi.mock('@nomi-ai/ai-sdk-client/react', () => ({ useAIEvents: vi.fn() }));

type Bubble = { text: string; voice?: string; kind?: string };

describe('MascotAudioBridge: 编程助手气泡的出声方式', () => {
  let emit: (p: Bubble) => void;

  beforeEach(async () => {
    trigger.mockClear();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getVoiceSettings: async () => null,
      desktop: {
        onBubble: (cb: (p: Bubble) => void) => {
          emit = cb;
          return () => undefined;
        },
        onReminder: () => () => undefined,
      },
    };
    const { MascotAudioBridge } = await import('../../src/components/Mascot/MascotAudioBridge');
    render(<MascotAudioBridge />);
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('voice=none：只显示气泡，不朗读也不放音效', () => {
    emit({ text: '还有 2 个编程任务进行中', kind: 'digest', voice: 'none' });
    expect(trigger).not.toHaveBeenCalled();
  });

  it('voice=cue（总结播报关）：只触发固定台词事件，不带气泡文字', () => {
    emit({ text: 'Claude Code 完成了任务「x」', kind: 'done', voice: 'cue' });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith('agent:done');
    emit({ text: 'x 失败了：权限不足', kind: 'fail', voice: 'cue' });
    expect(trigger).toHaveBeenLastCalledWith('agent:fail');
  });

  it('voice=full（总结播报开）：朗读总结文字', () => {
    emit({ text: 'Claude Code 完成了任务「x」，结果：好了', kind: 'done', voice: 'full' });
    expect(trigger).toHaveBeenCalledWith(
      'agent:done',
      expect.objectContaining({ text: expect.stringContaining('结果：好了') }),
    );
    emit({ text: '还有 2 个编程任务进行中：「a」在测试', kind: 'digest', voice: 'full' });
    expect(trigger).toHaveBeenLastCalledWith(
      'wave',
      expect.objectContaining({ sfx: false, text: expect.stringContaining('2 个') }),
    );
  });

  it('没有 voice 字段：沿用原有按文案推断', () => {
    emit({ text: 'Codex 需要确认工具权限：Bash' });
    expect(trigger).toHaveBeenCalledWith('agent:permission', expect.anything());
  });
});
