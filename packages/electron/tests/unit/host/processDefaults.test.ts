/**
 * 主进程的模块级宿主设置：日志按 `app.isPackaged` 静默，私有文件的根目录是 userData。
 */
const mockApp = { isPackaged: true, getPath: jest.fn(() => '/user-data') };
jest.mock('electron', () => ({ app: mockApp }));

import { isVerboseMainLogging, setMainLogPackaged } from '../../../src/utils/log';
import { setPrivateRoot } from '../../../src/utils/privateFile';

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
  });

  it('没设置时日志按开发态（与工具子进程一致）', () => {
    expect(isVerboseMainLogging()).toBe(true);
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
  });
});
