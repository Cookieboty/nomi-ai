/**
 * 编程助手插件注册表与外部插件（L1 声明式，docs/design/cli-plugin-architecture.md §5.9）的渲染进程客户端：
 * 契约 `cli.registry`、`cli.pluginAdd / pluginRemove / pluginTest`、事件 `cli.registryChanged`（主进程 CliPluginHost）。
 */
import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';

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

/** 没有契约传输（浏览器预览 / 测试）时调用失败；契约错误换成普通 Error（只保留文案，与原 IPC 一致） */
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.mascot-theme.coding-agent-harness-requires-the-desktop-app'));
  try {
    return (await run()) as T;
  } catch (e) {
    throw e instanceof Error ? new Error(e.message) : e;
  }
}

export const cliPluginClient = {
  available: () => hasTransport(),
  registry: () => call<{ plugins: CliRegistryEntry[] }>(() => api.cli.registry()),
  onRegistry: (fn: (s: { plugins: CliRegistryEntry[] }) => void) =>
    hasTransport()
      ? api.on('cli.registryChanged', (p) => fn(p as unknown as { plugins: CliRegistryEntry[] }))
      : () => undefined,
  add: (spec: ExternalCliSpec) =>
    call<{ ok: true; entry: CliRegistryEntry } | { ok: false; errors: string[] }>(() =>
      api.cli.pluginAdd({ spec: spec as never }),
    ),
  remove: (id: string) => call<boolean>(() => api.cli.pluginRemove({ id })),
  test: (spec: ExternalCliSpec) =>
    call<ExternalTestResult>(() => api.cli.pluginTest({ spec: spec as never })),
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
