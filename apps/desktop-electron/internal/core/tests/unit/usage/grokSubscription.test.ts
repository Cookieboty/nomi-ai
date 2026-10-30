jest.unmock('fs');
jest.unmock('path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { parseGrokAuthStatus, readGrokAuthStatus } from '../../../src/usage/grokAuth';
import { GrokBillingFetcher, parseGrokBilling } from '../../../src/usage/grokSubscription';

describe('parseGrokBilling', () => {
  it('keeps only the account period and plan fields', () => {
    const r = parseGrokBilling(
      {
        subscription_tier: 'SuperGrok Heavy',
        email: 'must-not-leak@example.com',
        config: {
          creditUsagePercent: 37.5,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-10-12T00:00:00.000Z',
            end: '2026-10-19T00:00:00.000Z',
          },
        },
      },
      Date.parse('2026-10-18T00:00:00.000Z'),
    );
    expect(r).toEqual({
      windows: [
        {
          id: 'USAGE_PERIOD_TYPE_WEEKLY',
          usedPercent: 37.5,
          windowMinutes: 10080,
          resetAt: Date.parse('2026-10-19T00:00:00.000Z'),
        },
      ],
      updatedAt: Date.parse('2026-10-18T00:00:00.000Z'),
      origin: 'grok-acp',
      plan: 'SuperGrok Heavy',
    });
  });

  it('rejects incomplete or malformed billing replies', () => {
    expect(parseGrokBilling({ config: { creditUsagePercent: 20 } })).toBeNull();
    expect(parseGrokBilling({ config: { creditUsagePercent: -1, currentPeriod: {} } })).toBeNull();
  });

  it('接受字符串百分比（Windows CLI 偶发）', () => {
    const r = parseGrokBilling(
      {
        subscription_tier: 'SuperGrok',
        config: {
          creditUsagePercent: '12.5',
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-10-12T00:00:00.000Z',
            end: '2026-10-19T00:00:00.000Z',
          },
        },
      },
      Date.parse('2026-10-18T00:00:00.000Z'),
    );
    expect(r?.windows[0]?.usedPercent).toBe(12.5);
    expect(r?.plan).toBe('SuperGrok');
  });
});

describe('parseGrokAuthStatus：CRLF 行分隔', () => {
  it('拆开 \\r\\n 的 ACP 行', () => {
    const body = JSON.stringify({
      result: {
        authMethods: [{ id: 'cached_token' }],
        _meta: { defaultAuthMethodId: 'cached_token' },
      },
    });
    expect(parseGrokAuthStatus(`warn\r\n${body}\r\n`)).toBe('subscription');
  });
});

function fakeAcpChild(reply: (msg: Record<string, unknown>) => Record<string, unknown> | null) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: jest.Mock };
    stdout: PassThrough;
    kill: jest.Mock;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdout = new PassThrough();
  child.kill = jest.fn(() => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = {
    write: jest.fn((chunk: string) => {
      queueMicrotask(() => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const out = reply(msg);
          if (out) child.stdout.write(`${JSON.stringify(out)}\n`);
        }
      });
    }),
  };
  return child;
}

describe('GrokBillingFetcher / readGrokAuthStatus：Windows .cmd 解包', () => {
  it('win32 下把 grok.cmd 解成 node + script 再 spawn（stdin 管道）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-grok-cmd-'));
    const cmd = path.join(tmp, 'grok.cmd');
    const js = path.join(tmp, 'grok.js');
    fs.writeFileSync(js, '// mock');
    fs.writeFileSync(cmd, `"%_prog%"  "%dp0%${path.sep}grok.js" %*\r\n`);
    const spawned: Array<{
      file: string;
      args: string[];
      opts: { windowsVerbatimArguments?: boolean };
    }> = [];
    const child = fakeAcpChild((msg) => {
      if (msg.id === 1) return { id: 1, result: { ok: true } };
      if (msg.id === 2)
        return {
          id: 2,
          result: {
            subscription_tier: 'SuperGrok',
            config: {
              creditUsagePercent: 10,
              currentPeriod: {
                type: 'weekly',
                start: '2026-10-12T00:00:00.000Z',
                end: '2026-10-19T00:00:00.000Z',
              },
            },
          },
        };
      return null;
    });
    const outcome = await new GrokBillingFetcher({
      resolveBin: async () => cmd,
      spawnFn: ((file: string, args: string[], opts: { windowsVerbatimArguments?: boolean }) => {
        spawned.push({ file, args, opts });
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as typeof import('node:child_process').spawn,
      platform: 'win32',
      env: () => ({ ...process.env, ComSpec: 'cmd.exe' }),
      tmpRoot: tmp,
      timeoutMs: 2000,
      now: () => Date.parse('2026-10-18T00:00:00.000Z'),
    }).fetch();
    expect(spawned[0]?.file).toBe('node.exe');
    expect(spawned[0]?.args[0]).toBe(js);
    expect(spawned[0]?.args.slice(1)).toEqual(['agent', 'stdio']);
    expect(spawned[0]?.opts.windowsVerbatimArguments).toBe(false);
    expect(outcome.kind).toBe('ok');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('readGrokAuthStatus 在 win32 同样解包 .cmd', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-grok-auth-cmd-'));
    const cmd = path.join(tmp, 'grok.cmd');
    const js = path.join(tmp, 'grok.js');
    fs.writeFileSync(js, '// mock');
    fs.writeFileSync(cmd, `"%_prog%"  "%dp0%${path.sep}grok.js" %*\r\n`);
    const spawned: Array<{ file: string; args: string[] }> = [];
    const child = fakeAcpChild((msg) =>
      msg.id === 1
        ? {
            id: 1,
            result: {
              authMethods: [{ id: 'cached_token' }],
              _meta: { defaultAuthMethodId: 'cached_token' },
            },
          }
        : null,
    );
    const out = await readGrokAuthStatus({
      resolveBin: async () => cmd,
      platform: 'win32',
      env: () => ({ ...process.env }),
      tmpRoot: tmp,
      timeoutMs: 2000,
      spawnFn: ((file: string, args: string[]) => {
        spawned.push({ file, args });
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as typeof import('node:child_process').spawn,
    });
    expect(spawned[0]?.file).toBe('node.exe');
    expect(spawned[0]?.args[0]).toBe(js);
    expect(out).toContain('cached_token');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
