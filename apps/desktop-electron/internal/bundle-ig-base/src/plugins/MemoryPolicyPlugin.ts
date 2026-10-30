import type { ChatMessage } from '../types/common';
import { definePlugin, type HookContext, type PluginContext } from '../types/plugin';

export interface MemoryPolicyConfig {
  /** system prompt 里保留最近多少条对话摘要 */
  windowMessages?: number;
  /** 每 N 步做一次 summary（写入长期记忆） */
  summarizeEveryNSteps?: number;
  /** system prompt 中最大 token 预算，超出截断（简易 chars 估算） */
  maxSystemTokens?: number;
}

interface AgentPreRequestPayload {
  messages: ChatMessage[];
  system?: string;
  /** 允许中间件覆盖 */
  setSystem: (s: string) => void;
  setMessages: (m: ChatMessage[]) => void;
  /** 上下文中可读的画像/长期摘要 */
  profileText?: string;
  longTermSummary?: string;
}

/**
 * system prompt 四段组装：
 *   [1] 稳定人格 base
 *   [2] 用户画像（P2-7 UserProfileSummary）
 *   [3] 长期记忆摘要
 *   [4] 最近 N 条对话回顾
 *
 * 骨架版：只做拼装/截断/step 计数，真实 summary 生成挂 P5+。
 */
export const MemoryPolicyPlugin = definePlugin<MemoryPolicyConfig>({
  name: 'MemoryPolicyPlugin',
  apply(ctx: PluginContext, cfg: MemoryPolicyConfig) {
    const win = cfg.windowMessages ?? 12;
    const everyN = cfg.summarizeEveryNSteps ?? 20;
    const maxTokens = cfg.maxSystemTokens ?? 2000;

    let stepCount = 0;

    ctx.on<AgentPreRequestPayload>(
      'agent/pre-request',
      (hookCtx: HookContext<AgentPreRequestPayload>) => {
        const { messages, system, profileText, longTermSummary, setSystem, setMessages } =
          hookCtx.payload;

        const segments: string[] = [];
        if (system) segments.push(system.trim());
        if (profileText) segments.push(`[用户画像]\n${profileText.trim()}`);
        if (longTermSummary) segments.push(`[长期记忆摘要]\n${longTermSummary.trim()}`);
        if (messages.length > 0) {
          const tail = messages.slice(-win);
          segments.push(
            '[最近对话回顾]\n' +
              tail.map((m) => `- ${m.role}: ${truncate(m.content ?? '', 200)}`).join('\n'),
          );
        }

        const joined = segments.join('\n\n');
        const budgeted = budget(joined, maxTokens * 4 /* char≈token*4 */);
        setSystem(budgeted);

        // 只保留最近 win 条给模型，长上下文交给 summary
        if (messages.length > win) {
          setMessages(messages.slice(-win));
        }
      },
    );

    ctx.on('agent/turn-end', async () => {
      stepCount += 1;
      if (stepCount % everyN === 0) {
        // TODO(P5): 触发一次 summarize LLM 调用并写回长期记忆
        ctx.logger.debug(`memory summarize tick @ step ${stepCount}`);
      }
    });

    ctx.logger.info(`memory policy installed (win=${win}, everyN=${everyN})`);
  },
});

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function budget(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n… [truncated by MemoryPolicy]';
}
