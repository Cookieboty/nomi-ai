/**
 * 网关包不依赖 @nomi-ai/types，质量字段按契约另写了一份（packages/gateway/src/quality.ts）。
 * 这里在编译期核对两份一致：任一边改了字段、结果类别，这个测试就编译失败。
 */
import type {
  QualityAttempt as GatewayAttempt,
  QualityOutcome as GatewayOutcome,
  QualityTiming as GatewayTiming,
} from '@nomi-ai/gateway';
import type { QualityAttempt, QualityOutcome, QualityTiming } from '@nomi-ai/types';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('模型质量：网关与共享契约一致', () => {
  it('结果类别、时间点、尝试记录的类型一致', () => {
    const outcome: Same<GatewayOutcome, QualityOutcome> = true;
    const timing: Same<GatewayTiming, QualityTiming> = true;
    const attempt: Same<GatewayAttempt, QualityAttempt> = true;
    expect([outcome, timing, attempt]).toEqual([true, true, true]);
  });
});
