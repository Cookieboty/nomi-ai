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
    host.setParameter('ParamAngleX', 0.5);
    expect(sent).toEqual([
      { type: 'motion', name: 'wave' },
      { type: 'expression', name: 'happy' },
      { type: 'parameter', id: 'ParamAngleX', value: 0.5 },
    ]);
    expect(typeof host.on('touch', jest.fn())).toBe('function');
  });

  it('registers the seam, the tools plugin and the IPC host in order', () => {
    expect(mascotIgPlugins.map((e) => e.plugin.name)).toEqual([
      'Live2dSeamPlugin',
      'WaifuToolsPlugin',
      'MascotIpcHostPlugin',
    ]);
  });
});
