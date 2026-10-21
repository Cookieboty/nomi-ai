import fs from 'fs';

/** Produces a file's contents at write time (so a burst of schedules writes the latest state once). */
export type Produce = () => string;

const live = new Set<CoalescedWriter>();
let exitHooked = false;

/**
 * Debounced, coalesced, atomic file writer for main-process state files.
 *
 * - `schedule(file, produce)` records the latest producer per file; one trailing timer
 *   (`delayMs`) writes every pending file asynchronously (temp file + rename), so a burst of
 *   status changes / messages costs one serialization and no main-process sync I/O.
 * - `flushSync()` writes everything pending right now (quit / dispose / before re-reading the
 *   files). An async write that finishes after a newer sync / async write of the same file is
 *   dropped instead of renaming stale data over it.
 * - Pending writes are also flushed synchronously on process `exit`.
 */
export class CoalescedWriter {
  private readonly pending = new Map<string, Produce>();
  /** Bumped on every write start; an async write only renames if it is still the newest. */
  private readonly gen = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(
    private readonly delayMs = 200,
    private readonly onError: (file: string, e: unknown) => void = () => undefined,
  ) {
    live.add(this);
    if (!exitHooked) {
      exitHooked = true;
      process.once('exit', () => {
        for (const w of live) w.flushSync();
      });
    }
  }

  schedule(file: string, produce: Produce): void {
    this.pending.set(file, produce);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Drop a pending write (e.g. the file is about to be deleted). */
  cancel(file: string): void {
    this.pending.delete(file);
    this.gen.set(file, (this.gen.get(file) ?? 0) + 1);
  }

  has(file: string): boolean {
    return this.pending.has(file);
  }

  hasPendingUnder(dir: string): boolean {
    for (const f of this.pending.keys()) if (f.startsWith(dir)) return true;
    return false;
  }

  private take(): Array<[string, Produce]> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    return batch;
  }

  private bump(file: string): number {
    const g = (this.gen.get(file) ?? 0) + 1;
    this.gen.set(file, g);
    return g;
  }

  /** Write everything pending asynchronously; resolves when written. */
  flush(): Promise<void> {
    const batch = this.take();
    if (!batch.length) return this.chain;
    // produce now (latest state at flush time), write off the main thread
    const jobs: Array<{ file: string; data: string; g: number }> = [];
    for (const [file, produce] of batch) {
      try {
        jobs.push({ file, data: produce(), g: this.bump(file) });
      } catch (e) {
        this.onError(file, e);
      }
    }
    this.chain = this.chain.then(() =>
      Promise.all(
        jobs.map(async ({ file, data, g }) => {
          const tmp = `${file}.${process.pid}.${++this.seq}.tmp`;
          try {
            await fs.promises.writeFile(tmp, data, 'utf8');
            // newer write (sync flush / later batch) or a cancel happened meanwhile: keep that
            if (this.gen.get(file) !== g) {
              await fs.promises.rm(tmp, { force: true });
              return;
            }
            fs.renameSync(tmp, file);
          } catch (e) {
            await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
            this.onError(file, e);
          }
        }),
      ).then(() => undefined),
    );
    return this.chain;
  }

  /** Write everything pending now, synchronously. */
  flushSync(): void {
    for (const [file, produce] of this.take()) {
      this.bump(file);
      const tmp = `${file}.${process.pid}.${++this.seq}.tmp`;
      try {
        fs.writeFileSync(tmp, produce(), 'utf8');
        fs.renameSync(tmp, file);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* */
        }
        this.onError(file, e);
      }
    }
  }

  /** Flush synchronously and stop tracking this writer. */
  dispose(): void {
    this.flushSync();
    live.delete(this);
  }
}

/** Synchronously flush every live writer's pending files under `dir` (before re-reading them). */
export function flushPendingWritesSync(dir?: string): void {
  for (const w of live) {
    if (!dir) w.flushSync();
    else if (w.hasPendingUnder(dir)) w.flushSync();
  }
}
