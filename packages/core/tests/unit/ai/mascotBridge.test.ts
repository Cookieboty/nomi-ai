import { createIpcMascotHost, createMascotIgPlugins } from '../../../src/ai/mascotBridge';
import type { MascotCommand } from '../../../src/ai/mascotCommand';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

describe('mascotBridge', () => {
  it('forwards AI motion / expression tool calls to the renderer', async () => {
    const sent: MascotCommand[] = [];
    const host = createIpcMascotHost((cmd) => {
      sent.push(cmd);
    });
    await host.playMotion('wave');
    await host.setExpression('happy');
    expect(sent).toEqual([
      { type: 'motion', name: 'wave' },
      { type: 'expression', name: 'happy' },
    ]);
    expect(typeof host.on('touch', jest.fn())).toBe('function');
  });

  it('registers the seam, the tools plugin and the IPC host in order', () => {
    expect(createMascotIgPlugins(createRecordingAppEvents()).map((e) => e.plugin.name)).toEqual([
      'AvatarSeamPlugin',
      'WaifuToolsPlugin',
      'MascotIpcHostPlugin',
    ]);
  });
});
