import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

/** 假的 codex app-server 子进程：按行读 JSON-RPC，交给 handler 回应（测试用） */
export type Handler = (msg: Record<string, unknown>, reply: (o: unknown) => void) => void;

export function fakeServer(handler: Handler) {
  const sent: Array<Record<string, unknown>> = [];
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const reply = (o: unknown) => stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`);
  let buf = '';
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line) as Record<string, unknown>;
        sent.push(msg);
        setImmediate(() => handler(msg, reply));
      }
      cb();
    },
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn(() => {
    child.exitCode = 0;
    setImmediate(() => child.emit('close', 0));
    return true;
  });
  const spawnFn = jest.fn(() => child);
  return { child, spawnFn, sent, reply, stdout };
}
