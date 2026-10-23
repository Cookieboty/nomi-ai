import { EventEmitter } from 'node:events';

import { geometryEventNames, onGeometryChange } from '../../../src/core/windowGeometryEvents';

describe('windowGeometryEvents', () => {
  it('uses moved / resized on mac and windows, move / resize on linux', () => {
    expect(geometryEventNames({}, 'win32')).toEqual(['moved']);
    expect(geometryEventNames({ resize: true }, 'darwin')).toEqual(['moved', 'resized']);
    expect(geometryEventNames({}, 'linux')).toEqual(['move']);
    expect(geometryEventNames({ resize: true }, 'linux')).toEqual(['move', 'resize']);
  });

  it('on linux a continuous move / resize (no moved event) still reaches the listener', () => {
    const win = new EventEmitter();
    const fn = jest.fn();
    onGeometryChange(win, fn, { resize: true }, 'linux');
    win.emit('move');
    win.emit('resize');
    win.emit('moved'); // never fired on linux; must not be what we rely on
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('on windows only the settled events are subscribed', () => {
    const win = new EventEmitter();
    const fn = jest.fn();
    onGeometryChange(win, fn, { resize: true }, 'win32');
    win.emit('move');
    win.emit('resize');
    expect(fn).not.toHaveBeenCalled();
    win.emit('moved');
    win.emit('resized');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
