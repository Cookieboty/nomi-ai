import { BUILTIN_CLI_ORDER, type BuiltinCliId, byCli, cliName } from '@nomi-ai/cli-catalog';
/**
 * Nomi 把 agent 当子代理调用（docs/development/coding-agents.md）：
 * - 设置：总开关 + 按任务类型的默认 agent；
 * - `/agent`（旧名 `/cli`）：指定下一个需求交给哪个 agent。渲染层按 conversationId 记在
 *   nextDelegatePins 里（输入框上方的 chip），发送时 consumeNextDelegate(turnId) 取出，
 *   经契约 `delegate.pin` 按 turnId 钉到主进程；钉住失败则中止发送。本轮结束 clearTurnPin。
 *   带需求的 `/agent` 和钉住后的下一条消息都走 `delegate.dispatch`，直接开始后台任务，
 *   不指望对话模型去调工具。
 */
import { t } from '@nomi-ai/ui';
import { useEffect, useState } from 'react';

import { api, hasTransport } from './api';
import {
  accountDisplayLabel,
  cachedAccountLabel,
  isDefaultAccountLabel,
  type CliAccount,
} from './cliAccountClient';
import { refSlashLabel } from './cliSource';
import type { GatewayState } from './gatewayClient';
import type { HarnessUsage, ReasoningEffort } from './harnessClient';

export const DELEGATE_CLIS = BUILTIN_CLI_ORDER;
export type DelegateCli = BuiltinCliId;

export const DELEGATE_KINDS = ['coding', 'prd', 'review', 'research'] as const;
export type DelegateKind = (typeof DELEGATE_KINDS)[number];

export type RunnerSource = 'local' | 'official' | 'thirdParty';
export type CostTier = 'high' | 'medium' | 'low';
export type RunnerEffort = ReasoningEffort;

export interface RunnerPreset {
  id: string;
  label: string;
  cli: DelegateCli;
  source: RunnerSource;
  accountId?: string | null;
  model?: string | null;
  reasoningEffort?: RunnerEffort | null;
  costTier?: CostTier;
}

export const ROUTABLE_TASK_KINDS = [
  'coding',
  'review',
  'research',
  'prd',
  'scheduled',
  'complex',
  'simple',
] as const;
export type RoutableTaskKind = (typeof ROUTABLE_TASK_KINDS)[number];

export type RouteTarget =
  | { kind: 'preset'; presetId: string }
  | {
      kind: 'custom';
      cli: DelegateCli;
      source: RunnerSource;
      accountId?: string | null;
      model?: string | null;
      reasoningEffort?: RunnerEffort | null;
    };

/** 委派模型档位（与主进程 AgentProfile 对齐） */
export interface AgentProfile {
  id: string;
  label: string;
  model?: string;
  reasoningEffort?: string | null;
  preferLocal?: boolean;
}

export interface DelegateSettings {
  enabled: boolean;
  defaults: Partial<Record<DelegateKind, DelegateCli>>;
  defaultProfileId?: string;
  profiles?: AgentProfile[];
  cheapModel?: string;
  autoComplexity?: boolean;
  presets?: RunnerPreset[];
  routes?: Partial<Record<RoutableTaskKind, RouteTarget>>;
}

export interface DelegateSettingsView extends DelegateSettings {
  /** 已安装、可以委派的 agent */
  installed: DelegateCli[];
  pinned: DelegateCli | string | null;
  /** 合并后的可用档位 */
  availableProfiles: AgentProfile[];
  /** 各支持账号的 CLI 在本机默认目录是否已有终端登录 */
  localAvailable?: Partial<Record<DelegateCli, boolean>>;
}

/** 主进程 delegate_to_cli 交回 Nomi 的结果（工具调用的 output） */
export interface DelegateResult {
  taskId: string;
  /** 派给 Nomi 的任务是 'nomi' */
  cli: DelegateCli | 'nomi';
  status: 'running' | 'done' | 'error' | 'cancelled';
  cancelledBy?: 'user' | 'nomi';
  report?: { done: string; changedFiles: string[]; unfinished?: string; needsUser?: string };
  /** 汇报缺失时 git 核对到的改动文件（相对 cwd） */
  changedFiles?: string[];
  conflictedFiles?: string[];
  /** 派给 Nomi 的任务生成的图片（chat-asset:// 地址） */
  images?: string[];
  summary: string;
  filesVerified: boolean;
  approvals: { asked: number; denied: number; timedOut: number };
  error?: string;
  startedAt?: number;
  durationMs: number;
  usage?: HarnessUsage;
  isolationNote?: string;
  /** 发起委派的 Nomi 会话；完成结果写回该会话（#116） */
  conversationId?: string;
  /** 委派结束后在子任务里接着跑的一轮（用户接着对话 / 沙箱授权后续跑）的结果 */
  followUp?: boolean;
  /** 是否为异步后台委派的完成广播（同步工具调用的广播不带或为 false） */
  background?: boolean;
  /** 子任务标签：来源对话从它的会话里读改动的 +/− 与 Diff */
  tabId?: string;
  /** 改动落地的目标工作目录（worktree 拷回后为主目录；转存新分支或未验收落地时为 null） */
  cwd?: string | null;
}

export function delegateKindLabel(k: DelegateKind): string {
  switch (k) {
    case 'coding':
      return t('ui.chat-settings.coding');
    case 'prd':
      return t('ui.chat-settings.prd-requirements');
    case 'review':
      return t('ui.slash-commands.code-review');
    case 'research':
      return t('ui.chat-settings.research');
  }
}

export function routableTaskKindLabel(k: RoutableTaskKind): string {
  switch (k) {
    case 'complex':
      return t('ui.chat-settings.route-kind-complex');
    case 'coding':
      return t('ui.chat-settings.route-kind-coding');
    case 'review':
      return t('ui.slash-commands.code-review');
    case 'research':
      return t('ui.chat-settings.route-kind-research');
    case 'prd':
      return t('ui.chat-settings.route-kind-prd');
    case 'simple':
      return t('ui.chat-settings.route-kind-simple');
    case 'scheduled':
      return t('ui.chat-settings.route-kind-scheduled');
  }
}

/** 返回档位在界面的国际化展示名（内置三档走前端 i18n，自定义档位按用户命名显示）。 */
export function presetDisplayLabel(p: Pick<RunnerPreset, 'id' | 'label'>): string {
  switch (p.id) {
    case 'high':
      return t('ui.models.preset-builtin-high');
    case 'balanced':
      return t('ui.models.preset-builtin-balanced');
    case 'low':
      return t('ui.models.preset-builtin-low');
    default:
      return p.label;
  }
}

export function formatRunnerSourceLabel(
  source: RunnerSource,
  accountId: string | null | undefined,
  accounts?: CliAccount[],
): string {
  if (source === 'local') return t('ui.models.runner-picker-local-label');
  if (source === 'official') {
    const officialBase = t('ui.chat-settings.official-accounts');
    if (accountId) {
      const acc = accounts?.find((a) => a.id === accountId);
      const label = acc ? accountDisplayLabel(acc) : cachedAccountLabel(accountId);
      if (!label) return officialBase;
      if (isDefaultAccountLabel(label)) return label;
      return t('ui.models.runner-picker-official-account-label', label);
    }
    return officialBase;
  }
  return t('ui.cli-monitor.third-party');
}

export function formatRunnerSummary(
  spec: {
    cli: DelegateCli;
    source: RunnerSource;
    accountId?: string | null;
    model?: string | null;
  },
  gateway?: GatewayState | null,
  accounts?: CliAccount[],
): string {
  const assistant = cliName(spec.cli);
  if (spec.source === 'thirdParty') {
    const modelText = spec.model
      ? refSlashLabel(gateway ?? null, spec.model)
      : t('ui.cli-monitor.third-party');
    return `${assistant} · ${modelText}`;
  }
  const srcLabel = formatRunnerSourceLabel(spec.source, spec.accountId, accounts);
  return spec.model ? `${assistant} · ${srcLabel} · ${spec.model}` : `${assistant} · ${srcLabel}`;
}

const ALIASES: Record<string, DelegateCli> = {
  ...byCli((id) => id),
  'claude-code': 'claude',
  claudecode: 'claude',
  cc: 'claude',
};

/** `/agent` 后面的名字 → Agents id（不区分大小写，接受别名）；认不出返回 null */
export function resolveDelegateCli(name: string): DelegateCli | null {
  return ALIASES[name.trim().toLowerCase().replace(/\s+/g, '-')] ?? null;
}

/** 没有契约传输（浏览器预览 / 测试）时调用失败；契约错误换成普通 Error（只保留文案，与原 IPC 一致） */
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.chat-settings.handing-off-to-coding-assistants-needs-the-desktop'));
  try {
    return (await run()) as T;
  } catch (e) {
    throw e instanceof Error ? new Error(e.message) : e;
  }
}

/** 委派需求的长度上限（与契约 `delegate.dispatch` 和 delegate_to_cli 的 goal 一致） */
export const DELEGATE_GOAL_MAX = 4000;

export const delegateClient = {
  available: () => hasTransport(),
  settings: () => call<DelegateSettingsView>(() => api.delegate.settings()),
  setSettings: (s: Partial<DelegateSettings>) =>
    call<DelegateSettings>(() => api.delegate.setSettings({ settings: s as never })),
  /** 按 turnId 钉到主进程；支持 cli 或 `preset:<id>`；turnId 与本轮 Nomi reqId 对齐 */
  pin: (target: DelegateCli | string | null, turnId: string) =>
    call<DelegateCli | string | null>(() =>
      target && target.startsWith('preset:')
        ? api.delegate.pin({ presetId: target.slice('preset:'.length), turnId })
        : api.delegate.pin({ cli: (target as DelegateCli | null) ?? null, turnId }),
    ),
  clearPin: (turnId: string) => call<boolean>(() => api.delegate.clearPin({ turnId })),
  /**
   * `/agent 名字 需求` 或按 preset / source 直接派出，不经过对话模型。
   */
  dispatch: (
    input: {
      cli?: DelegateCli;
      presetId?: string;
      source?: RunnerSource;
      accountId?: string;
      model?: string;
      reasoningEffort?: RunnerEffort;
      goal: string;
      context?: string;
      conversationId?: string;
      projectId?: string;
      turnId?: string;
    },
    signal?: AbortSignal,
  ) => call<DelegateResult>(() => api.delegate.dispatch(input, signal ? { signal } : undefined)),
  /** 查后台委派状态（主进程 tasks；无则 null） */
  status: (taskId: string) => call<DelegateResult | null>(() => api.delegate.status({ taskId })),
  /** 后台委派完成时主进程广播 */
  onCompleted: (fn: (r: DelegateResult) => void) =>
    hasTransport()
      ? api.on('delegate.completed', (p) => fn(p as unknown as DelegateResult))
      : () => undefined,
};

/** 按需读取委派启用状态下的预设档位（菜单/弹窗关闭时不触发请求） */
export function useDelegatePresets(active = true): RunnerPreset[] {
  const [presets, setPresets] = useState<RunnerPreset[]>([]);
  useEffect(() => {
    if (!active || !hasTransport()) return;
    let alive = true;
    void delegateClient
      .settings()
      .then((v) => {
        if (alive) setPresets(v?.enabled && Array.isArray(v.presets) ? v.presets : []);
      })
      .catch(() => {
        if (alive) setPresets([]);
      });
    return () => {
      alive = false;
    };
  }, [active]);
  return active ? presets : [];
}

// ───────────────────────── 下一个需求交给谁（按会话；输入框上方的 chip） ─────────────────────────

export type NextDelegatePin = DelegateCli | `preset:${string}`;

export const isPresetPin = (v: string | null | undefined): v is `preset:${string}` =>
  !!v && v.startsWith('preset:');

export interface NextDelegateMeta {
  cli: DelegateCli;
  label: string;
}

/** conversationId → 钉住的 agent 或预设（切换会话互不影响） */
const nextDelegatePins = new Map<string, NextDelegatePin>();
/** 预设 pin 对应的 CLI 与胶囊摘要（供 ComposerBar 与 dispatch 解析） */
const nextDelegateMetas = new Map<string, NextDelegateMeta>();
/** 当前输入框所属会话；未绑定时用 ''（单测 / 未开会话） */
let activeConversationId = '';
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** 绑定 chip 读的是哪个会话的钉住（会话切换 / 发送前调用） */
export function bindNextDelegateConversation(conversationId: string | null | undefined): void {
  const id = conversationId ?? '';
  if (id === activeConversationId) return;
  activeConversationId = id;
  notify();
}

export function getNextDelegate(): NextDelegatePin | null {
  return nextDelegatePins.get(activeConversationId) ?? null;
}

export function getNextDelegateMeta(
  target?: NextDelegatePin | null,
  convoId = activeConversationId,
): NextDelegateMeta | null {
  if (target && !isPresetPin(target)) {
    return { cli: target, label: cliName(target) };
  }
  return nextDelegateMetas.get(convoId) ?? null;
}

export function setNextDelegate(target: NextDelegatePin | null, meta?: NextDelegateMeta): void {
  const id = activeConversationId;
  const cur = nextDelegatePins.get(id) ?? null;
  const curMeta = nextDelegateMetas.get(id) ?? null;
  if (
    target === cur &&
    (meta?.cli ?? null) === (curMeta?.cli ?? null) &&
    (meta?.label ?? null) === (curMeta?.label ?? null)
  )
    return;
  if (target) {
    nextDelegatePins.set(id, target);
    if (meta) nextDelegateMetas.set(id, meta);
    else nextDelegateMetas.delete(id);
  } else {
    nextDelegatePins.delete(id);
    nextDelegateMetas.delete(id);
  }
  notify();
}

export function subscribeNextDelegate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 发送 Nomi 消息时取出并清除本会话的 chip，经 IPC 按 turnId 钉到主进程。
 * 钉住失败抛错：调用方必须中止发送（不要附加「交给 X」继续）。
 */
export async function consumeNextDelegate(turnId: string): Promise<NextDelegatePin | null> {
  const id = activeConversationId;
  const target = nextDelegatePins.get(id) ?? null;
  if (!target) return null;
  await delegateClient.pin(target, turnId);
  nextDelegatePins.delete(id);
  notify();
  return target;
}

/** 本轮结束（无论是否委派）清除主进程该 turn 的钉住 */
export async function clearTurnPin(turnId: string): Promise<void> {
  if (!turnId || !hasTransport()) return;
  await delegateClient.clearPin(turnId).catch(() => undefined);
}

/** 发给 Nomi 模型的消息前面加的说明（界面上只显示用户原文和「交给 X」标记） */
export function delegateDirective(name: string): string {
  return t('ui.session-workspace.the-user-wants-to-handle-the-request-below', name);
}
