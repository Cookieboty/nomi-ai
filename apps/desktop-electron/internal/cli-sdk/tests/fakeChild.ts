import { EventEmitter } from 'node:events';

import type { ChildLike } from '../src/child';

type Json = Record<string, unknown>;

/** 可编程的假子进程：stdin 收到的每一行交给 onLine，send() 往 stdout 推一行 */
export class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  readonly written: string[] = [];
  onLine: (msg: Json, raw: string) => void = () => undefined;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    writable: true,
    write: (chunk: string) => {
      for (const raw of chunk.split('\n').filter(Boolean)) {
        this.written.push(raw);
        let msg: Json = {};
        try {
          msg = JSON.parse(raw) as Json;
        } catch {
          /* 非 JSON 原样记 */
        }
        queueMicrotask(() => this.onLine(msg, raw));
      }
      return true;
    },
    end: () => {
      this.stdin.writable = false;
    },
  };

  send(obj: unknown): void {
    this.stdout.emit(
      'data',
      Buffer.from(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`),
    );
  }

  /** 收到的 JSON 消息 */
  messages(): Json[] {
    return this.written.map((l) => {
      try {
        return JSON.parse(l) as Json;
      } catch {
        return {};
      }
    });
  }

  exit(code: number | null = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.stdin.writable = false;
    this.emit('close', code, null);
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.exit(null));
    return true;
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
