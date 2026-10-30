/**
 * preload 专用通道 desktop:drop-file（host/nomiHostIpc.ts）：只收一个非空字符串路径，带上发送方 id 交给
 * dropFile（DesktopService 再判定是不是看板娘窗口）；多余参数 / 非字符串一律忽略；停止后不再接收。
 */

jest.mock('electron', () => ({ ipcMain: {} }));

import { EventEmitter } from 'node:events';

import { NOMI_HOST_DROP_FILE_CHANNEL } from '@nomi-ai/ai-sdk-client/preload';

import { serveNomiHostIpc, type NomiHostIpcMainLike } from '../../../src/host/nomiHostIpc';

describe('serveNomiHostIpc', () => {
  it('desktop:drop-file：路径与发送方 id 交给 dropFile；格式不对的忽略', () => {
    const ipc = new EventEmitter();
    const dropFile = jest.fn();
    const stop = serveNomiHostIpc({ dropFile, ipc: ipc as unknown as NomiHostIpcMainLike });
    const from = (id: number) => ({ sender: { id } });

    expect(NOMI_HOST_DROP_FILE_CHANNEL).toBe('desktop:drop-file');
    ipc.emit(NOMI_HOST_DROP_FILE_CHANNEL, from(7), '/tmp/a.txt');
    expect(dropFile).toHaveBeenCalledWith(7, '/tmp/a.txt');

    ipc.emit(NOMI_HOST_DROP_FILE_CHANNEL, from(7), '');
    ipc.emit(NOMI_HOST_DROP_FILE_CHANNEL, from(7), { path: '/etc/passwd' });
    ipc.emit(NOMI_HOST_DROP_FILE_CHANNEL, from(7), '/a', 'extra');
    expect(dropFile).toHaveBeenCalledTimes(1);

    stop();
    ipc.emit(NOMI_HOST_DROP_FILE_CHANNEL, from(7), '/tmp/b.txt');
    expect(dropFile).toHaveBeenCalledTimes(1);
    expect(ipc.listenerCount(NOMI_HOST_DROP_FILE_CHANNEL)).toBe(0);
  });
});
