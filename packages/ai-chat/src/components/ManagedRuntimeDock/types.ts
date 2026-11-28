export type BridgeStatus = 'native' | 'bridged' | 'degraded' | 'unsupported';

export type BridgeStateView = {
  status: BridgeStatus;
  detail?: string;
};

export type CapabilityBridgesView = {
  computer: BridgeStateView;
  mcp: BridgeStateView;
  persona: BridgeStateView;
  memory: BridgeStateView;
  knowledge: BridgeStateView;
  skills: BridgeStateView;
  attachments: BridgeStateView;
};

export type RuntimeOptionItem = {
  id: string;
  label: string;
};

export type ApprovalOptionView = {
  id: string;
  kind?: string;
  name?: string;
};

export type ApprovalDetailView = {
  id: string;
  kind?: string;
  tool?: string;
  summary?: string;
  argsPreview?: string;
  danger?: string;
  risk?: string;
  rationale?: string;
  options?: ApprovalOptionView[];
};

export type RuntimeStatusView = {
  kind: string;
  text?: string;
};

export type RuntimeNoticeView = {
  tag: string;
  text: string;
  at: number;
};

export type SlashCommandView = {
  name: string;
  description?: string;
  hint?: string;
};

export type TraceEntryView = {
  id: string;
  kind: string;
  tool?: string;
  summary?: string;
  status?: string;
  detail?: string;
  output?: string;
  at: number;
};

export type FailedRequestView = {
  messageId: string;
  turnId: string;
  text: string;
  images?: string[];
};

export type PendingSwitchView = {
  phase: 'saved-source' | 'preparing-target' | 'recovering-target' | 'handoff' | 'committing';
  fromBackend: string;
  toBackend: string;
  expectedStrategy?: string;
  plannedEntries?: number;
  omittedEntries?: number;
  reason?: string;
};

export type LastSwitchView = {
  fromBackend: string;
  toBackend: string;
  expectedStrategy: string;
  plannedEntries: number;
  omittedEntries: number;
  resumableBinding?: string;
  committedAt: number;
};

export type RuntimeChoiceView = {
  id: string;
  available: boolean;
  status:
    'ready' | 'missing-executable' | 'no-project' | 'unsupported-platform' | 'requires-provider';
  detail: string;
  login: 'unverified' | 'not-advertised' | 'not-applicable';
  requiresProject: boolean;
  degraded: string[];
  accounts?: RuntimeOptionItem[];
  models?: RuntimeOptionItem[];
  permissionModes?: string[];
  hasLocalLogin?: boolean;
  bridges?: CapabilityBridgesView;
};

export type ManagedRuntimeSource = 'local' | 'official' | 'thirdParty';

export type ManagedSwitchInput = {
  backend: string;
  source?: ManagedRuntimeSource;
  model?: string;
  accountId?: string;
  permissionMode?: string;
  effort?: string;
  longContext?: 'default' | 'on' | 'off';
  confirmUnsafe?: boolean;
};

export type RuntimeTokenView = {
  conversationId: string;
  attemptId: string;
  generation: number;
};

export type ManagedRuntimeView = {
  supported: boolean;
  managed: boolean;
  backend: string;
  source?: ManagedRuntimeSource;
  phase: string;
  recovery: string;
  generation: number;
  detail: string;
  choices: RuntimeChoiceView[];
  busy: boolean;
  error?: string;
  token?: RuntimeTokenView;
  model?: string;
  accountId?: string;
  permissionMode?: string;
  effort?: string;
  longContext?: boolean;
  partial?: string;
  thinking?: string;
  thinkingActive?: boolean;
  contextTokens?: number;
  contextWindow?: number;
  status?: RuntimeStatusView;
  notice?: RuntimeNoticeView;
  commands?: SlashCommandView[];
  approvals?: string[];
  approvalDetails?: ApprovalDetailView[];
  trace?: TraceEntryView[];
  failedRequest?: FailedRequestView;
  pendingSwitch?: PendingSwitchView;
  lastSwitch?: LastSwitchView;
  capabilities?: {
    resume: boolean;
    cancel: boolean;
    approval: boolean;
    attachments: boolean;
    permissionModes: string[];
    degraded: string[];
    bridges?: CapabilityBridgesView;
  };
};

const BACKEND_LABEL_KEYS: Record<string, string> = {
  claude: 'ui.chat-settings.managed-backend-claude',
  codex: 'ui.chat-settings.managed-backend-codex',
  api: 'ui.chat-settings.managed-backend-api',
};

const RUNTIME_USE_KEYS: Record<string, string> = {
  claude: 'ui.chat-settings.managed-use-claude',
  codex: 'ui.chat-settings.managed-use-codex',
  api: 'ui.chat-settings.managed-use-api',
};

export function backendLabelKey(id: string): string | undefined {
  return BACKEND_LABEL_KEYS[id];
}

export function runtimeUseKey(id: string): string | undefined {
  return RUNTIME_USE_KEYS[id];
}
