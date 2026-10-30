import type { UserHabits, UserProfile } from '../../types/UserProfile';

/**
 * 隐式习惯统计（EMA / 计数）—— 记录 activeHours、常用工具、topic 频次。
 *
 * 骨架版：只提供 in-memory 累计与 toHabits() 快照，真实持久化由 ProfileStore 承担。
 */
export class HabitStatCollector {
  private readonly activeHours = new Array<number>(24).fill(0);
  private readonly toolCount = new Map<string, number>();
  private readonly topicCount = new Map<string, number>();
  private stopCount = 0;
  private regenCount = 0;
  private turnCount = 0;
  private sessionLenSum = 0;
  private sessionCount = 0;

  onUserMessage(atMs: number): void {
    const h = new Date(atMs).getHours();
    this.activeHours[h] = (this.activeHours[h] ?? 0) + 1;
    this.turnCount += 1;
  }

  onToolCall(tool: string): void {
    this.toolCount.set(tool, (this.toolCount.get(tool) ?? 0) + 1);
  }

  onTopic(topic: string): void {
    this.topicCount.set(topic, (this.topicCount.get(topic) ?? 0) + 1);
  }

  onStopGeneration(): void {
    this.stopCount += 1;
  }

  onRegenerate(): void {
    this.regenCount += 1;
  }

  onSessionEnd(lenMs: number): void {
    this.sessionLenSum += lenMs;
    this.sessionCount += 1;
  }

  toHabits(prev?: UserProfile['habits']): UserHabits {
    // EMA 融合：α=0.3，让新样本占 30%
    const α = 0.3;
    const ema = (n: number, o?: number): number => (o == null ? n : α * n + (1 - α) * o);

    const top = (m: Map<string, number>, key: 'tool' | 'topic'): Array<Record<string, unknown>> =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([k, count]) => ({ [key]: k, count }));

    return {
      activeHours: this.activeHours,
      avgSessionLen:
        this.sessionCount > 0
          ? ema(this.sessionLenSum / this.sessionCount, prev?.avgSessionLen)
          : prev?.avgSessionLen,
      stopGenerationRate: this.turnCount
        ? this.stopCount / this.turnCount
        : prev?.stopGenerationRate,
      regenRate: this.turnCount ? this.regenCount / this.turnCount : prev?.regenRate,
      topTools: top(this.toolCount, 'tool') as UserHabits['topTools'],
      topTopics: top(this.topicCount, 'topic') as UserHabits['topTopics'],
      updatedAt: Date.now(),
    };
  }
}
