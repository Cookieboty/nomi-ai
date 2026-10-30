/**
 * AppConfig 的 zod 校验器与 user-friendly 错误映射。
 *
 * 约定：
 * - 使用 `.strict()` 拒绝未知字段，避免持久化中沉淀陈旧配置。
 * - `loadAppConfig(raw)` 失败时把 zod issue 转成中文可读消息，供 UI 直接展示。
 */

import { z, type ZodError } from 'zod';

import type { AppConfig } from './AppConfig';

const providerChoiceSchema = z
  .object({
    id: z.string().min(1, '缺少 provider id'),
    model: z.string().min(1, '缺少模型 id'),
    default: z.boolean().optional(),
  })
  .strict();

const shortcutBindingSchema = z
  .object({
    command: z.string().min(1, '快捷键的命令 id 不能为空'),
    accelerator: z.string().min(1, '快捷键映射不能为空'),
  })
  .strict();

const uiPreferencesSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    language: z.string().min(2).optional(),
    fontSizePx: z.number().int().positive().max(96).optional(),
    compact: z.boolean().optional(),
  })
  .strict();

export const AppConfigSchema = z
  .object({
    providers: z.array(providerChoiceSchema).default([]),
    shortcuts: z.array(shortcutBindingSchema).default([]),
    ui: uiPreferencesSchema.default({}),
    autoAcceptTools: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const defaults = cfg.providers.filter((p) => p.default === true);
    if (defaults.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `providers 中默认项应仅有 1 个，当前有 ${defaults.length} 个`,
        path: ['providers'],
      });
    }
    const seen = new Set<string>();
    for (const [i, p] of cfg.providers.entries()) {
      const key = `${p.id}::${p.model}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `providers[${i}] 重复：${key}`,
          path: ['providers', i],
        });
      }
      seen.add(key);
    }
    const cmds = new Set<string>();
    for (const [i, s] of cfg.shortcuts.entries()) {
      if (cmds.has(s.command)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `shortcuts[${i}] 命令 id 重复：${s.command}`,
          path: ['shortcuts', i],
        });
      }
      cmds.add(s.command);
    }
  });

export class AppConfigInvalidError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`AppConfig 无效：\n- ${issues.join('\n- ')}`);
    this.name = 'AppConfigInvalidError';
    this.issues = issues;
  }
}

function formatZodError(err: ZodError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

export function loadAppConfig(raw: unknown): AppConfig {
  const parsed = AppConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new AppConfigInvalidError(formatZodError(parsed.error));
  }
  return parsed.data as AppConfig;
}
