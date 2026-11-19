import { describe, expect, it } from 'vitest';

import {
  splitTerminalInput,
  TerminalInputWriter,
  TERMINAL_CHUNK_MAX_BYTES,
} from '../src/services/terminalInput';

const utf8 = (s: string) => new TextEncoder().encode(s);
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** 模拟内核：只收 UTF-8 ≤ 65536 字节的一块（同 Go Manager.Write），否则拒收；记录并发与顺序 */
function kernel() {
  const received: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gate: { p: Promise<void> | null } = { p: null };
  const write = async (_id: string, data: string): Promise<boolean> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (gate.p) await gate.p;
    inFlight -= 1;
    if (utf8(data).length > TERMINAL_CHUNK_MAX_BYTES) return false;
    received.push(data);
    return true;
  };
  return {
    write,
    received,
    get maxInFlight() {
      return maxInFlight;
    },
    block(p: Promise<void> | null) {
      gate.p = p;
    },
  };
}

const ok = (n: number) => n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);

/** 每块大小不超上限，且块里没有落单的代理（代理对不跨块） */
function expectSafeChunks(chunks: string[]) {
  for (const c of chunks) {
    expect(utf8(c).length).toBeLessThanOrEqual(TERMINAL_CHUNK_MAX_BYTES);
    for (let i = 0; i < c.length; i += 1) {
      const cu = c.charCodeAt(i);
      if (cu >= 0xd800 && cu < 0xdc00) {
        const lo = c.charCodeAt(i + 1);
        expect(lo >= 0xdc00 && lo < 0xe000).toBe(true);
        i += 1;
      } else {
        expect(cu >= 0xdc00 && cu < 0xe000).toBe(false);
      }
    }
  }
}

describe('splitTerminalInput', () => {
  it('splits 30000 Chinese chars into UTF-8-safe chunks that reconstruct exactly', () => {
    const text = '中'.repeat(30000); // 90000 bytes, one onData event
    const { chunks } = splitTerminalInput(text);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe(text);
    expectSafeChunks(chunks);
    for (const c of chunks) expect(utf8(c).length).toBeLessThanOrEqual(TERMINAL_CHUNK_MAX_BYTES);
  });

  it('keeps surrogate pairs (emoji) intact at every boundary', () => {
    const text = '🎉🚀'.repeat(8000) + '尾';
    const { chunks } = splitTerminalInput(text);
    expect(chunks.join('')).toBe(text);
    expectSafeChunks(chunks);
    for (const c of chunks) {
      for (let i = 0; i < c.length;) {
        const cp = c.codePointAt(i)!;
        expect(ok(cp)).toBe(true);
        i += cp > 0xffff ? 2 : 1;
      }
    }
  });

  it('joins a surrogate pair split across two callbacks', () => {
    const a = splitTerminalInput('x\ud83d', { state: { pendingHigh: '' } });
    expect(a.chunks).toEqual(['x']);
    expect(a.state.pendingHigh).toBe('\ud83d');
    const b = splitTerminalInput('\ude80y', { state: a.state });
    expect(b.chunks).toEqual(['🚀y']);
    expect(b.state.pendingHigh).toBe('');
  });

  it('passes lone Esc, full bracketed-paste markers and ordinary typing through unchanged', () => {
    for (const s of [
      '\x1b',
      '\x1b[201~',
      '\x1b[200~',
      '\x1b[A',
      '\x1b[3~',
      'a',
      '\r',
      '\x03',
      '中',
      '\x1b[200~hi\x1b[201~',
    ])
      expect(splitTerminalInput(s).chunks).toEqual([s]);
    // 大段粘贴：首块以起止标记原样开头 / 结尾，拼起来逐字节相同
    const paste = `${PASTE_START}${'x'.repeat(TERMINAL_CHUNK_MAX_BYTES + 10)}${PASTE_END}`;
    const { chunks } = splitTerminalInput(paste);
    expect(chunks.join('')).toBe(paste);
    expect(chunks[0]!.startsWith(PASTE_START)).toBe(true);
    expect(chunks.at(-1)!.endsWith(PASTE_END)).toBe(true);
  });
});

describe('TerminalInputWriter', () => {
  it('writes serially, in order, and reconstructs 30000 Chinese chars + large emoji', async () => {
    const k = kernel();
    const failures: string[] = [];
    const w = new TerminalInputWriter({
      write: k.write,
      onFailure: (id) => failures.push(id),
    });
    const text = '中'.repeat(30000) + '🚀'.repeat(20000);
    await w.send('t1', text);
    expect(k.maxInFlight).toBe(1);
    expect(k.received.join('')).toBe(text);
    for (const c of k.received)
      expect(utf8(c).length).toBeLessThanOrEqual(TERMINAL_CHUNK_MAX_BYTES);
    expect(failures).toEqual([]);
  });

  it('serializes concurrent pastes / typing in submission order', async () => {
    const k = kernel();
    let release!: () => void;
    k.block(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const w = new TerminalInputWriter({ write: k.write, onFailure: () => undefined });
    const p1 = w.send('t1', 'A'.repeat(70000));
    const p2 = w.send('t1', '\x1b');
    const p3 = w.send('t1', 'ls\r');
    const p4 = w.send('t1', 'B'.repeat(70000));
    await Promise.resolve();
    k.block(null);
    release();
    await Promise.all([p1, p2, p3, p4]);
    expect(k.maxInFlight).toBe(1);
    expect(k.received.join('')).toBe('A'.repeat(70000) + '\x1b' + 'ls\r' + 'B'.repeat(70000));
  });

  it('keeps ordinary typing byte-identical (one write per key, Esc immediately)', async () => {
    const k = kernel();
    const w = new TerminalInputWriter({ write: k.write, onFailure: () => undefined });
    for (const key of ['l', 's', '\r', '\x1b', '\x1b[201~']) await w.send('t1', key);
    expect(k.received).toEqual(['l', 's', '\r', '\x1b', '\x1b[201~']);
    expect(w.pending('t1')).toBe(0);
  });

  it('short / rejected write: stops later queued input, shows one failure, never resends', async () => {
    const received: string[] = [];
    const failures: string[] = [];
    let calls = 0;
    const w = new TerminalInputWriter({
      write: async (_id, data) => {
        calls += 1;
        if (calls === 2) throw new Error('transport closed'); // 第 2 块被拒
        received.push(data);
        return true;
      },
      onFailure: (id) => failures.push(id),
    });
    const text = '中'.repeat(60000); // 3 块
    await w.send('t1', text);
    // 第一块写出，第二块失败：已被内核收下的内容不再重发，剩下的块没有发出
    expect(received).toEqual([text.slice(0, 21845)]);
    expect(failures).toEqual(['t1']);
    // 失败之后继续输入（比如回车）不会被写进终端变成一条命令，也不再报第二次
    const before = calls;
    await w.send('t1', '\r');
    await w.send('t1', 'rm -rf /\r');
    expect(calls).toBe(before);
    expect(failures).toEqual(['t1']);
    // 重新打开终端（换代）后恢复
    w.reset('t1');
    await w.send('t1', 'echo ok\r');
    expect(received.at(-1)).toBe('echo ok\r');
    expect(received).toHaveLength(2);
  });

  it('false write (kernel rejects) behaves like a rejection', async () => {
    const received: string[] = [];
    const failures: string[] = [];
    const w = new TerminalInputWriter({
      write: async (_id, data) => {
        if (data.length > 10) return false;
        received.push(data);
        return true;
      },
      onFailure: () => failures.push('fail'),
    });
    await w.send('t1', 'a'.repeat(20));
    expect(received).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it('closing / reopening mid-paste: the old tail never reaches the new session and does not poison it', async () => {
    // 第 1 块写出去后挂住（旧会话还没回执）；这时关闭 + 重新打开，再发新输入
    let release!: () => void;
    const firstHang = new Promise<void>((r) => {
      release = r;
    });
    const received: Array<{ id: string; data: string }> = [];
    const failures: string[] = [];
    let call = 0;
    const w = new TerminalInputWriter({
      write: async (id, data) => {
        call += 1;
        if (call === 1) await firstHang;
        received.push({ id, data });
        return true;
      },
      onFailure: (id) => failures.push(id),
    });
    const old = w.send('t1', 'a'.repeat(70000)); // 2 块
    const old2 = w.send('t1', 'tail');
    expect(w.pending('t1')).toBe(3);
    w.close('t1');
    w.reset('t1'); // 对应 sideTerminalHost.open（重新打开）
    const fresh = w.send('t1', 'echo new\r');
    release();
    await Promise.all([old, old2, fresh]);
    // 旧的剩余块一块都没写；新会话只收到新输入
    // 新会话收到的顺序：先是重新打开后的输入，之后不会再有任何旧一代的剩余块
    // 关闭时只挂住了第一块（64KB 的 'a'）：它已经进了旧会话；其余旧块一块都没写
    expect(received).toEqual([
      { id: 't1', data: 'a'.repeat(TERMINAL_CHUNK_MAX_BYTES) },
      { id: 't1', data: 'echo new\r' },
    ]);
    expect(received.filter((r) => r.data.startsWith('a')).length).toBeLessThanOrEqual(1);
    // 关闭时那一代剩下的块作废（一次可见失败）；这一失败不会让新会话停写
    expect(failures).toEqual(['t1']);
    const failCount = failures.length;
    await w.send('t1', 'ls\r');
    expect(received.at(-1)!.data).toBe('ls\r');
    expect(failures).toHaveLength(failCount);
  });

  it('an old generation failure does not poison the reopened session', async () => {
    const received: string[] = [];
    const failures: string[] = [];
    const w = new TerminalInputWriter({
      // 第一块失败（旧会话的进程已退出），之后正常
      write: async (_id, data) => {
        await Promise.resolve();
        if (w.generation('t1') === 0) {
          received.push(`failed:${data}`);
          return false;
        }
        received.push(data);
        return true;
      },
      onFailure: () => failures.push('x'),
    });
    await w.send('t1', 'x');
    expect(failures).toHaveLength(1);
    w.close('t1');
    w.reset('t1'); // 重新打开
    await w.send('t1', 'ok');
    expect(received).toEqual(['failed:x', 'ok']);
    expect(failures).toHaveLength(1);
  });
});
