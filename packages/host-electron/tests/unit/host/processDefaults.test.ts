/**
 * 主进程的模块级宿主设置：日志按 `app.isPackaged` 静默，私有文件的根目录是 userData，
 * 看板娘指令报告存活的窗口数。
 */
const mockApp = { isPackaged: true, getPath: jest.fn(() => '/user-data') };
const live = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
const dead = { isDestroyed: () => true, webContents: { isDestroyed: () => true } };
jest.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: { getAllWindows: () => [live, dead, live] },
}));

import { broadcastMascotCommand, setMascotLiveWindows } from '@nomi-ai/core/ai/mascotCommand';
import { isVerboseMainLogging, setMainLogPackaged } from '@nomi-ai/core/utils/log';
import { setPrivateRoot } from '@nomi-ai/core/utils/privateFile';

describe('host/processDefaults', () => {
  const debug = process.env.NOMI_DEBUG;
  beforeEach(() => {
    delete process.env.NOMI_DEBUG;
    setMainLogPackaged(null);
  });
  afterAll(() => {
    if (debug === undefined) delete process.env.NOMI_DEBUG;
    else process.env.NOMI_DEBUG = debug;
    setMainLogPackaged(null);
    setPrivateRoot(null);
    setMascotLiveWindows(null);
  });

  it('没设置时日志按开发态（与工具子进程一致），看板娘指令报 0 个窗口', () => {
    expect(isVerboseMainLogging()).toBe(true);
    expect(broadcastMascotCommand({ type: 'motion', name: 'wave' })).toBe(0);
  });

  it('加载后日志跟 app.isPackaged；NOMI_DEBUG=1 仍可打开', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 加载即生效的模块
    require('../../../src/host/processDefaults');
    expect(isVerboseMainLogging()).toBe(false);
    mockApp.isPackaged = false;
    expect(isVerboseMainLogging()).toBe(true);
    mockApp.isPackaged = true;
    process.env.NOMI_DEBUG = '1';
    expect(isVerboseMainLogging()).toBe(true);
    expect(broadcastMascotCommand({ type: 'motion', name: 'wave' })).toBe(2);
  });
});
