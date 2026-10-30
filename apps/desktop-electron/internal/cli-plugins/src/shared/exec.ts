/**
 * exec 驱动（每轮一个进程）的收尾规则的共用部分。纯函数。
 */
import type { ExecRules } from '@nomi-ai/cli-sdk';

/** 带用量的 done 才算整轮完成（Codex turn.completed / Grok usage）；其它 done 只带会话 id 或单条消息 */
export const USAGE_DONE: ExecRules = {
  completes: (ev) => ev.type === 'done' && !!ev.usage,
};
