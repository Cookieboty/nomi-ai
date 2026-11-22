import { z } from 'zod';

import { ConversationId } from './schemas';

const id = z.object({ id: ConversationId });
const backend = z.string().min(1).max(64);
export const RuntimeToken = z.object({
  conversationId: ConversationId,
  attemptId: z.string(),
  generation: z.number().int().nonnegative(),
});
export const RuntimeState = z.object({
  id: ConversationId,
  backend: z.string(),
  generation: z.number().int().nonnegative(),
  phase: z.enum([
    'idle',
    'preparing',
    'running',
    'completed',
    'failed-pre-submit',
    'canceling',
    'canceled',
    'uncertain',
  ]),
  queued: z.number().int(),
  partial: z.string(),
  detail: z.string(),
  approvals: z.array(z.string()),
  token: RuntimeToken.optional(),
  recovery: z.enum(['none', 'resumed', 'new', 'fallback', 'unknown', 'error']),
  capabilities: z.object({
    resume: z.boolean(),
    cancel: z.boolean(),
    approval: z.boolean(),
    attachments: z.boolean(),
    permissionModes: z.array(z.string()),
    degraded: z.array(z.string()),
  }),
});
const chat = ['chat'] as const;
export const managedConversationProcedures = {
  'conversations.runtimeCapabilities': {
    kind: 'query',
    input: z.object({ id: ConversationId.optional() }).optional(),
    output: z.object({
      supported: z.boolean(),
      backends: z.array(z.string()),
      detail: z.string(),
      choices: z.array(
        z.object({
          id: z.string().min(1).max(64),
          available: z.boolean(),
          status: z.enum([
            'ready',
            'missing-executable',
            'no-project',
            'unsupported-platform',
            'requires-provider',
          ]),
          detail: z.string(),
          login: z.enum(['unverified', 'not-advertised', 'not-applicable']),
          requiresProject: z.boolean(),
          degraded: z.array(z.string()),
        }),
      ),
    }),
    surfaces: chat,
  },
  'conversations.runtimeAdopt': {
    kind: 'mutation',
    input: id.extend({ backend, confirm: z.literal(true) }),
    output: RuntimeState,
    surfaces: chat,
    dangerous: true,
  },
  'conversations.runtimeState': { kind: 'query', input: id, output: RuntimeState, surfaces: chat },
  'conversations.runtimeSelect': {
    kind: 'mutation',
    input: id.extend({ backend }),
    output: RuntimeState,
    surfaces: chat,
    dangerous: true,
  },
  'conversations.runtimeResolve': {
    kind: 'mutation',
    input: id.extend({
      decision: z.literal('new-native'),
      confirm: z.literal(true),
      expectedGeneration: z.number().int().nonnegative(),
    }),
    output: RuntimeState,
    surfaces: chat,
    dangerous: true,
  },
  'conversations.runtimeSend': {
    kind: 'mutation',
    input: id.extend({
      expectedGeneration: z.number().int().nonnegative(),
      messageId: z.string().min(1).max(256),
      turnId: z.string().min(1).max(256),
      text: z.string().max(1048576),
      retry: z.boolean().optional(),
    }),
    output: RuntimeToken,
    surfaces: chat,
    dangerous: true,
  },
  'conversations.runtimeCancel': {
    kind: 'mutation',
    input: id.extend({
      turnId: z.string().optional(),
      beforeGeneration: z.number().int().nonnegative().optional(),
    }),
    output: RuntimeState,
    surfaces: chat,
  },
  'conversations.runtimeApprove': {
    kind: 'mutation',
    input: id.extend({ token: RuntimeToken, approvalId: z.string().min(1), allow: z.boolean() }),
    output: RuntimeState,
    surfaces: chat,
    dangerous: true,
  },
  'conversations.runtimeEdit': {
    kind: 'mutation',
    input: id.extend({ messageId: z.string().min(1), text: z.string() }),
    output: RuntimeState,
    surfaces: chat,
    dangerous: true,
  },
  'conversations.runtimeRelease': { kind: 'mutation', input: id, output: z.void(), surfaces: chat },
} as const;
