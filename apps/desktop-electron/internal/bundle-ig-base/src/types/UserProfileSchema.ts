import { z } from 'zod';

import { CURRENT_USER_PROFILE_VERSION } from './UserProfile';

const preferenceSource = z.enum(['user', 'inferred', 'distilled']);

const preferenceValue = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .object({
      value: inner,
      source: preferenceSource,
      updatedAt: z.number().int().nonnegative(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .strict();

const identitySchema = z
  .object({
    displayName: z.string().max(64).optional(),
    nickname: z.string().max(64).optional(),
    timezone: z.string().max(64).optional(),
    locale: z.string().max(16).optional(),
  })
  .strict();

const codeStyleSchema = z
  .object({
    language: z.array(z.string().max(32)).max(16).optional(),
    framework: z.array(z.string().max(32)).max(16).optional(),
    indent: z.union([z.literal('tab'), z.literal(2), z.literal(4)]).optional(),
    quotes: z.enum(['single', 'double']).optional(),
    packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional(),
    comments: z.enum(['minimal', 'verbose']).optional(),
  })
  .strict();

const preferencesSchema = z
  .object({
    replyLanguage: preferenceValue(z.string().max(16)).optional(),
    replyStyle: preferenceValue(z.enum(['concise', 'detailed', 'bullet', 'stepwise'])).optional(),
    tone: preferenceValue(z.enum(['formal', 'casual', 'cute', 'strict'])).optional(),
    codeStyle: codeStyleSchema.optional(),
    ttsVoiceId: preferenceValue(z.string().max(128)).optional(),
    autoAcceptTools: z.array(z.string().max(64)).max(64).optional(),
    privacy: z
      .object({
        allowScreenCapture: z.boolean().optional(),
        allowClipboardRead: z.boolean().optional(),
        allowFileWrite: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const habitsSchema = z
  .object({
    activeHours: z.array(z.number().int().nonnegative()).length(24).optional(),
    avgSessionLen: z.number().nonnegative().optional(),
    stopGenerationRate: z.number().min(0).max(1).optional(),
    regenRate: z.number().min(0).max(1).optional(),
    topTools: z
      .array(z.object({ tool: z.string(), count: z.number().int().nonnegative() }).strict())
      .max(64)
      .optional(),
    topTopics: z
      .array(z.object({ topic: z.string(), count: z.number().int().nonnegative() }).strict())
      .max(64)
      .optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const userProfileSchema = z
  .object({
    version: z.literal(CURRENT_USER_PROFILE_VERSION),
    identity: identitySchema,
    preferences: preferencesSchema,
    habits: habitsSchema,
    dislikes: z.array(z.string().max(64)).max(128),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type ValidatedUserProfile = z.infer<typeof userProfileSchema>;
