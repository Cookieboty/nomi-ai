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

/** 按插件规则收尾（strict）：脚本按 stdin 的指令输出 */
const STRICT = `
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const say = (o) => console.log(JSON.stringify(o));
  if (input === 'silent') process.exit(0);
  if (input === 'done-then-exit1') { say({ t: 'text', v: 'ok' }); say({ t: 'done', usage: 1 }); process.exit(1); }
  if (input === 'error-empty') { say({ t: 'error', v: 'upstream 401' }); say({ t: 'done' }); return; }
  if (input === 'partial-hang') { say({ t: 'text', v: 'half' }); setInterval(() => {}, 1000); return; }
  if (input === 'tail') { process.stdout.write(JSON.stringify({ t: 'text', v: 'last' })); return; }
  say({ t: 'text', v: 'ok' });
});
`;

const strictParser =
  () =>
  (line: string): HarnessEvent[] => {
    const j = JSON.parse(line) as { t: string; v?: string; usage?: number };
    if (j.t === 'text') return [{ type: 'text-delta', text: String(j.v) }];
    if (j.t === 'error') return [{ type: 'error', message: String(j.v) }];
    if (j.t === 'done')
      return [{ type: 'done', text: '', ...(j.usage ? { usage: { inputTokens: j.usage } } : {}) }];
    return [];
  };

const mkStrict = () =>
  new ExecDriver({
    spawn: (cmd, args, o) =>
      spawn(cmd, args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike,
    command: process.execPath,
    cwd: process.cwd(),
    args: () => ['-e', STRICT],
    parser: strictParser,
    stdin: (i) => i.text,
    completes: (ev) => ev.type === 'done' && !!ev.usage,
    silentExit: () => '没有任何输出',
    abortedMessage: '已中止',
    exitMessage: (code) => `退出码 ${code}`,
  });

describe('ExecDriver（插件收尾规则）', () => {
  it('没有任何输出就以 0 退出：按插件规则报错', async () => {
    await expect(mkStrict().send({ text: 'silent' })).rejects.toThrow('没有任何输出');
  });

  it('见过完成事件之后，收尾阶段的非零退出不翻案为失败', async () => {
    const r = await mkStrict().send({ text: 'done-then-exit1' });
    expect(r).toMatchObject({ text: 'ok', stopReason: 'end_turn' });
  });

  it('报了错、一个字也没回：失败（不当成无文本的正常完成）', async () => {
    await expect(mkStrict().send({ text: 'error-empty' })).rejects.toThrow('upstream 401');
  });

  it('没见过完成事件就被停止：即使已有部分文字也算中止', async () => {
    const d = mkStrict();
    const ac = new AbortController();
    const p = d.send({ text: 'partial-hang', signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toThrow('已中止');
  });

  it('没有换行的最后一行在收尾时解析，标为 tail（不算实时输出）', async () => {
    const d = mkStrict();
    const seen: Array<{ tail?: boolean }> = [];
    d.on((e) => e.kind === 'harness' && seen.push({ tail: e.tail }));
    const r = await d.send({ text: 'tail' });
    expect(r.text).toBe('last');
    expect(seen).toEqual([{ tail: true }]);
  });
});
