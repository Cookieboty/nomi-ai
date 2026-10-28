import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { forkUtilityProcess } from '../src/processes';

const worker = path.join(__dirname, 'fixtures', 'echoWorker.cjs');

describe('forkUtilityProcess', () => {
  it('gives the child process.parentPort and round-trips structured messages', async () => {
    const child = forkUtilityProcess(worker, { args: ['--flag'] });
    const reply = new Promise<unknown>((resolve) => child.on('message', resolve));
    child.postMessage({ hello: 'world', at: new Date(0) });
    expect(await reply).toEqual({
      echo: { hello: 'world', at: new Date(0) },
      argv: ['--flag'],
      bytes: new Uint8Array([1, 2]),
    });
    const exit = new Promise<number>((resolve) => child.on('exit', resolve));
    child.postMessage('exit');
    expect(await exit).toBe(3);
    expect(child.kill()).toBe(false);
  });

  it('kill() ends a running child', async () => {
    const child = forkUtilityProcess(worker);
    const exit = new Promise<number>((resolve) => child.on('exit', resolve));
    expect(child.kill()).toBe(true);
    expect(typeof (await exit)).toBe('number');
  });
});
