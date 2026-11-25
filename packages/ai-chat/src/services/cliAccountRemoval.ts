/**
 * 删除官方账号（#426）：确认弹窗列出的是第一次扫描到的「Nomi 之外的 CLI 进程」，用户确认后提交时要把这批进程号
 * 原样带回内核（stopExternal + stopPids）。内核只结束这几个；提交时重新扫描的范围和确认的不一致（有新进程出现、
 * 旧进程已经不是原来那个）会再报 external-busy，这里按新的进程号重新确认。确认 / 取消都不能当成删除成功。
 */

/** .code 是契约错误码（ACCOUNT_*），data.pids 是那次扫描到的进程号 */
export type RemovalError = { code?: unknown; message?: string; data?: { pids?: unknown } };

/** 进程号快照：只认正整数，排序去重（弹窗顺序和内核扫描顺序可能不同） */
export const pidSnapshot = (v: unknown): number[] => {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const x of v) {
    if (typeof x === 'number' && Number.isInteger(x) && x > 0) out.add(x);
  }
  return [...out].sort((a, b) => a - b);
};

/** 这次 external-busy 的进程号快照；没有可用的进程号 = 拿不到范围，不能结束任何进程 */
export const busySnapshot = (e: unknown): number[] | null => {
  const pids = pidSnapshot((e as RemovalError | null)?.data?.pids);
  return pids.length > 0 ? pids : null;
};

/**
 * 确认弹窗里列出的进程号 = 这次扫描的进程号快照（错误里的 data.pids）。从文案里抠数字不安全（文案里的
 * 「还有 2 个」也会被当成进程号），所以只看快照；快照缺项 = 拿不到范围，不结束任何进程。
 */
export const confirmedPids = (_e: unknown, pids: number[]): number[] => pidSnapshot(pids);

/** 用户对某一批进程的同意；retry = 不是第一次确认（范围变了，要重新说明） */
export type AskStop = (pids: number[], retry: boolean) => Promise<boolean>;

/**
 * 确认这批进程后结束它们再删除。返回 undefined = 删除成功；返回别的错误 = 没删成（调用方按错误码处理，
 * 不能报成功）；用户取消确认也返回错误（那次 external-busy），不当成删除成功。同一批进程提交时可能又变了：最多让用户再确认几次，不无限循环。
 */
export const stopConfirmedProcesses = async (
  id: string,
  pids: number[],
  e: unknown,
  ask: AskStop,
  remove: (id: string, opts: { stopExternal: true; stopPids: number[] }) => Promise<unknown>,
): Promise<unknown> => {
  let snapshot = confirmedPids(e, pids);
  let busy: unknown = e;
  for (let attempt = 0; attempt < 3 && snapshot.length > 0; attempt++) {
    // 取消：一个进程都没结束、账号也没删。不能返回 undefined（调用方会当成删除成功），把原来的错误交回去。
    if (!(await ask([...snapshot], attempt > 0))) return busy;
    try {
      await remove(id, { stopExternal: true, stopPids: [...snapshot] });
      return undefined;
    } catch (next) {
      const changed = busySnapshot(next);
      if (!changed) return next;
      snapshot = changed;
      busy = next;
    }
  }
  return busy;
};
