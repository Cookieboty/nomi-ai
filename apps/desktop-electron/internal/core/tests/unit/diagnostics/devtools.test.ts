/** 开发者工具读诊断日志：按标签与时间窗取子进程收发、限量截断、按追踪 id 读网关正文 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLI_WINDOW_SLACK_MS,
  readCliRecords,
  readGatewayTrace,
} from '../../../src/diagnostics/devtools';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const T0 = Date.UTC(2026, 10, 4, 10, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function writeDay(dir: string, lines: unknown[]): void {
  const day = iso(T0).slice(0, 10);
  fs.writeFileSync(
    path.join(dir, `cli-${day}.jsonl`),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );
}

describe('readCliRecords', () => {
  it('只取这个标签、时间窗（两端放宽）里的记录，按顺序，字段原样', async () => {
    const dir = tmp('devtools-cli-');
    writeDay(dir, [
      {
        t: iso(T0 - CLI_WINDOW_SLACK_MS - 1),
        pid: 1,
        cli: 'claude',
        tab: 'a',
        ev: 'out',
        data: 'early',
      },
      { t: iso(T0), pid: 1, cli: 'claude', tab: 'a', ev: 'spawn', args: ['-p', 'x'] },
      { t: iso(T0 + 10), pid: 1, cli: 'claude', tab: 'b', ev: 'out', data: 'other tab' },
      'not json {"tab":"a"}',
      { t: iso(T0 + 20), pid: 1, cli: 'claude', tab: 'a', ev: 'in', data: '{"x":1}' },
      {
        t: iso(T0 + 30),
        pid: 1,
        cli: 'claude',
        tab: 'a',
        ev: 'exit',
        code: null,
        signal: 'SIGTERM',
      },
      { t: iso(T0 + 5000 + CLI_WINDOW_SLACK_MS + 1), tab: 'a', ev: 'out', data: 'late' },
    ]);
    const r = await readCliRecords(dir, { tabId: 'a', from: T0, to: T0 + 5000 }, true);
    expect(r.enabled).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.records).toEqual([
      { t: iso(T0), ev: 'spawn', pid: 1, cli: 'claude', args: ['-p', 'x'] },
      { t: iso(T0 + 20), ev: 'in', pid: 1, cli: 'claude', data: '{"x":1}' },
      { t: iso(T0 + 30), ev: 'exit', pid: 1, cli: 'claude', code: null, signal: 'SIGTERM' },
    ]);
  });

  it('超过条数上限截断；不合法的标签 id 不读文件', async () => {
    const dir = tmp('devtools-cap-');
    writeDay(
      dir,
      Array.from({ length: 2005 }, (_, i) => ({ t: iso(T0 + i), tab: 'a', ev: 'out', data: 'x' })),
    );
    const r = await readCliRecords(dir, { tabId: 'a', from: T0, to: T0 + 10_000 }, false);
    expect(r.records).toHaveLength(2000);
    expect(r.truncated).toBe(true);
    expect(r.enabled).toBe(false);
    const bad = await readCliRecords(dir, { tabId: '../x', from: T0, to: T0 + 10 }, true);
    expect(bad.records).toEqual([]);
  });

  it('没有日志文件返回空', async () => {
    const r = await readCliRecords(tmp('devtools-none-'), { tabId: 'a', from: T0, to: T0 }, true);
    expect(r).toEqual({ enabled: true, records: [], truncated: false });
  });
});

describe('readGatewayTrace', () => {
  it('按追踪 id 找文件；id 不合法或找不到返回 found: false', async () => {
    const dir = tmp('devtools-gw-');
    fs.writeFileSync(path.join(dir, '20261104T100000-claude-abc-123.json'), '{"request":{}}');
    await expect(readGatewayTrace(dir, 'abc-123')).resolves.toEqual({
      found: true,
      text: '{"request":{}}',
    });
    await expect(readGatewayTrace(dir, 'nope')).resolves.toEqual({ found: false });
    await expect(readGatewayTrace(dir, '../etc')).resolves.toEqual({ found: false });
    await expect(readGatewayTrace(path.join(dir, 'missing'), 'abc-123')).resolves.toEqual({
      found: false,
    });
  });
});
