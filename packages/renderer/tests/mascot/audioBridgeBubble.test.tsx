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
// 桌面气泡经契约事件 desktop.bubble（D1）：视图走 createTestClient 的完整线协议
vi.mock('@/services/api', async () => {
  const { appContract } = await import('@nomi-ai/contract/app');
  const { createTestClient } = await import('@nomi-ai/contract/testing');
  const client = createTestClient(
    appContract,
    { 'voice.getMascotSettings': () => null },
    { caller: { surface: 'mascot', trusted: true } },
  );
  (globalThis as Record<string, unknown>).__d1AudioBridgeHost = client;
  return { api: client.api, hasTransport: () => true };
});

type Bubble = { text: string; voice?: string; kind?: string };

describe('MascotAudioBridge: 编程助手气泡的出声方式', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** 主进程推一条 desktop:bubble（经事件桥成为契约事件 desktop.bubble），等它送达 */
  const emit = async (p: Bubble) => {
    const host = (globalThis as Record<string, unknown>).__d1AudioBridgeHost as {
      router: { events: { publish(e: string, d: unknown): void } };
    };
    host.router.events.publish('desktop.bubble', p);
    await tick();
  };

  beforeEach(async () => {
    trigger.mockClear();
    const { MascotAudioBridge } = await import('../../src/components/Mascot/MascotAudioBridge');
    render(<MascotAudioBridge />);
    // 订阅帧异步送达
    await tick();
  });
  afterEach(() => {
    cleanup();
  });

  it('voice=none：只显示气泡，不朗读也不放音效', async () => {
    await emit({ text: '还有 2 个编程任务进行中', kind: 'digest', voice: 'none' });
    expect(trigger).not.toHaveBeenCalled();
  });

  it('voice=cue（消息语音播报关）：只播放事件提示音，不朗读气泡文字', async () => {
    await emit({ text: 'Claude Code 完成了任务「x」', kind: 'done', voice: 'cue' });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith('agent:done', { sfxOnly: true });
    await emit({ text: 'x 失败了：权限不足', kind: 'fail', voice: 'cue' });
    expect(trigger).toHaveBeenLastCalledWith('agent:fail', { sfxOnly: true });
    await emit({ text: 'Codex 好像卡住了，要不要去看看？', voice: 'cue' });
    expect(trigger).toHaveBeenLastCalledWith('agent:stalled', { sfxOnly: true });
  });

  it('voice=full（消息语音播报开）：朗读通知文字', async () => {
    await emit({ text: 'Claude Code 完成了任务「x」，结果：好了', kind: 'done', voice: 'full' });
    expect(trigger).toHaveBeenCalledWith(
      'agent:done',
      expect.objectContaining({ text: expect.stringContaining('结果：好了') }),
    );
    await emit({ text: '还有 2 个编程任务进行中：「a」在测试', kind: 'digest', voice: 'full' });
    expect(trigger).toHaveBeenLastCalledWith(
      'wave',
      expect.objectContaining({ sfx: false, text: expect.stringContaining('2 个') }),
    );
  });

  it('没有 voice 字段：沿用原有按文案推断', async () => {
    await emit({ text: 'Codex 需要确认工具权限：Bash' });
    expect(trigger).toHaveBeenCalledWith('agent:permission', expect.anything());
  });
});
