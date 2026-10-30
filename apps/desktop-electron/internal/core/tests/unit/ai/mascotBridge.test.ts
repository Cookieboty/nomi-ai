import { createIpcMascotHost, createMascotIgPlugins } from '../../../src/ai/mascotBridge';
import { type AvatarCue } from '../../../src/ai/mascotCommand';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

describe('mascotBridge', () => {
  it('forwards the AI semantic events (gesture / emotion / activity) to the character window', async () => {
    const sent: AvatarCue[] = [];
    const host = createIpcMascotHost((cue) => {
      sent.push(cue);
    });
    await host.gesture('thumbsUp');
    await host.emotion('happy');
    await host.emotion('sad', 0.5);
    await host.activity('thinking');
    host.speaking(0.4); // 口型由角色窗口本地驱动，不经内核
    expect(sent).toEqual([
      { type: 'gesture', name: 'thumbsUp' },
      { type: 'emotion', name: 'happy' },
      { type: 'emotion', name: 'sad', weight: 0.5 },
      { type: 'activity', name: 'thinking' },
    ]);
  });

  it('registers the seam, the tools, the companion preset and the IPC host in order', () => {
    expect(createMascotIgPlugins(createRecordingAppEvents()).map((e) => e.plugin.name)).toEqual([
      'AvatarSeamPlugin',
      'CompanionToolsPlugin',
      'CompanionAgentPresetPlugin',
      'MascotIpcHostPlugin',
    ]);
  });

  it('publishes the cues on the core instance event bus as avatar:event', async () => {
    const events = createRecordingAppEvents();
    const plugins = createMascotIgPlugins(events);
    const hostPlugin = plugins.at(-1)!.plugin;
    let attached: ReturnType<typeof createIpcMascotHost> | undefined;
    const ctx = {
      inject: () => ({
        attachHost: (h: ReturnType<typeof createIpcMascotHost>) => {
          attached = h;
          return () => undefined;
        },
      }),
      logger: { warn: jest.fn() },
    };
    await hostPlugin.apply(ctx as never, {} as never);
    await attached!.gesture('wave');
    expect(events.published).toEqual([
      { event: 'avatar.event', payload: { type: 'gesture', name: 'wave' }, surfaces: null },
    ]);
  });
});
