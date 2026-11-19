/**
 * 内置终端（sideTerminal.write）的输入管道：xterm 一次 onData 可能交出一整段粘贴（中文 30000 字约 90KB），
 * 而契约上限是 65536 个 JS 码元、Go 侧 Manager.Write 上限是 65536 个 UTF-8 字节，超了整条被静默拒收。
 * 这里负责：
 * - 按完整字符切块（不超过下发的字节上限，代理对不拆成两块），拼回去与原文逐字节相同；
 * - 按终端串行写入：每块等内核回写成功再发下一块，并发粘贴 / 打字之间的先后顺序不变；
 * - 每一代终端（open / close 都换代）的输入是一个独立的任务：换代后旧任务在下一块之前就停住，不会把
 *   剩下的块写进重新打开后的新会话，也不会因为旧结果去改新一代的队列或失败状态；
 * - 某块写入失败或被内核拒绝：丢弃尚未发出的剩余部分，把错误报给界面（可见提示），这一代之后不再写，
 *   不自动重试——那一块是否已部分落地无法判定，自动重发可能把半条命令执行两遍。
 * PTY 是连续字节流（括号粘贴标记跨 RPC 也是同一顺序），不需要在 RPC 边界上保证标记完整：这里只按字符边界切分，
 * 每块拼回去与原文逐字节相同，普通按键（含单独的 Esc）原样一块一块写出。
 */
import { createLogger } from '@nomi-ai/ui';

const log = createLogger('terminal-input');

/** 契约 `SideTerminalWriteInput.data` 的上限（JS 码元） */
export const TERMINAL_WRITE_MAX_CHARS = 65536;
/** Go 侧 `sideterminal.Manager.Write` 的上限（UTF-8 字节） */
export const TERMINAL_WRITE_MAX_BYTES = 65536;
/** 每块上限：取契约（码元）与 Go（字节）两侧较小的那个 */
export const TERMINAL_CHUNK_MAX_BYTES = Math.min(
  TERMINAL_WRITE_MAX_BYTES,
  TERMINAL_WRITE_MAX_CHARS,
);

/** 一个码位的 UTF-8 字节数 */
function codePointBytes(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** text[i] 与 text[i+1] 是否连成一个代理对（否则 i 处是单独代理，按 3 字节 / 替换字符处理） */
function isPairAt(text: string, i: number): boolean {
  const hi = text.charCodeAt(i);
  if (hi < 0xd800 || hi >= 0xdc00) return false;
  const lo = text.charCodeAt(i + 1);
  return lo >= 0xdc00 && lo < 0xe000;
}

/**
 * 上一次输入末尾单独出现的高位代理：onData 一般整对给出，异常输入可能在两次回调之间断开，
 * 这里拼回去，保证写进 PTY 的是完整字符。
 */
export interface TerminalInputState {
  pendingHigh: string;
}

export const EMPTY_INPUT_STATE: TerminalInputState = { pendingHigh: '' };

/**
 * 把一次输入切成不超过 maxBytes 的块（每块都是完整的 UTF-8 文本）。
 * `stream`（默认 true，onData 的输入）时末尾单独的高位代理留到下一次回调；false 时按替换字符编码（同 TextEncoder）。
 */
export function splitTerminalInput(
  text: string,
  opts: { maxBytes?: number; state?: TerminalInputState; stream?: boolean } = {},
): { chunks: string[]; state: TerminalInputState } {
  const maxBytes = opts.maxBytes ?? TERMINAL_CHUNK_MAX_BYTES;
  const pending = opts.state?.pendingHigh ?? '';
  let input = pending + text;
  if (pending && !isPairAt(input, 0)) {
    // 上一次回调末尾的高位代理后面没跟上低位代理：按替换字符送出
    input = '\ufffd' + text;
  }
  let nextState: TerminalInputState = EMPTY_INPUT_STATE;
  if (opts.stream !== false && input.length > 0) {
    const last = input.charCodeAt(input.length - 1);
    if (last >= 0xd800 && last < 0xdc00) {
      nextState = { pendingHigh: input[input.length - 1]! };
      input = input.slice(0, -1);
    }
  }
  if (!input) return { chunks: [], state: nextState };

  const chunks: string[] = [];
  let start = 0;
  while (start < input.length) {
    let end = start;
    let bytes = 0;
    while (end < input.length) {
      const pair = isPairAt(input, end);
      const size = pair ? 4 : codePointBytes(input.codePointAt(end)!);
      if (bytes + size > maxBytes) break;
      bytes += size;
      end += pair ? 2 : 1;
    }
    if (end === start) {
      // 上限比单个字符还小（只在测试 / 配置错误里出现）：仍不拆字，让内核如实拒收
      end = start + (isPairAt(input, start) ? 2 : 1);
    }
    chunks.push(input.slice(start, end));
    start = end;
  }
  return { chunks, state: nextState };
}

/** 一段文本的 UTF-8 字节数 */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (const ch of text) n += codePointBytes(ch.codePointAt(0)!);
  return n;
}

export interface TerminalWriteFailure {
  /** 终端这一代已被换掉（重新打开时仍在队列里的输入），这些块没有发出 */
  aborted?: boolean;
}

export type TerminalWriter = (id: string, data: string) => Promise<boolean>;

interface Job {
  /** 投递时终端的代数：换代后这个任务不再写、也不再改任何状态 */
  gen: number;
  chunks: string[];
  resolve: () => void;
}

export interface TerminalInputWriterOptions {
  /** 写一块：true = 内核已收下；false / 抛错 = 失败 */
  write: TerminalWriter;
  /** 可见的失败：写入失败 / 被拒（这一代剩下的输入不再写） */
  onFailure: (id: string) => void;
  maxBytes?: number;
}

/**
 * 按终端排队的输入（sideTerminal 服务里一个进程一份）：块按投递顺序一块一块写，等下一条回执再发下一块；
 * 并发粘贴 / 打字之间的先后顺序不变。某个终端失败后，这一代之后投递的块不再写（不把后面的输入变成一条
 * 命令），直到终端重新打开（reset）换代。
 */
export class TerminalInputWriter {
  private readonly write: TerminalWriter;
  private readonly onFailure: (id: string) => void;
  private readonly maxBytes: number;
  private readonly states = new Map<string, TerminalInputState>();
  /** 终端 id → [代数, 这一代的队列]；换代即换掉队列对象，旧队列上的任务自然作废 */
  private readonly queues = new Map<string, { gen: number; jobs: Job[] }>();
  /**
   * 终端 id → 正在进行的那次 write（不论哪一代）：同一个终端同一时刻只有一块在途，新旧两代的 drain 排队，
   * 旧一代的回执处理完（并放弃剩余块）之后，新一代才开始写
   */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly gens = new Map<string, number>();
  /** 已失败、重新打开前不再写输入的终端（所属代数） */
  private readonly poisoned = new Map<string, number>();

  constructor(opts: TerminalInputWriterOptions) {
    this.write = opts.write;
    this.onFailure = opts.onFailure;
    this.maxBytes = opts.maxBytes ?? TERMINAL_CHUNK_MAX_BYTES;
  }

  private queueOf(id: string): { gen: number; jobs: Job[] } {
    const gen = this.gens.get(id) ?? 0;
    let q = this.queues.get(id);
    if (!q || q.gen !== gen) {
      q = { gen, jobs: [] };
      this.queues.set(id, q);
    }
    return q;
  }

  /** 拆块并投入队列；返回的 Promise 在这段输入的块写出（或失败丢弃 / 换代作废）后 resolve */
  send(id: string, text: string, stream = true): Promise<void> {
    if (!id || !text) return Promise.resolve();
    const gen = this.gens.get(id) ?? 0;
    const split = splitTerminalInput(text, {
      maxBytes: this.maxBytes,
      state: this.states.get(id) ?? EMPTY_INPUT_STATE,
      stream,
    });
    this.states.set(id, split.state);
    if (!split.chunks.length) return Promise.resolve();
    const chunks = split.chunks;
    return new Promise<void>((resolve) => {
      if (this.poisoned.get(id) === gen) {
        // 这一代已经失败过：后面的输入直接丢弃，不再重复提示（界面已经有那条失败）
        resolve();
        return;
      }
      const q = this.queueOf(id);
      q.jobs.push({ gen, chunks, resolve });
      void this.drain(id, q);
    });
  }

  /** 终端（重新）打开：换代，清掉失败状态与待拼接的代理对；上一代没写出的块作废 */
  reset(id: string): void {
    this.nextGen(id);
  }

  /** 终端关闭：换代并丢掉这一代的输入（之后投递的输入也直接丢弃，重新打开时 reset 恢复） */
  close(id: string): void {
    const gen = this.gens.get(id) ?? 0;
    const q = this.queues.get(id);
    this.nextGen(id);
    if (q?.gen === gen && q.jobs.length) {
      const jobs = q.jobs;
      q.jobs = [];
      for (const job of jobs) job.resolve();
      this.onFailure(id);
    }
  }

  /** 排队中尚未写出的块数（测试用） */
  pending(id: string): number {
    return this.queues.get(id)?.jobs.reduce((n, j) => n + j.chunks.length, 0) ?? 0;
  }

  /** 当前代数（测试用） */
  generation(id: string): number {
    return this.gens.get(id) ?? 0;
  }

  private nextGen(id: string): void {
    this.gens.set(id, (this.gens.get(id) ?? 0) + 1);
    this.poisoned.delete(id);
    this.states.delete(id);
    this.queues.delete(id);
  }

  private async drain(id: string, q: { gen: number; jobs: Job[] }): Promise<void> {
    const current = () => this.queues.get(id) === q && q.gen === (this.gens.get(id) ?? 0);
    try {
      // 等上一代（或本代前一个任务）在途的那一块回执处理完
      while (this.inFlight.has(id)) await this.inFlight.get(id);
      while (current()) {
        const job = q.jobs[0];
        if (!job) break;
        for (const chunk of job.chunks) {
          // 每一块之前都确认还是同一代：换代（重新打开 / 关闭）后旧任务立即停住，绝不写进新会话
          if (!current()) break;
          let done!: () => void;
          this.inFlight.set(
            id,
            new Promise<void>((r) => {
              done = r;
            }),
          );
          try {
            let ok = false;
            try {
              ok = await this.write(id, chunk);
            } catch (err) {
              log.debug('terminal write rejected', err);
              ok = false;
            }
            if (!ok && q.gen === (this.gens.get(id) ?? 0)) {
              // 同一代里失败：不管此刻队列对象是否已被（重新打开时）换掉，这一代都作废
              // 这一代作废：这一段与已投入队列的都不再写，显示一次可见失败，等用户重新打开 / 重试发送
              const jobs = q.jobs;
              q.jobs = [];
              this.poisoned.set(id, q.gen);
              for (const j of jobs) j.resolve();
              this.onFailure(id);
              return;
            }
          } finally {
            this.inFlight.delete(id);
            done();
          }
        }
        if (current() && q.jobs[0] === job) q.jobs.shift();
        job.resolve();
      }
    } finally {
      // 换代后旧任务在等待中退出：不碰新一代的任何状态
    }
  }
}
