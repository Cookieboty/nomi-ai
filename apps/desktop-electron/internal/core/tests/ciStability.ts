/**
 * 测试框架层的稳定性（core 与 host-electron 的 Jest 都在 setupFilesAfterEnv 第一个加载）。
 * Windows runner 磁盘慢、临时目录是 8.3 短名，以往的偶发失败几乎都是下面三类，在这里统一处理，
 * 不再逐个用例打补丁：
 *
 * 1. Windows：TEMP / TMP 改指长路径。`mkdtemp(os.tmpdir())` 拿到的路径与代码规范化后的一致
 *    （RUNNER~1 → runneradmin）。
 * 2. 每个用例结束等私有文件的异步写队列清空（utils/privateFile 把 whenPrivateWritesIdle 登记在
 *    globalThis 上）：上一个用例没写完的落盘不会拖进下一个用例、撞上它的 mock。
 * 3. 每个测试文件结束清掉它建的定时器：同一 worker 里，漏关的落盘 / 轮询定时器不会在后面的文件里触发。
 *
 * Windows 上的默认超时在 jest.config.js（30 s）。
 */
import type * as FsModule from 'node:fs';
import type * as OsModule from 'node:os';

const realFs = jest.requireActual<typeof FsModule>('node:fs');
const realOs = jest.requireActual<typeof OsModule>('node:os');

if (process.platform === 'win32') {
  try {
    const long = realFs.realpathSync.native(realOs.tmpdir());
    process.env.TEMP = long;
    process.env.TMP = long;
  } catch {
    /* 取不到长路径就保持原样 */
  }
}

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const fileTimers = new Set<ReturnType<typeof setTimeout>>();

globalThis.setTimeout = Object.assign(function (
  this: unknown,
  ...args: Parameters<typeof setTimeout>
) {
  const t = realSetTimeout.apply(this, args);
  fileTimers.add(t);
  return t;
}, realSetTimeout) as typeof setTimeout;

globalThis.setInterval = Object.assign(function (
  this: unknown,
  ...args: Parameters<typeof setInterval>
) {
  const t = realSetInterval.apply(this, args);
  fileTimers.add(t);
  return t;
}, realSetInterval) as typeof setInterval;

type IdleHook = () => Promise<void>;
const IDLE_CAP_MS = 5_000;

afterEach(async () => {
  const hooks = (globalThis as { __nomiPrivateWritesIdle?: Set<IdleHook> }).__nomiPrivateWritesIdle;
  if (!hooks?.size) return;
  let cap: ReturnType<typeof setTimeout> | undefined;
  // 有用例故意让写入一直挂着（mock rename）时不卡住整个文件：最多等 IDLE_CAP_MS
  await Promise.race([
    Promise.all([...hooks].map((idle) => idle().catch(() => undefined))),
    new Promise<void>((resolve) => {
      cap = realSetTimeout(resolve, IDLE_CAP_MS);
    }),
  ]);
  realClearTimeout(cap);
});

afterAll(() => {
  for (const t of fileTimers) realClearTimeout(t); // Node 里 clearTimeout 也能清 interval
  fileTimers.clear();
});
