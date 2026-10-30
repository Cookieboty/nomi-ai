/* eslint-disable no-console -- 启动测速打点，测速脚本解析 stdout */
/**
 * 启动性能打点：`IG_PERF_LOG=1` 时输出 `[perf] <mark> +<ms since process start> @<epoch ms>`。
 * 供 scripts/measure-startup.mjs 统计冷启动；默认关闭，零开销。
 */
import { performance } from 'perf_hooks';

const enabled = process.env.IG_PERF_LOG === '1';
const seen = new Set<string>();

export function perfMark(name: string): void {
  if (!enabled || seen.has(name)) return;
  seen.add(name);

  console.log(`[perf] ${name} +${performance.now().toFixed(0)} @${Date.now()}`);
}

export const perfEnabled = enabled;
