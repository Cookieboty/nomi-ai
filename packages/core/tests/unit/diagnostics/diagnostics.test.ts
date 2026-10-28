/**
 * 诊断日志（docs/design/cli-plugin-architecture.md §8）：开关与开发版必开、旧「调试模式」迁移、
 * 正文追踪单独关闭、编程助手收发记录（按标签分组、脱敏）、诊断包（再脱敏）、登录进程不记录（S8）。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { strFromU8, unzipSync } from 'fflate';

import { buildDiagnosticsBundle } from '../../../src/diagnostics/bundle';
import { CliTrace } from '../../../src/diagnostics/cliTrace';
import { DiagnosticsService } from '../../../src/diagnostics/DiagnosticsService';
import { featureHost } from '../helpers/featureHost';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const logger = () => ({ info: jest.fn(), warn: jest.fn(), setLevel: jest.fn() });

function mk(
  o: {
    root?: string;
    /** 缺省 false；传 null 表示不指定，按 ports.app.isPackaged() 决定 */
    dev?: boolean | null;
    packaged?: boolean;
    env?: NodeJS.ProcessEnv;
    legacy?: boolean;
    pick?: string | null;
  } = {},
) {
  const root = o.root ?? tmp('nomi-diag-');
  const onChange = jest.fn();
  const host = featureHost({
    saveFile: [o.pick === undefined ? path.join(root, 'out.zip') : o.pick],
    packaged: o.packaged ?? true,
    version: '9.9.9',
  });
  const svc = new DiagnosticsService({
    userData: root,
    logger: logger() as never,
    ports: host.ports,
    ...(o.dev === null ? {} : { dev: o.dev ?? false }),
    env: o.env ?? {},
    onChange,
    legacyEnabled: () => o.legacy === true,
  });
  return { svc, root, onChange, host };
}

describe('DiagnosticsService', () => {
  it('不指定 dev 时按宿主的打包状态决定是否必开；导出挂在焦点窗口上', async () => {
    expect(mk({ dev: null, packaged: false }).svc.view().forced).toBe(true);
    expect(mk({ dev: null, packaged: true }).svc.view().forced).toBe(false);
    const { svc, host } = mk({ pick: null });
    expect(await svc.exportBundle()).toEqual({ ok: false });
    expect(host.calls.saveFile[0]).toMatchObject({
      parent: 'focused',
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
  });

  it('正式版默认关；打开后持久化（0600）并通知网关', () => {
    const { svc, root, onChange } = mk();
    expect(svc.view()).toMatchObject({ enabled: false, forced: false, bodyTrace: false });
    expect(svc.set(true).enabled).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
    const file = path.join(root, 'diagnostics.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).saveLogs).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(mk({ root }).svc.enabled()).toBe(true);
  });

  it('开发版必开：关不掉，状态不变不通知', () => {
    const { svc, onChange } = mk({ dev: true });
    expect(svc.view()).toMatchObject({ enabled: true, forced: true });
    svc.set(false);
    expect(svc.enabled()).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('NOMI_DIAG_BODY=0：诊断开着但不记网关正文', () => {
    expect(mk({ dev: true, env: { NOMI_DIAG_BODY: '0' } }).svc.bodyTrace()).toBe(false);
    expect(mk({ dev: true }).svc.bodyTrace()).toBe(true);
  });

  it('迁移：没有 diagnostics.json 时沿用旧「调试模式」，之后以自己的设置为准', () => {
    const { svc, root } = mk({ legacy: true });
    expect(svc.enabled()).toBe(true);
    svc.set(false);
    expect(mk({ root, legacy: true }).svc.enabled()).toBe(false);
    expect(mk({ legacy: false }).svc.enabled()).toBe(false);
  });

  it('导出诊断包：只收最近 24 小时的日志与追踪，再脱敏一遍，文件 0600；取消返回 ok:false', async () => {
    const { svc, root } = mk();
    const logs = path.join(root, 'logs');
    const trace = path.join(root, 'gateway', 'trace');
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(trace, { recursive: true });
    fs.writeFileSync(path.join(logs, 'app.log'), 'auth Bearer abcdefghijklmnop\n');
    fs.writeFileSync(path.join(logs, 'cli-2026-10-24.jsonl'), '{"data":"nomi-gw-abcdef123456"}\n');
    fs.writeFileSync(path.join(logs, 'secrets.env'), 'X=1');
    fs.writeFileSync(path.join(trace, 't-claude-abc.json'), '{"k":"sk-abcdefghijklmnop"}');
    const old = path.join(logs, 'app.1.log');
    fs.writeFileSync(old, 'old');
    const past = new Date(Date.now() - 48 * 3600_000);
    fs.utimesSync(old, past, past);

    const r = await svc.exportBundle();
    expect(r.ok).toBe(true);
    expect(r.files?.sort()).toEqual(
      ['gateway-trace/t-claude-abc.json', 'logs/app.log', 'logs/cli-2026-10-24.jsonl'].sort(),
    );
    if (process.platform !== 'win32') expect(fs.statSync(r.path!).mode & 0o777).toBe(0o600);
    const z = unzipSync(new Uint8Array(fs.readFileSync(r.path!)));
    const all = Object.values(z)
      .map((u) => strFromU8(u))
      .join('\n');
    expect(all).not.toContain('abcdefghijklmnop');
    expect(all).not.toContain('nomi-gw-abcdef123456');
    expect(all).toContain('[REDACTED]');
    expect(strFromU8(z['README.txt']!)).toContain('conversation');
    expect(strFromU8(z['README.txt']!)).toContain('version: 9.9.9');

    expect(await mk({ pick: null }).svc.exportBundle()).toEqual({ ok: false });
  });

  it('打包函数：目录不存在时只有说明文件', () => {
    const r = buildDiagnosticsBundle({ logDir: '/no/such', traceDir: '/no/such2' });
    expect(r.files).toEqual([]);
    expect(Object.keys(unzipSync(r.data))).toEqual(['README.txt']);
  });
});

describe('cliTrace：编程助手子进程收发', () => {
  function fakeChild() {
    const ee = new EventEmitter() as EventEmitter & {
      pid: number;
      stdin: { write: (...a: unknown[]) => boolean };
      stdout: PassThrough;
      stderr: PassThrough;
    };
    ee.pid = 4242;
    ee.stdin = { write: jest.fn(() => true) };
    ee.stdout = new PassThrough();
    ee.stderr = new PassThrough();
    return ee;
  }

  it('开着时记 spawn / in / out / err / exit，带标签 id，脱敏', () => {
    const dir = tmp('nomi-clitrace-');
    const tr = new CliTrace({ dir, enabled: () => true });
    const c = fakeChild();
    tr.tap(c as never, '/usr/bin/claude', ['-p', '--token', 'nomi-tab-abcdef123456'], {
      tabId: 'tab-1',
    });
    c.stdin.write('{"auth":"Bearer abcdefghijklmnop"}\n');
    c.stdout.write('hello');
    c.stderr.write('warn');
    c.emit('close', 0, null);
    tr.flushSync();
    const f = fs.readdirSync(dir).find((n) => n.startsWith('cli-'))!;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const recs = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(recs.map((r) => r.ev)).toEqual(['spawn', 'in', 'out', 'err', 'exit']);
    expect(recs.every((r) => r.tab === 'tab-1' && r.cli === 'claude' && r.pid === 4242)).toBe(true);
    expect(raw).not.toContain('nomi-tab-abcdef123456');
    expect(raw).not.toContain('abcdefghijklmnop');
    // 原有的写入照常发生
    expect(c.stdin.write).toBeDefined();
  });

  it('关着时什么都不做（不包 stdin，不写文件）', () => {
    const dir = tmp('nomi-clitrace-off-');
    const tr = new CliTrace({ dir, enabled: () => false });
    const c = fakeChild();
    const orig = c.stdin.write;
    tr.tap(c as never, 'codex', []);
    expect(c.stdin.write).toBe(orig);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('启动时开着、中途关掉：后续 write 不再落盘（#119）', () => {
    const dir = tmp('nomi-clitrace-flip-');
    let on = true;
    const tr = new CliTrace({ dir, enabled: () => on });
    const c = fakeChild();
    tr.tap(c as never, 'claude', [], { tabId: 't' });
    c.stdout.write('before');
    on = false;
    c.stdout.write('after');
    tr.flushSync();
    const f = fs.readdirSync(dir).find((n) => n.startsWith('cli-'))!;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(raw).toContain('before');
    expect(raw).not.toContain('after');
  });

  const readRecs = (dir: string) => {
    const f = fs.readdirSync(dir).find((n) => n.startsWith('cli-'));
    if (!f) return [];
    return fs
      .readFileSync(path.join(dir, f), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it('缓冲写：data 事件当场不落盘，定时器到点后异步批量追加，顺序不变', async () => {
    const dir = tmp('nomi-clitrace-buf-');
    const tr = new CliTrace({ dir, enabled: () => true });
    const c = fakeChild();
    tr.tap(c as never, 'claude', [], { tabId: 't' });
    for (let i = 0; i < 50; i++) c.stdout.write(`chunk-${i}`);
    c.stderr.write('oops');
    // 同步路径上不碰文件
    expect(readRecs(dir)).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    await tr.flush();
    const recs = readRecs(dir);
    expect(recs.map((r) => r.ev)).toEqual(['spawn', ...Array(50).fill('out'), 'err']);
    expect(recs.slice(1, 51).map((r) => r.data)).toEqual(
      Array.from({ length: 50 }, (_, i) => `chunk-${i}`),
    );
  });

  it('写入在途时继续产生的记录排在后面；flush() 等全部落盘', async () => {
    const dir = tmp('nomi-clitrace-order-');
    const tr = new CliTrace({ dir, enabled: () => true });
    const c = fakeChild();
    tr.tap(c as never, 'codex', []);
    c.stdout.write('a');
    const first = tr.flush();
    c.stdout.write('b');
    c.stdout.write('Bearer abcdefghijklmnopqrstuvwxyz');
    await first;
    await tr.flush();
    const recs = readRecs(dir);
    expect(recs.map((r) => r.data ?? r.ev)).toEqual([
      'spawn',
      'a',
      'b',
      expect.not.stringContaining('abcdefghijklmnopqrstuvwxyz'),
    ]);
  });

  it('同步 flush（进程退出 / 换目录）把剩下的写完，并且只建一次目录', () => {
    const dir = path.join(tmp('nomi-clitrace-sync-'), 'logs');
    const tr = new CliTrace({ dir, enabled: () => true });
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    const c = fakeChild();
    tr.tap(c as never, 'claude', []);
    c.stdout.write('x');
    tr.flushSync();
    c.stdout.write('y');
    tr.flushSync();
    expect(mkdir.mock.calls.filter((a) => a[0] === dir)).toHaveLength(1);
    mkdir.mockRestore();
    expect(readRecs(dir).map((r) => r.data ?? r.ev)).toEqual(['spawn', 'x', 'y']);
  });

  it('每个实例写自己的目录，互不影响（同一进程里的多个内核）', () => {
    const a = tmp('nomi-clitrace-a-');
    const b = tmp('nomi-clitrace-b-');
    const ta = new CliTrace({ dir: a, enabled: () => true });
    const tb = new CliTrace({ dir: b, enabled: () => false });
    const ca = fakeChild();
    const cb = fakeChild();
    ta.tap(ca as never, 'claude', []);
    tb.tap(cb as never, 'codex', []);
    ca.stdout.write('only-a');
    cb.stdout.write('never');
    ta.flushSync();
    tb.flushSync();
    expect(readRecs(a).map((r) => r.data ?? r.ev)).toEqual(['spawn', 'only-a']);
    expect(fs.readdirSync(b)).toEqual([]);
    ta.dispose();
    expect(process.listeners('exit')).not.toContain(ta.flushSync);
  });

  it('退出钩子：process exit 时同步写完缓冲', () => {
    const dir = tmp('nomi-clitrace-exit-');
    const tr = new CliTrace({ dir, enabled: () => true });
    const c = fakeChild();
    tr.tap(c as never, 'claude', []);
    c.stdout.write('bye');
    const hooks = process.listeners('exit').filter((f) => f === tr.flushSync);
    expect(hooks).toHaveLength(1);
    (hooks[0] as () => void)();
    expect(readRecs(dir).map((r) => r.data ?? r.ev)).toEqual(['spawn', 'bye']);
  });
});

describe('S8：登录进程从不做收发记录', () => {
  it('AccountLogin 不引用诊断记录，也不经 spawnHarness 启动', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/cli/accounts/AccountLogin.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/cliTrace|traceCliChild|spawnHarness|diagnostics/);
  });

  it('只有 spawnHarness 挂了记录（编排层的 CLI 进程）', () => {
    const root = path.join(__dirname, '../../../src/cli');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const calls = files.flatMap((f) =>
      (fs.readFileSync(f, 'utf8').match(/cliTrace\?\.tap\(/g) ?? []).map(() => f),
    );
    // 整个 cli/ 目录只有一处调用：harness/spawn.ts 的 spawnHarness
    expect(calls.map((f) => path.relative(root, f))).toEqual([path.join('harness', 'spawn.ts')]);
    const spawnSrc = fs.readFileSync(path.join(root, 'harness', 'spawn.ts'), 'utf8');
    const body = spawnSrc.slice(spawnSrc.indexOf('export function spawnHarness('));
    expect(body.slice(0, body.indexOf('\n}\n')).includes('cliTrace?.tap(')).toBe(true);
  });
});
