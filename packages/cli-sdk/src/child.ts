/**
 * 驱动用到的子进程形状（Node `ChildProcessWithoutNullStreams` 的子集）。驱动不自己 spawn：
 * 宿主负责可执行文件解析、环境注入、诊断记录（spawnHarness → traceCliChild），把子进程交给驱动；
 * 测试可以注入假的子进程。
 */
export interface ChildLike {
  pid?: number;
  readonly exitCode: number | null;
  readonly killed: boolean;
  stdin: {
    readonly writable: boolean;
    write(chunk: string): boolean;
    end(): void;
  };
  stdout: { on(event: 'data', fn: (c: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', fn: (c: Buffer | string) => void): unknown };
  on(event: 'close', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** 宿主提供的 spawn（exec 驱动每轮起一个进程时用） */
export type SpawnFn = (command: string, args: string[], opts: { cwd: string }) => ChildLike;

/** 宿主提供的结束进程（Windows 要杀进程树）；缺省 child.kill() */
export type KillFn = (child: ChildLike) => void;

/** 关掉 stdin 并结束进程（已退出的不动） */
export function endChild(child: ChildLike, kill?: KillFn): void {
  try {
    if (child.stdin.writable) child.stdin.end();
  } catch {
    /* */
  }
  try {
    if (!child.killed && child.exitCode === null) (kill ?? ((c) => c.kill()))(child);
  } catch {
    /* */
  }
}

/** 末尾 n 个字符的 stderr（握手失败时诊断用） */
export function stderrTail(child: ChildLike, n = 4000): () => string {
  let tail = '';
  child.stderr.on('data', (c) => {
    tail = (tail + String(c)).slice(-n);
  });
  return () => tail;
}
