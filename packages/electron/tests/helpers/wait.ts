/**
 * 测试里等异步副作用（写文件、子进程应答、清理缓存）用轮询，不要固定 sleep：
 * 固定等待在机器繁忙（全仓并行跑测试）时会不够长，导致偶发失败；条件一成立就返回，也不会白等。
 */
export async function until(
  cond: () => boolean | Promise<boolean>,
  { timeoutMs = 8000, intervalMs = 5, what = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
