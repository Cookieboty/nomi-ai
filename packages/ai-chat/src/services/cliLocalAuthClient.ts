import { isBuiltinCliId, type BuiltinCliId } from '@nomi-ai/cli-catalog';

import { api, hasTransport } from './api';
import type { LoginState } from './cliAccountClient';

export interface LocalAuthStatus {
  kind: string;
  loggedIn: boolean;
  canLogin: boolean;
  canLogout: boolean;
  detail?: string;
}

export interface LocalAuthEvent {
  id: string;
  kind: string;
  state: LoginState;
  url?: string;
  code?: string;
  needsCode?: boolean;
  message?: string;
  hint?: 'network-blocked';
  useShellProxy?: boolean;
  shellProxy?: string;
}

function assertKind(kind: string): BuiltinCliId {
  if (!isBuiltinCliId(kind)) {
    throw new Error(`Unsupported CLI kind: ${kind}`);
  }
  return kind;
}

async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!cliLocalAuthClient.available()) {
    throw new Error('desktop app connection unavailable');
  }
  return (await run()) as T;
}

export const cliLocalAuthClient = {
  available(): boolean {
    return hasTransport() && typeof api.cli?.localAuthStatus === 'function';
  },
  status(kind: string, probe = false): Promise<LocalAuthStatus> {
    const cliKind = assertKind(kind);
    return call<LocalAuthStatus>(() =>
      api.cli.localAuthStatus({ kind: cliKind, ...(probe ? { probe: true } : {}) }),
    );
  },
  loginStart(kind: string): Promise<LocalAuthEvent> {
    const cliKind = assertKind(kind);
    return call<LocalAuthEvent>(() => api.cli.localAuthLoginStart({ kind: cliKind }));
  },
  loginCancel(id: string): Promise<boolean> {
    return call<boolean>(() => api.cli.localAuthLoginCancel({ id }));
  },
  logout(kind: string): Promise<{ loggedIn: boolean }> {
    const cliKind = assertKind(kind);
    return call<{ loggedIn: boolean }>(() => api.cli.localAuthLogout({ kind: cliKind }));
  },
  onEvent(fn: (e: LocalAuthEvent) => void): () => void {
    if (!hasTransport() || typeof api.on !== 'function') {
      return () => undefined;
    }
    return api.on('cli.localAuthEvent', (payload) => {
      fn(payload as unknown as LocalAuthEvent);
    });
  },
};
