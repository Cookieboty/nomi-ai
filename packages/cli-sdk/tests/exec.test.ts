import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { ExecDriver, type ChildLike, type HarnessEvent } from '../src';

/** 真起一个 node 子进程：读 stdin，按行吐 JSON 事件 */
const SCRIPT = `
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const resume = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : null;
  if (input === 'fail') { process.stderr.write('bad'); process.exit(3); }
  if (input === 'hang') { setInterval(() => {}, 1000); return; }
  console.log(JSON.stringify({ t: 'text', v: 'echo:' + input }));
  console.log(JSON.stringify({ t: 'done', sid: resume ? resume + '+' : 'new-1' }));
});
`;

const parser =
  () =>
  (line: string): HarnessEvent[] => {
    const j = JSON.parse(line) as { t: string; v?: string; sid?: string };
    if (j.t === 'text') return [{ type: 'text-delta', text: String(j.v) }];
    if (j.t === 'done') return [{ type: 'done', text: '', sessionId: j.sid }];
    return [];
  };

const mk = () =>
  new ExecDriver({
    spawn: (cmd, args, o) =>
      spawn(cmd, args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike,
    command: process.execPath,
    cwd: process.cwd(),
    args: (_i, sid) => ['-e', SCRIPT, '--', ...(sid ? ['--resume', sid] : [])],
    parser,
    stdin: (i) => i.text,
    exitMessage: (code) => `退出码 ${code}`,
  });

describe('ExecDriver', () => {
  it('one process per turn; the session id carries over to the next turn', async () => {
    const d = mk();
    const r1 = await d.send({ text: 'hi' });
    expect(r1).toMatchObject({ text: 'echo:hi', sessionId: 'new-1', stopReason: 'end_turn' });
    const r2 = await d.send({ text: 'again' });
    expect(r2.sessionId).toBe('new-1+');
  });

  it('non-zero exit without output rejects with the host message', async () => {
    await expect(mk().send({ text: 'fail' })).rejects.toThrow('退出码 3');
  });

  it('interrupt / abort kills the turn', async () => {
    const d = mk();
    const ac = new AbortController();
    const p = d.send({ text: 'hang', signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow('aborted');
    expect(d.inTurn).toBe(false);
  });
});
