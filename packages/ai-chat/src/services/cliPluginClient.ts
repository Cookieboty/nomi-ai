/**
 * 编程助手插件注册表与外部插件（L1 声明式，docs/design/cli-plugin-architecture.md §5.9）的渲染进程客户端：
 * `ai:cli:registry`、`ai:cli:plugin-add / plugin-remove / plugin-test`（主进程 CliPluginHost）。
 */
import { t } from '@nomi-ai/ui';

/** 外部插件清单（与 @nomi-ai/cli-sdk 的 ExternalCliSpec 一致；只有命令、参数模板与环境变量名） */
export interface ExternalCliSpec {
  version: 1;
  id: string;
  displayName: string;
  command: string;
  args: string[];
  env?: string[];
}

export interface CliRegistryEntry {
  id: string;
  displayName: string;
  builtin: boolean;
  status: 'loading' | 'ready' | 'invalid' | 'failed';
  errors: string[];
  version: string | null;
  transport: string;
  capabilities: { images?: 'native' | 'path' | 'none'; resume?: boolean; [k: string]: unknown };
  external?: ExternalCliSpec & { missingEnv: string[] };
}

export type ExternalTestResult =
  | {
      ok: true;
      missingEnv: string[];
      protocolVersion: number | null;
      agent: { name?: string; title?: string; version?: string };
      capabilities: {
        loadSession: boolean;
        images: boolean;
        audio: boolean;
        embeddedContext: boolean;
      };
      authMethods: string[];
    }
  | { ok: false; errors: string[] };

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
  if (!b) throw new Error(t('ui.mascot-theme.coding-agent-harness-requires-the-desktop-app'));
  const r = (await b.invoke(`ai:cli:${method}`, ...args)) as T & { __error?: { message: string } };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const cliPluginClient = {
  available: () => !!bridge(),
  registry: () => call<{ plugins: CliRegistryEntry[] }>('registry'),
  onRegistry: (fn: (s: { plugins: CliRegistryEntry[] }) => void) =>
    bridge()?.on('ai:cli:registry-changed', (p) => fn(p as { plugins: CliRegistryEntry[] })) ??
    (() => undefined),
  add: (spec: ExternalCliSpec) =>
    call<{ ok: true; entry: CliRegistryEntry } | { ok: false; errors: string[] }>(
      'plugin-add',
      spec,
    ),
  remove: (id: string) => call<boolean>('plugin-remove', id),
  test: (spec: ExternalCliSpec) => call<ExternalTestResult>('plugin-test', spec),
};

/** 名称 → 默认 id：小写、非字母数字换成 -（用户可以改） */
export function idFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'my-cli'
  );
}

/** 清单校验错误（主进程返回的英文短句）→ 界面文案 */
export function describeSpecError(e: string): string {
  if (e.startsWith('id ') && e.includes('reserved'))
    return t('ui.providers-schedule.this-id-is-already-used-by-a-built');
  if (e.startsWith('id must'))
    return t('ui.providers-schedule.the-id-can-only-use-lowercase-letters-digits');
  if (e.startsWith('displayName'))
    return t('ui.providers-schedule.a-name-is-required-up-to-60-characters');
  if (e.startsWith('command must not contain placeholders'))
    return t('ui.providers-schedule.the-command-can-t-contain-placeholders');
  if (e.startsWith('command'))
    return t('ui.providers-schedule.a-command-is-required-and-can-t-contain');
  const ph = /^args\[(\d+)\] uses unknown placeholder \{(.*)\}$/.exec(e);
  if (ph)
    return t(
      'ui.providers-schedule.argument-uses-the-unknown-placeholder-only-are-allowed',
      Number(ph[1]) + 1,
      `{${ph[2]!}}`,
      '{cwd}、{home}',
    );
  if (e.startsWith('args')) return t('ui.providers-schedule.at-most-32-arguments-each-up-to-512');
  if (e.startsWith('env'))
    return t('ui.providers-schedule.write-environment-variable-names-only-such-as-my');
  return e;
}
