/**
 * Nomi 把编程助手当子代理调用（docs/design/nomi-delegate-cli.md）：
 * - 设置：总开关 + 按任务类型的默认编程助手（§4.7）；
 * - `/agent`（旧名 `/cli`）：指定下一个需求交给哪个编程助手（§4.6）。渲染层先记在 nextDelegate 里（输入框上方的 chip），
 *   发送时 consumeNextDelegate() 取出，经 `ai:delegate:pin` 钉到主进程，模型改不了。
 */
import { t } from '@nomi-ai/ui';

export const DELEGATE_CLIS = ['claude', 'codex', 'grok', 'gemini', 'dsh'] as const;
export type DelegateCli = (typeof DELEGATE_CLIS)[number];

export const DELEGATE_KINDS = ['coding', 'prd', 'review', 'research'] as const;
export type DelegateKind = (typeof DELEGATE_KINDS)[number];

export interface DelegateSettings {
  enabled: boolean;
  defaults: Partial<Record<DelegateKind, DelegateCli>>;
}

export interface DelegateSettingsView extends DelegateSettings {
  /** 已安装、可以委派的编程助手 */
  installed: DelegateCli[];
  pinned: DelegateCli | null;
}

/** 主进程 delegate_to_cli 交回 Nomi 的结果（工具调用的 output） */
export interface DelegateResult {
  taskId: string;
  cli: DelegateCli;
  status: 'done' | 'error' | 'cancelled';
  cancelledBy?: 'user' | 'nomi';
  report?: { done: string; changedFiles: string[]; unfinished?: string; needsUser?: string };
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

export const delegateClient = {
  available: () => !!bridge(),
  settings: () => call<DelegateSettingsView>('ai:delegate:settings'),
  setSettings: (s: DelegateSettings) => call<DelegateSettings>('ai:delegate:set-settings', s),
  pin: (cli: DelegateCli | null) => call<DelegateCli | null>('ai:delegate:pin', cli),
};

// ───────────────────────── 下一个需求交给谁（输入框上方的 chip） ─────────────────────────

let nextDelegate: DelegateCli | null = null;
const listeners = new Set<() => void>();

export function getNextDelegate(): DelegateCli | null {
  return nextDelegate;
}

export function setNextDelegate(cli: DelegateCli | null): void {
  if (cli === nextDelegate) return;
  nextDelegate = cli;
  for (const l of listeners) l();
}

export function subscribeNextDelegate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 发送 Nomi 消息时取出并清除；钉到主进程失败时不影响发送（Nomi 退回按设置选） */
export async function consumeNextDelegate(): Promise<DelegateCli | null> {
  const cli = nextDelegate;
  if (!cli) return null;
  setNextDelegate(null);
  await delegateClient.pin(cli).catch(() => undefined);
  return cli;
}

/** 发给 Nomi 模型的消息前面加的说明（界面上只显示用户原文和「交给 X」标记） */
export function delegateDirective(name: string): string {
  return t(
    '用户指定把下面的需求交给 {0} 完成：请整理成具体的任务说明，调用 delegate_to_cli。',
    name,
  );
}
