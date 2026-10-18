/**
 * 流式正文的渲染频率策略。
 *
 * 事件到达是按帧合批的（16ms），但 Markdown 解析 + 生成 React 树的代价与正文长度成正比：
 * 实测一个 8000 字符的代码块流式输出时，每 16ms 重渲染一次约占一个核的一半，放宽到 110ms 约 7%。
 * 所以渲染间隔按「正文长度」与「CPU 核数」分档：正文越长、核数越少，间隔越大；
 * 回合结束（done）时调用方不再节流，立即用最终文本渲染。
 */

/** 按核数的基础间隔（ms）：核少的机器上渲染更容易挤占主线程 */
export function baseIntervalMs(cores: number): number {
  if (!Number.isFinite(cores) || cores <= 0) return 110;
  if (cores <= 4) return 128;
  if (cores <= 8) return 110;
  if (cores <= 12) return 90;
  return 66;
}

/** 按正文长度的放大倍数：短文本几乎无感，长文本（长代码块 / 长列表）成倍放宽 */
export function lengthFactor(bodyLen: number): number {
  if (bodyLen < 2000) return 1;
  if (bodyLen < 8000) return 1.5;
  if (bodyLen < 20000) return 2;
  return 2.5;
}

export const MAX_STREAM_INTERVAL_MS = 320;

/** 流式期间两次 Markdown 渲染之间的最小间隔 */
export function streamRenderIntervalMs(
  bodyLen: number,
  cores: number = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0,
): number {
  return Math.min(
    MAX_STREAM_INTERVAL_MS,
    Math.round(baseIntervalMs(cores) * lengthFactor(bodyLen)),
  );
}
