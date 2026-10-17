import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCharacter3DStore } from '../../src/stores/character3DStore';

describe('character3DStore (zustand 5 + immer middleware)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useCharacter3DStore.getState().reset();
  });

  it('applies immer draft mutations immutably', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = useCharacter3DStore.getState();
    before.addActiveTool('wave');
    before.addActiveTool('wave');
    const after = useCharacter3DStore.getState();
    expect(after.activeTools).toEqual(['wave']);
    expect(after).not.toBe(before);
    expect(before.activeTools).toEqual([]);
  });

  it('notifies subscribeWithSelector listeners only for the selected slice', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen: string[] = [];
    const unsub = useCharacter3DStore.subscribe(
      (s) => s.lastCommand,
      (cmd) => seen.push(cmd),
    );
    useCharacter3DStore.getState().setLastCommand('jump');
    useCharacter3DStore.getState().addActiveTool('dance');
    unsub();
    expect(seen).toEqual(['jump']);
  });
});

describe('character3DStore 性能指标与自动降质', () => {
  beforeEach(() => {
    // setRenderQuality 会派发 window 事件；node 环境没有 window
    vi.stubGlobal('window', { dispatchEvent: () => true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useCharacter3DStore.getState().reset();
  });

  it('评估间隔未到 5s 时不调整质量，之后按窗口平均帧率降一档', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    useCharacter3DStore.getState().reset();
    // store 创建于真实时间，假时钟下需要把「上次评估时间」对齐到当前
    useCharacter3DStore.setState({ lastPerformanceCheck: Date.now() });
    useCharacter3DStore.getState().setRenderQuality('high');
    const { updatePerformanceMetrics } = useCharacter3DStore.getState();
    // 1Hz 写入 4 次（共 4s）：低帧率但还没到评估点
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1000);
      updatePerformanceMetrics({ fps: 15, memoryMB: 200 });
    }
    expect(useCharacter3DStore.getState().renderQuality).toBe('high');
    // 超过 5s → 评估，平均 15fps < 25 → high → medium
    vi.advanceTimersByTime(1500);
    updatePerformanceMetrics({ fps: 15, memoryMB: 200 });
    expect(useCharacter3DStore.getState().renderQuality).toBe('medium');
    // 紧接着的下一个样本不会立刻再降（又要等 5s）
    vi.advanceTimersByTime(1000);
    updatePerformanceMetrics({ fps: 15, memoryMB: 200 });
    expect(useCharacter3DStore.getState().renderQuality).toBe('medium');
  });

  it('单次卡顿不会降质：看的是窗口平均值', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    useCharacter3DStore.getState().reset();
    // store 创建于真实时间，假时钟下需要把「上次评估时间」对齐到当前
    useCharacter3DStore.setState({ lastPerformanceCheck: Date.now() });
    useCharacter3DStore.getState().setRenderQuality('high');
    const { updatePerformanceMetrics } = useCharacter3DStore.getState();
    for (const fps of [60, 60, 5, 60, 60, 60]) {
      vi.advanceTimersByTime(1000);
      updatePerformanceMetrics({ fps, memoryMB: 200 });
    }
    expect(useCharacter3DStore.getState().renderQuality).toBe('high');
  });

  it('性能良好 + 内存低时可以升一档', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    useCharacter3DStore.getState().reset();
    // store 创建于真实时间，假时钟下需要把「上次评估时间」对齐到当前
    useCharacter3DStore.setState({ lastPerformanceCheck: Date.now() });
    useCharacter3DStore.getState().setRenderQuality('low');
    const { updatePerformanceMetrics } = useCharacter3DStore.getState();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(1000);
      updatePerformanceMetrics({ fps: 60, memoryMB: 30 });
    }
    expect(useCharacter3DStore.getState().renderQuality).toBe('medium');
  });

  it('历史只保留最近 5 分钟', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    useCharacter3DStore.getState().reset();
    const { updatePerformanceMetrics } = useCharacter3DStore.getState();
    updatePerformanceMetrics({ fps: 60, memoryMB: 10 });
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    updatePerformanceMetrics({ fps: 60, memoryMB: 10 });
    expect(useCharacter3DStore.getState().performanceHistory).toHaveLength(1);
  });
});
