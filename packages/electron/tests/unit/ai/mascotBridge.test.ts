import { createIpcMascotHost, mascotIgPlugins } from '../../../src/ai/mascotBridge';
import type { MascotCommand } from '../../../src/ai/mascotCommand';

describe('mascotBridge', () => {
  it('forwards AI motion / expression tool calls to the renderer', async () => {
    const sent: MascotCommand[] = [];
    const host = createIpcMascotHost((cmd) => {
      sent.push(cmd);
      return 1;
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
    expect(mascotIgPlugins.map((e) => e.plugin.name)).toEqual([
      'AvatarSeamPlugin',
      'WaifuToolsPlugin',
      'MascotIpcHostPlugin',
    ]);
  });
});
