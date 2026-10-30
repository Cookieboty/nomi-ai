import { definePlugin, type HookContext, type PluginContext } from '../types/plugin';

import { TokenBucket } from './guardrails/TokenBucket';

export interface GuardrailsConfig {
  toolWhitelist?: string[];
  rateLimit?: {
    tokensPerMinute: number;
    burst?: number;
  };
  dangerTools?: string[];
  repeatCall?: {
    maxRepeat: number;
  };
  timeout?: {
    toolMs: number;
  };
}

interface ToolExecPayload {
  tool: string;
  args: unknown;
  turnId?: string;
  confirmed?: boolean;
}

const argsSignature = (tool: string, args: unknown): string =>
  `${tool}::${JSON.stringify(args ?? null)}`;

export const GuardrailsPlugin = definePlugin<GuardrailsConfig>({
  name: 'GuardrailsPlugin',
  apply(ctx: PluginContext, cfg: GuardrailsConfig) {
    const whitelist = cfg.toolWhitelist ? new Set(cfg.toolWhitelist) : null;
    const dangerSet = new Set(cfg.dangerTools ?? []);
    const bucket = cfg.rateLimit
      ? new TokenBucket(cfg.rateLimit.tokensPerMinute, cfg.rateLimit.burst ?? 10)
      : null;
    const repeatMax = cfg.repeatCall?.maxRepeat ?? 3;

    /** 最近调用签名 —— 用于连续重复检测 */
    const recentCalls: string[] = [];

    ctx.on<ToolExecPayload>('tools/pre-execute', async (hookCtx: HookContext<ToolExecPayload>) => {
      const { tool, args, confirmed } = hookCtx.payload;

      // 1) whitelist
      if (whitelist && !whitelist.has(tool)) {
        hookCtx.reject(`tool not in whitelist: ${tool}`, 'E_TOOL_NOT_WHITELISTED');
      }

      // 2) rate limit
      if (bucket && !bucket.tryConsume(1)) {
        hookCtx.reject('rate limited', 'E_RATE_LIMIT');
      }

      // 3) danger confirm
      if (dangerSet.has(tool) && !confirmed) {
        ctx.emit('tool/confirm-required', { tool, args });
        hookCtx.reject('danger tool requires user confirm', 'E_TOOL_DENIED');
      }

      // 4) repeat call
      const sig = argsSignature(tool, args);
      recentCalls.push(sig);
      if (recentCalls.length > repeatMax) recentCalls.shift();
      if (recentCalls.length === repeatMax && recentCalls.every((s) => s === sig)) {
        hookCtx.reject(`repeat call detected: ${tool}`, 'E_TOOL_REPEAT');
      }
    });

    // 5) timeout：包装 Promise.race，占位骨架
    ctx.on<{ tool: string; run: () => Promise<unknown> }>('tools/wrap', async (hookCtx) => {
      const ms = cfg.timeout?.toolMs ?? 15_000;
      const { run, tool } = hookCtx.payload;
      await Promise.race([
        run(),
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error(`tool timeout: ${tool} > ${ms}ms`)), ms),
        ),
      ]);
    });

    ctx.logger.info('guardrails installed: whitelist/rate/danger/repeat/timeout');
  },
});
