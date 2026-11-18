import { cliCapability } from '@nomi-ai/cli-catalog';
import { useEffect, useSyncExternalStore } from 'react';

import { api, hasTransport } from './api';

export interface CliLauncherSettings {
  enabled: boolean;
  command: string;
  accountSource: 'local' | 'nomi';
}

type RawLauncherSettings = Partial<CliLauncherSettings> & { hasLocalLogin?: boolean };

const DEFAULT: CliLauncherSettings = { enabled: false, command: '', accountSource: 'nomi' };
let current: Record<string, CliLauncherSettings> = {};
let localLogins: Record<string, boolean> = {};
let loaded = false;
let loading: Promise<Record<string, CliLauncherSettings>> | null = null;
const listeners = new Set<() => void>();
const normalize = (value: Partial<CliLauncherSettings> | null): CliLauncherSettings => ({
  enabled: value?.enabled === true,
  command: typeof value?.command === 'string' ? value.command : '',
  accountSource: value?.accountSource === 'local' ? 'local' : 'nomi',
});
const publish = (value: Record<string, RawLauncherSettings>) => {
  current = Object.fromEntries(Object.entries(value).map(([kind, s]) => [kind, normalize(s)]));
  const nextLocal: Record<string, boolean> = {};
  for (const [kind, s] of Object.entries(value)) {
    nextLocal[kind] = s?.hasLocalLogin === true;
  }
  localLogins = nextLocal;
  loaded = true;
  listeners.forEach((fn) => fn());
  return current;
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const cliLauncherClient = {
  get: () => {
    if (loaded || !hasTransport()) return Promise.resolve(current);
    loading ??= api.cli
      .launcherGet()
      .then((res) => publish(res as Record<string, RawLauncherSettings>))
      .finally(() => {
        loading = null;
      });
    return loading;
  },
  save: async (kind: string, settings: CliLauncherSettings) => {
    const raw = (await api.cli.launcherSet({ kind, settings })) as RawLauncherSettings | null;
    const saved = normalize(raw);
    publish({
      ...Object.fromEntries(
        Object.entries(current).map(([k, v]) => [k, { ...v, hasLocalLogin: localLogins[k] }]),
      ),
      [kind]: { ...saved, hasLocalLogin: raw?.hasLocalLogin === true },
    });
    return saved;
  },
  test: (kind: string, command: string) => api.cli.launcherTest({ kind, command }),
  resetCache: () => {
    current = {};
    localLogins = {};
    loaded = false;
    loading = null;
  },
};

export const supportsCustomLauncher = (kind: string | null | undefined): boolean =>
  !!kind && cliCapability(kind, 'officialAccount');

export function launcherManagesLogin(kind: string): boolean {
  return supportsCustomLauncher(kind) && current[kind]?.accountSource === 'local';
}

export function useCliLauncher(kind: string | null | undefined): CliLauncherSettings {
  const settings = useSyncExternalStore(subscribe, () => (kind && current[kind]) || DEFAULT);
  useEffect(() => {
    void cliLauncherClient.get().catch(() => undefined);
  }, []);
  return settings;
}

export function useHasLocalLogin(kind: string | null | undefined): boolean {
  const hasLocal = useSyncExternalStore(subscribe, () => !!(kind && localLogins[kind]));
  useEffect(() => {
    void cliLauncherClient.get().catch(() => undefined);
  }, []);
  return hasLocal;
}
