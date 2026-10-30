import { z } from 'zod';

import type { ToolDefinition } from '../../../types/common';

export const echoInputSchema = z
  .object({
    text: z.string().min(1).max(4096),
  })
  .strict();

export type EchoInput = z.infer<typeof echoInputSchema>;

export const echoTool: ToolDefinition<EchoInput, string> = {
  name: 'echo',
  description: '原样返回输入的文本，用于连通性 / 冒烟测试。',
  input: echoInputSchema,
  async execute(input) {
    return echoInputSchema.parse(input).text;
  },
};
