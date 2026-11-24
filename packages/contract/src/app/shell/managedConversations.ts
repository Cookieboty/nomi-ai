import { z } from 'zod';

import { ConversationId } from './schemas';

const id = z.object({ id: ConversationId });
const backend = z.string().min(1).max(64);
export const RuntimeSource = z.enum(['local', 'official', 'thirdParty']);
export const RuntimeToken = z.object({
  conversationId: ConversationId,
  attemptId: z.string(),
  generation: z.number().int().nonnegative(),
});
export const ApprovalDetail = z.object({
  id: z.string(),
  tool: z.string().optional(),
  summary: z.string().optional(),
  argsPreview: z.string().optional(),
  danger: z.string().optional(),
  risk: z.string().optional(),
  rationale: z.string().optional(),
});
export const TraceEntry = z.object({
  id: z.string(),
  kind: z.string(),
  tool: z.string().optional(),
  summary: z.string().optional(),
  status: z.string().optional(),
  detail: z.string().optional(),
  output: z.string().optional(),
  at: z.number().int(),
});
export const FailedRequestInfo = z.object({
  messageId: z.string(),
  turnId: z.string(),
  text: z.string(),
  images: z.array(z.string()).optional(),
});
export const BridgeState = z.object({
  status: z.enum(['native', 'bridged', 'degraded', 'unsupported']),
  detail: z.string().optional(),
});
export const CapabilityBridges = z.object({
  computer: BridgeState,
  mcp: BridgeState,
  persona: BridgeState,
  memory: BridgeState,
  knowledge: BridgeState,
  skills: BridgeState,
  attachments: BridgeState,
});
export const RuntimeOptionItem = z.object({
  id: z.string(),
  label: z.string(),
});
const SwitchStrategy = z.enum(['none', 'delta', 'blocked', 'new_session']);
export const PendingSwitchState = z.object({
  phase: z.enum(['saved-source', 'preparing-target', 'recovering-target', 'handoff', 'committing']),
  fromBackend: z.string(),
  toBackend: z.string(),
  expectedStrategy: SwitchStrategy.or(z.literal('')).optional(),
  plannedEntries: z.number().int().nonnegative().optional(),
  omittedEntries: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
export const LastSwitchSummary = z.object({
  fromBackend: z.string(),
  toBackend: z.string(),
  expectedStrategy: SwitchStrategy,
  plannedEntries: z.number().int().nonnegative(),
  omittedEntries: z.number().int().nonnegative(),
  resumableBinding: z.string().optional(),
  committedAt: z.number().int().nonnegative(),
});
export const RuntimeState = z.object({
  id: ConversationId,
  backend: z.string(),
  source: RuntimeSource.optional(),
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
  thinking: z.string().optional(),
  thinkingActive: z.boolean().optional(),
  detail: z.string(),
  approvals: z.array(z.string()),
  approvalDetails: z.array(ApprovalDetail).optional(),
  trace: z.array(TraceEntry).optional(),
  failedRequest: FailedRequestInfo.optional(),
  model: z.string().optional(),
  accountId: z.string().optional(),
  permissionMode: z.string().optional(),
  effort: z.string().optional(),
  token: RuntimeToken.optional(),
  recovery: z.enum(['none', 'resumed', 'new', 'fallback', 'unknown', 'error']),
  pendingSwitch: PendingSwitchState.optional(),
  lastSwitch: LastSwitchSummary.optional(),
  capabilities: z.object({
    resume: z.boolean(),
    cancel: z.boolean(),
    approval: z.boolean(),
    attachments: z.boolean(),
    permissionModes: z.array(z.string()),
    degraded: z.array(z.string()),
    bridges: CapabilityBridges.optional(),
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
          accounts: z.array(RuntimeOptionItem).optional(),
          models: z.array(RuntimeOptionItem).optional(),
          permissionModes: z.array(z.string()).optional(),
          hasLocalLogin: z.boolean().optional(),
          bridges: CapabilityBridges.optional(),
        }),
      ),
    }),
    surfaces: chat,
  },
  'conversations.runtimeAdopt': {
    kind: 'mutation',
    input: id.extend({
      backend,
      confirm: z.literal(true),
      source: RuntimeSource.optional(),
      model: z.string().min(1).max(128).optional(),
      effort: z.string().min(1).max(64).optional(),
      permissionMode: z.string().min(1).max(64).optional(),
      accountId: z.string().min(1).max(128).optional(),
    }),
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
  'conversations.runtimeSwitch': {
    kind: 'mutation',
    input: id.extend({
      backend,
      confirm: z.literal(true),
      confirmUnsafe: z.boolean().optional(),
      expectedGeneration: z.number().int().nonnegative().optional(),
      source: RuntimeSource.optional(),
      model: z.string().min(1).max(128).optional(),
      effort: z.string().min(1).max(64).optional(),
      permissionMode: z.string().min(1).max(64).optional(),
      accountId: z.string().min(1).max(128).optional(),
    }),
    output: RuntimeState,
    surfaces: chat,
    dangerous: true,
  },
  'conversations.runtimeResolve': {
    kind: 'mutation',
    input: id.extend({
      decision: z.enum(['new-native', 'rollback-switch', 'abandon']),
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
      images: z.array(z.string().max(16_777_216)).max(16).optional(),
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
  'conversations.runtimeUpdateMeta': {
    kind: 'mutation',
    input: id.extend({
      name: z.string().min(1).max(200).optional(),
      autoTitle: z.boolean().optional(),
      pinnedAt: z.number().int().nonnegative().nullable().optional(),
      archivedAt: z.number().int().nonnegative().nullable().optional(),
    }),
    output: z.void(),
    surfaces: chat,
  },
} as const;
