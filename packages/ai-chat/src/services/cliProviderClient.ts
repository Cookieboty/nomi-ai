import { t } from '@nomi-ai/ui';

export type ClaudeApiFormat =
  'anthropic_messages' | 'openai_chat_completions' | 'openai_responses' | 'gemini_generate_content';
export type CodexApiFormat = 'openai_responses' | 'openai_chat_completions' | 'anthropic_messages';
export type DshApiFormat = CodexApiFormat;
export type GrokApiFormat = CodexApiFormat;
export type CliProviderKind = 'claude' | 'codex' | 'dsh' | 'grok';

export interface CliProviderProfile {
  id: string;
  kind: CliProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiFormat: ClaudeApiFormat | CodexApiFormat | DshApiFormat | GrokApiFormat;
  needsRouting: boolean;
  hasKey: boolean;
  keyHint: string;
  active: boolean;
  presetId?: string;
}

export interface CliRouteSettings {
  enabled: boolean;
  host: string;
  port: number;
  claude: boolean;
  codex: boolean;
  listening: boolean;
  listenUrl: string | null;
}

export interface CliProfileTestResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
  note?: string;
}

export interface CliProviderState {
  profiles: CliProviderProfile[];
  claudeStore: string;
  codexStore: string;
  claudeSettings: string;
  codexConfig: string;
  dshStore?: string;
  dshConfig?: string;
  grokStore?: string;
  grokConfig?: string;
  routing: CliRouteSettings | null;
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

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('编程助手接入需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:cli-provider:${method}`, ...args)) as T & {
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

async function routeCall<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('编程助手接入需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:cli-route:${method}`, ...args)) as T & {
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const cliProviderClient = {
  available: () => !!bridge(),
  state: () => call<CliProviderState>('state'),
  upsert: (p: {
    id?: string;
    kind: CliProviderKind;
    name: string;
    baseUrl: string;
    model: string;
    apiFormat?: ClaudeApiFormat | CodexApiFormat;
    apiKey?: string;
    presetId?: string;
  }) => call<CliProviderProfile>('upsert', p),
  remove: (id: string) => call<CliProviderState>('remove', id),
  activate: (id: string) =>
    call<{
      ok: boolean;
      backups: string[];
      restartRequired: boolean;
      usedRouting: boolean;
      error?: string;
    }>('activate', id),
  /** 测速：对上游发一次轻量的模型列表请求 */
  test: (id: string) => call<CliProfileTestResult>('test', id),
  /** 停用该后端的档案，回到 CLI 自带登录 / 默认配置 */
  deactivate: (kind: CliProviderKind) =>
    call<{ ok: boolean; backups: string[]; error?: string }>('deactivate', kind),
  deactivateDsh: () => call<{ ok: boolean; backups: string[]; error?: string }>('deactivate-dsh'),
  onChanged: (fn: (s: CliProviderState) => void) =>
    bridge()?.on('ai:cli-provider:changed', (p) => fn(p as CliProviderState)) ?? (() => undefined),
};

export const cliRouteClient = {
  available: () => !!bridge(),
  state: () => routeCall<CliRouteSettings>('state'),
  set: (p: Partial<CliRouteSettings>) => routeCall<CliRouteSettings>('set', p),
  start: () => routeCall<CliRouteSettings>('start'),
  stop: () => routeCall<CliRouteSettings>('stop'),
};
