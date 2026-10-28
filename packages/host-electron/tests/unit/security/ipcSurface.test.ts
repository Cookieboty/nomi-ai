/**
 * 主进程的 IPC 面只有契约传输（docs/design/core-host-decoupling.md §8、§11.1、§12 P1b）：
 * - 视图的调用只经 `contract:request`（host/contractIpc.ts，sender 白名单 + surface / dangerous 守卫）；
 * - 推送只经 `contract:frame`（契约事件，由内核的应用事件总线发布）；
 * - 唯一的例外是看板娘 preload 的 `desktop:drop-file`（host/nomiHostIpc.ts）：路径由 preload 从真实 File
 *   取得，不能做成视图可以随意传参的契约过程。
 *
 * 静态扫描 src 与内核（packages/core/src）：宿主目录之外不得注册 ipcMain 通道，任何地方都不得直接 `webContents.send`
 * （绕过契约的推送，preload 也收不到）。lint 规则拦新代码，这里再兜一层，覆盖 lint 抓不到的写法。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../../src');
/** 内核（@nomi-ai/core）：业务模块搬出去以后也要扫 */
const CORE_SRC = path.resolve(__dirname, '../../../../core/src');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) sources(file, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(file);
  }
  return out;
}

/** 去掉注释，免得说明文字里提到的旧写法被当成代码 */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (f: string) =>
  f.startsWith(CORE_SRC + path.sep)
    ? `@nomi-ai/core/${path.relative(CORE_SRC, f).split(path.sep).join('/')}`
    : path.relative(SRC, f).split(path.sep).join('/');

describe('主进程 IPC 面', () => {
  const files = [...sources(SRC), ...sources(CORE_SRC)];

  it('内核源码也在扫描范围里', () => {
    expect(files.some((f) => rel(f) === '@nomi-ai/core/desktop/DesktopService.ts')).toBe(true);
  });

  it('宿主目录之外没有 ipcMain 注册', () => {
    const hits = files
      .filter((f) => !rel(f).startsWith('host/'))
      .filter((f) => /\bipcMain\s*\.\s*(handle|handleOnce|on|once|addListener)\s*\(/.test(code(f)))
      .map(rel);
    expect(hits).toEqual([]);
  });

  it('宿主目录里只有契约传输的 IpcAdapter 与 preload 专用通道直接用 ipcMain', () => {
    // host/electronIpcAdapter.ts：契约传输（host/contractIpc.ts）底下的 ipcMain 适配，原在 ai-runtime；
    // host/nomiHostIpc.ts：desktop:drop-file
    const hits = files
      .filter((f) => rel(f).startsWith('host/'))
      .filter((f) => /\bipcMain\b/.test(code(f)))
      .map(rel)
      .sort();
    expect(hits).toEqual(['host/electronIpcAdapter.ts', 'host/nomiHostIpc.ts']);
  });

  it('没有绕过契约的 webContents.send 推送', () => {
    const hits = files.filter((f) => /webContents\s*\.\s*send\s*\(/.test(code(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it('preload 只暴露契约传输与宿主能力两个全局', () => {
    for (const preload of ['preload.ts', 'ai-chat-preload.ts']) {
      const src = code(path.join(SRC, preload));
      expect(src).toMatch(/mkNomiTransportPreload\(/);
      expect(src).toMatch(/mkNomiHostPreload\(/);
      expect(src).not.toMatch(/exposeInMainWorld|ipcRenderer\s*\.\s*(invoke|send|on)\s*\(/);
    }
  });
});
