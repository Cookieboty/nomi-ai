import { z } from 'zod';

import type { ToolDefinition } from '../../../types/common';

export const randomInputSchema = z
  .object({
    min: z.number().finite(),
    max: z.number().finite(),
    integer: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.max >= v.min, { message: 'max must be >= min' });

export type RandomInput = z.infer<typeof randomInputSchema>;

export const randomTool: ToolDefinition<RandomInput, number> = {
  name: 'random',
  description: '返回 [min, max] 之间的随机数；integer=true 时为整数（含边界）。',
  input: randomInputSchema,
  async execute(input) {
    const { min, max, integer } = randomInputSchema.parse(input);
    if (integer) {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }
    return Math.random() * (max - min) + min;
  },
};
