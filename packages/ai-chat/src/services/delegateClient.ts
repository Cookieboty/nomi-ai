/**
 * Nomi 把编程助手当子代理调用（docs/design/nomi-delegate-cli.md）：
 * - 设置：总开关 + 按任务类型的默认编程助手（§4.7）；
 * - `/agent`（旧名 `/cli`）：指定下一个需求交给哪个编程助手（§4.6）。渲染层按 conversationId 记在
 *   nextDelegatePins 里（输入框上方的 chip），发送时 consumeNextDelegate(turnId) 取出，
 *   经 `ai:delegate:pin` 按 turnId 钉到主进程；钉住失败则中止发送。本轮结束 clearTurnPin。
 */
import { t } from '@nomi-ai/ui';

export const DELEGATE_CLIS = ['claude', 'codex', 'grok', 'gemini', 'dsh'] as const;
export type DelegateCli = (typeof DELEGATE_CLIS)[number];

export const DELEGATE_KINDS = ['coding', 'prd', 'review', 'research'] as const;
export type DelegateKind = (typeof DELEGATE_KINDS)[number];

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
}

export interface DelegateSettingsView extends DelegateSettings {
  /** 已安装、可以委派的编程助手 */
  installed: DelegateCli[];
  pinned: DelegateCli | null;
  /** 合并后的可用档位 */
  availableProfiles: AgentProfile[];
}

/** 主进程 delegate_to_cli 交回 Nomi 的结果（工具调用的 output） */
export interface DelegateResult {
  taskId: string;
  cli: DelegateCli;
  status: 'running' | 'done' | 'error' | 'cancelled';
  cancelledBy?: 'user' | 'nomi';
  report?: { done: string; changedFiles: string[]; unfinished?: string; needsUser?: string };
  /** 汇报缺失时 git 核对到的改动文件（相对 cwd） */
  changedFiles?: string[];
  summary: string;
  filesVerified: boolean;
  approvals: { asked: number; denied: number; timedOut: number };
  error?: string;
  durationMs: number;
}

export function delegateKindLabel(k: DelegateKind): string {
  switch (k) {
    case 'coding':
      return t('编程开发');
    case 'prd':
      return t('PRD / 需求文档');
    case 'review':
      return t('代码审查');
    case 'research':
      return t('调研分析');
  }
}

const ALIASES: Record<string, DelegateCli> = {
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude',
  cc: 'claude',
  codex: 'codex',
  grok: 'grok',
  gemini: 'gemini',
  dsh: 'dsh',
};

/** `/agent` 后面的名字 → 编程助手 id（不区分大小写，接受别名）；认不出返回 null */
export function resolveDelegateCli(name: string): DelegateCli | null {
  return ALIASES[name.trim().toLowerCase().replace(/\s+/g, '-')] ?? null;
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}

const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('委派编程助手需要在桌面应用中使用'));
  const r = (await b.invoke(channel, ...args)) as T & { __error?: { message: string } };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

export const delegateClient = {
  available: () => !!bridge(),
  settings: () => call<DelegateSettingsView>('ai:delegate:settings'),
  setSettings: (s: Partial<DelegateSettings>) =>
    call<DelegateSettings>('ai:delegate:set-settings', s),
  /** 按 turnId 钉到主进程；turnId 与本轮 Nomi reqId 对齐 */
  pin: (cli: DelegateCli | null, turnId: string) =>
    call<DelegateCli | null>('ai:delegate:pin', cli, turnId),
  clearPin: (turnId: string) => call<boolean>('ai:delegate:clear-pin', turnId),
  /** 查后台委派状态（主进程 tasks；无则 null） */
  status: (taskId: string) => call<DelegateResult | null>('ai:delegate:status', taskId),
  /** 后台委派完成时主进程广播 */
  onCompleted: (fn: (r: DelegateResult) => void) =>
    on('ai:delegate:completed', (p) => fn(p as DelegateResult)),
};

// ───────────────────────── 下一个需求交给谁（按会话；输入框上方的 chip） ─────────────────────────

/** conversationId → 钉住的编程助手（切换会话互不影响） */
const nextDelegatePins = new Map<string, DelegateCli>();
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

export function getNextDelegate(): DelegateCli | null {
  return nextDelegatePins.get(activeConversationId) ?? null;
}

export function setNextDelegate(cli: DelegateCli | null): void {
  const id = activeConversationId;
  const cur = nextDelegatePins.get(id) ?? null;
  if (cli === cur) return;
  if (cli) nextDelegatePins.set(id, cli);
  else nextDelegatePins.delete(id);
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
export async function consumeNextDelegate(turnId: string): Promise<DelegateCli | null> {
  const id = activeConversationId;
  const cli = nextDelegatePins.get(id) ?? null;
  if (!cli) return null;
  await delegateClient.pin(cli, turnId);
  nextDelegatePins.delete(id);
  notify();
  return cli;
}

/** 本轮结束（无论是否委派）清除主进程该 turn 的钉住 */
export async function clearTurnPin(turnId: string): Promise<void> {
  if (!turnId || !bridge()) return;
  await delegateClient.clearPin(turnId).catch(() => undefined);
}

/** 发给 Nomi 模型的消息前面加的说明（界面上只显示用户原文和「交给 X」标记） */
export function delegateDirective(name: string): string {
  return t(
    '用户指定把下面的需求交给 {0} 完成：请整理成具体的任务说明，调用 delegate_to_cli（默认后台，立刻返回 taskId；完成后可用 delegate_status 查看）。',
    name,
  );
}
