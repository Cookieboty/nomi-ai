import { z } from 'zod';

import type { ToolDefinition } from '../../../types/common';

export const timeNowInputSchema = z
  .object({
    tz: z.string().min(1).max(64).optional(),
  })
  .strict();

export type TimeNowInput = z.infer<typeof timeNowInputSchema>;

export const timeNowTool: ToolDefinition<TimeNowInput, string> = {
  name: 'time_now',
  description: '返回当前时间的 ISO 字符串。可选 tz（IANA 时区名，如 Asia/Shanghai）。',
  input: timeNowInputSchema,
  async execute(input) {
    const parsed = timeNowInputSchema.parse(input ?? {});
    const now = new Date();
    if (!parsed.tz) return now.toISOString();
    // 用 Intl.DateTimeFormat 拆解到指定时区，再格式化为 ISO-like 字符串
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: parsed.tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
        acc[p.type] = p.value;
        return acc;
      }, {});
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    } catch {
      throw new Error(`invalid tz: ${parsed.tz}`);
    }
  },
};
