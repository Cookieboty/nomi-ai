// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearManagedDefaultRuntime,
  getManagedDefaultRuntime,
  saveManagedDefaultRuntime,
  subscribeManagedDefaultRuntime,
} from '../src/services/chatPrefs';
import {
  applyManagedDefaultToConversation,
  buildManagedRuntimeInitFromPref,
  defaultManagedPermissionMode,
} from '../src/services/managedDefaultRuntime';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const TEST_ACP_BACKEND = 'acp-agent-a';
const TEST_ALT_BACKEND = 'acp-agent-b';

describe('managed default runtime preference and new conversation adoption', () => {
  beforeEach(() => {
    clearManagedDefaultRuntime();
  });

  afterEach(() => {
    clearManagedDefaultRuntime();
    resetFakeApi();
  });

  it('persists backend and per-backend model/effort/source/account, preserves perBackend on api switch, and sanitizes disallowed fields', () => {
    saveManagedDefaultRuntime({
      backend: TEST_ACP_BACKEND,
      source: 'official',
      model: 'model-alpha',
      effort: 'high',
      accountId: 'acc-work',
      permissionMode: 'acceptEdits',
    });

    expect(getManagedDefaultRuntime()).toEqual({
      backend: TEST_ACP_BACKEND,
      perBackend: {
        [TEST_ACP_BACKEND]: {
          source: 'official',
          model: 'model-alpha',
          effort: 'high',
          accountId: 'acc-work',
          permissionMode: 'acceptEdits',
        },
      },
    });

    // Switching back to api updates top-level backend while retaining CLI perBackend config.
    saveManagedDefaultRuntime({ backend: 'api' });
    expect(getManagedDefaultRuntime()).toEqual({
      backend: 'api',
      perBackend: {
        [TEST_ACP_BACKEND]: {
          source: 'official',
          model: 'model-alpha',
          effort: 'high',
          accountId: 'acc-work',
          permissionMode: 'acceptEdits',
        },
      },
    });

    // Disallowed values (bypass, cli-default, default, placeholder accountId) are stripped while valid source stays.
    saveManagedDefaultRuntime({
      backend: TEST_ALT_BACKEND,
      source: 'local',
      model: 'cli-default',
      effort: 'default',
      accountId: 'config-source:/tmp',
      permissionMode: 'bypass',
    });
    expect(getManagedDefaultRuntime()?.perBackend?.[TEST_ALT_BACKEND]).toEqual({
      source: 'local',
    });

    // Invalid source is also stripped.
    saveManagedDefaultRuntime({
      backend: TEST_ALT_BACKEND,
      source: 'invalid-source',
      model: 'cli-default',
    });
    expect(getManagedDefaultRuntime()?.perBackend?.[TEST_ALT_BACKEND]).toEqual({});

    expect(
      buildManagedRuntimeInitFromPref(
        {
          source: 'local',
          model: 'chat-route',
          effort: 'medium',
          accountId: 'acc-stale',
          permissionMode: 'bypass',
        },
        { permissionModes: ['ask'] },
      ),
    ).toEqual({
      source: 'local',
      effort: 'medium',
    });

    expect(
      buildManagedRuntimeInitFromPref(
        {
          source: 'local',
          model: 'model-x',
          effort: 'high',
          permissionMode: 'ask',
        },
        { permissionModes: ['ask', 'auto'] },
        { includePermissionMode: false },
      ),
    ).toEqual({
      source: 'local',
      model: 'model-x',
      effort: 'high',
    });

    expect(defaultManagedPermissionMode(['deny', 'ask', 'acceptEdits', 'auto', 'bypass'])).toBe(
      'auto',
    );
    expect(defaultManagedPermissionMode(['deny', 'acceptEdits', 'bypass'])).toBe('acceptEdits');
    expect(defaultManagedPermissionMode(['deny', 'ask'])).toBe('ask');
    expect(defaultManagedPermissionMode(['deny'])).toBe('deny');
    expect(defaultManagedPermissionMode([])).toBeUndefined();
  });

  it('auto-adopts new empty conversation with remembered backend, model, effort and source while deferring permissionMode to default auto', async () => {
    saveManagedDefaultRuntime({
      backend: TEST_ACP_BACKEND,
      source: 'local',
      model: 'model-neon',
      effort: 'high',
      permissionMode: 'ask',
    });

    const fake = installFakeApi((name, input) => {
      if (name === 'conversations.runtimeCapabilities') {
        return {
          supported: true,
          backends: ['api', TEST_ACP_BACKEND],
          detail: '',
          choices: [
            {
              id: TEST_ACP_BACKEND,
              available: true,
              status: 'ready',
              detail: '',
              login: 'unverified',
              requiresProject: true,
              degraded: [],
              permissionModes: ['deny', 'ask', 'acceptEdits', 'auto', 'bypass'],
            },
          ],
        };
      }
      if (name === 'conversations.runtimeAdopt') {
        return { id: input.id, backend: input.backend, phase: 'idle', generation: 1 };
      }
      return {};
    });

    const flush = vi.fn(async () => undefined);
    const refreshManaged = vi.fn(async () => undefined);
    const ok = await applyManagedDefaultToConversation('c_new', {
      flush,
      hasMessages: () => false,
      isManaged: () => false,
      refreshManaged,
    });

    expect(ok).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(refreshManaged).toHaveBeenCalledWith('c_new');
    expect(fake.inputs('conversations.runtimeAdopt')).toEqual([
      {
        id: 'c_new',
        backend: TEST_ACP_BACKEND,
        confirm: true,
        source: 'local',
        model: 'model-neon',
        effort: 'high',
      },
    ]);
  });

  it('silently falls back without clearing saved preference when backend needs project or is unavailable', async () => {
    saveManagedDefaultRuntime({
      backend: TEST_ACP_BACKEND,
      source: 'local',
      model: 'model-neon',
      effort: 'medium',
    });

    const fake = installFakeApi((name) => {
      if (name === 'conversations.runtimeCapabilities') {
        return {
          supported: true,
          backends: ['api', TEST_ACP_BACKEND],
          detail: '',
          choices: [
            {
              id: TEST_ACP_BACKEND,
              available: false,
              status: 'no-project',
              detail: '',
              login: 'not-advertised',
              requiresProject: true,
              degraded: [],
            },
          ],
        };
      }
      return {};
    });

    const ok = await applyManagedDefaultToConversation('c_no_proj', {
      flush: vi.fn(async () => undefined),
      hasMessages: () => false,
      isManaged: () => false,
      refreshManaged: vi.fn(async () => undefined),
    });

    expect(ok).toBe(false);
    expect(fake.inputs('conversations.runtimeAdopt')).toHaveLength(0);
    expect(getManagedDefaultRuntime()).toEqual({
      backend: TEST_ACP_BACKEND,
      perBackend: {
        [TEST_ACP_BACKEND]: {
          source: 'local',
          model: 'model-neon',
          effort: 'medium',
        },
      },
    });
  });

  it('retries runtimeAdopt with bare backend when remembered model/account configuration is rejected', async () => {
    saveManagedDefaultRuntime({
      backend: TEST_ACP_BACKEND,
      source: 'official',
      model: 'deleted-provider/old-model',
      accountId: 'removed-acc',
    });

    let adoptCalls = 0;
    const fake = installFakeApi((name, input) => {
      if (name === 'conversations.runtimeCapabilities') {
        return {
          supported: true,
          backends: ['api', TEST_ACP_BACKEND],
          detail: '',
          choices: [
            {
              id: TEST_ACP_BACKEND,
              available: true,
              status: 'ready',
              detail: '',
              login: 'unverified',
              requiresProject: true,
              degraded: [],
            },
          ],
        };
      }
      if (name === 'conversations.runtimeAdopt') {
        adoptCalls++;
        if (input.model) {
          throw new Error('stale model');
        }
        return { id: input.id, backend: input.backend, phase: 'idle', generation: 1 };
      }
      return {};
    });

    const ok = await applyManagedDefaultToConversation('c_stale', {
      flush: vi.fn(async () => undefined),
      hasMessages: () => false,
      isManaged: () => false,
      refreshManaged: vi.fn(async () => undefined),
    });

    expect(ok).toBe(true);
    expect(adoptCalls).toBe(2);
    expect(fake.inputs('conversations.runtimeAdopt')[1]).toEqual({
      id: 'c_stale',
      backend: TEST_ACP_BACKEND,
      confirm: true,
    });
  });

  it('reconciles reused empty managed conversations when preference is api or has different model/effort', async () => {
    saveManagedDefaultRuntime({ backend: 'api' });

    const fake = installFakeApi((name) => {
      if (name === 'conversations.runtimeCapabilities') {
        return { supported: true, backends: ['api', TEST_ACP_BACKEND], detail: '', choices: [] };
      }
      if (name === 'conversations.runtimeState') {
        return {
          id: 'c_reused',
          backend: TEST_ACP_BACKEND,
          phase: 'idle',
          generation: 4,
        };
      }
      return {};
    });

    const refreshManaged = vi.fn(async () => undefined);
    const switchedToApi = await applyManagedDefaultToConversation('c_reused', {
      flush: vi.fn(async () => undefined),
      hasMessages: () => false,
      isManaged: () => true,
      refreshManaged,
    });

    expect(switchedToApi).toBe(true);
    expect(fake.inputs('conversations.runtimeSwitch')).toEqual([
      {
        id: 'c_reused',
        backend: 'api',
        confirm: true,
        expectedGeneration: 4,
      },
    ]);
    expect(refreshManaged).toHaveBeenCalledWith('c_reused');

    resetFakeApi();
    saveManagedDefaultRuntime({
      backend: TEST_ACP_BACKEND,
      source: 'local',
      model: 'model-v2',
      effort: 'high',
    });

    const fake2 = installFakeApi((name) => {
      if (name === 'conversations.runtimeCapabilities') {
        return {
          supported: true,
          backends: ['api', TEST_ACP_BACKEND],
          detail: '',
          choices: [
            {
              id: TEST_ACP_BACKEND,
              available: true,
              status: 'ready',
              detail: '',
              login: 'unverified',
              requiresProject: true,
              degraded: [],
            },
          ],
        };
      }
      if (name === 'conversations.runtimeState') {
        return {
          id: 'c_reused',
          backend: TEST_ACP_BACKEND,
          source: 'local',
          model: 'model-v1',
          effort: 'low',
          phase: 'idle',
          generation: 5,
        };
      }
      return {};
    });

    const syncedModel = await applyManagedDefaultToConversation('c_reused', {
      flush: vi.fn(async () => undefined),
      hasMessages: () => false,
      isManaged: () => true,
      refreshManaged,
    });

    expect(syncedModel).toBe(true);
    expect(fake2.inputs('conversations.runtimeSwitch')).toEqual([
      {
        id: 'c_reused',
        backend: TEST_ACP_BACKEND,
        confirm: true,
        expectedGeneration: 5,
        source: 'local',
        model: 'model-v2',
        effort: 'high',
      },
    ]);
  });

  it('notifies subscribers when the default runtime is saved or cleared', () => {
    const seen: (string | null)[] = [];
    const off = subscribeManagedDefaultRuntime(() => {
      seen.push(getManagedDefaultRuntime()?.backend ?? null);
    });
    saveManagedDefaultRuntime({ backend: TEST_ACP_BACKEND });
    saveManagedDefaultRuntime({ backend: 'claude' });
    clearManagedDefaultRuntime();
    off();
    saveManagedDefaultRuntime({ backend: 'codex' });
    expect(seen).toEqual([TEST_ACP_BACKEND, 'claude', null]);
  });

  it('skips adoption when conversation already has messages', async () => {
    saveManagedDefaultRuntime({ backend: TEST_ACP_BACKEND, model: 'model-neon' });
    const fake = installFakeApi(() => ({}));
    const ok = await applyManagedDefaultToConversation('c_non_empty', {
      flush: vi.fn(async () => undefined),
      hasMessages: () => true,
      isManaged: () => false,
      refreshManaged: vi.fn(async () => undefined),
    });
    expect(ok).toBe(false);
    expect(fake.inputs('conversations.runtimeCapabilities')).toHaveLength(0);
  });

  it('never switches an existing managed conversation into or out of interactive-only antigravity', async () => {
    const setupFake = (activeBackend: string) =>
      installFakeApi((name) => {
        if (name === 'conversations.runtimeCapabilities') {
          return {
            supported: true,
            backends: ['api', 'claude', 'antigravity'],
            detail: '',
            choices: [
              {
                id: 'claude',
                available: true,
                status: 'ready',
                detail: '',
                login: 'unverified',
                requiresProject: true,
                degraded: [],
              },
              {
                id: 'antigravity',
                available: true,
                status: 'ready',
                detail: '',
                login: 'unverified',
                requiresProject: true,
                degraded: [],
              },
            ],
          };
        }
        if (name === 'conversations.runtimeState') {
          return {
            id: 'c_lock',
            backend: activeBackend,
            source: 'local',
            model: 'm1',
            phase: 'idle',
            generation: 2,
          };
        }
        return {};
      });

    saveManagedDefaultRuntime({ backend: 'antigravity', model: 'auto' });
    const fake1 = setupFake('claude');
    const switchedIn = await applyManagedDefaultToConversation('c_lock', {
      flush: vi.fn(async () => undefined),
      hasMessages: () => false,
      isManaged: () => true,
      refreshManaged: vi.fn(async () => undefined),
    });
    expect(switchedIn).toBe(false);
    expect(fake1.inputs('conversations.runtimeSwitch')).toHaveLength(0);

    saveManagedDefaultRuntime({ backend: 'claude', model: 'sonnet' });
    const fake2 = setupFake('antigravity');
    const switchedOut = await applyManagedDefaultToConversation('c_lock', {
      flush: vi.fn(async () => undefined),
      hasMessages: () => false,
      isManaged: () => true,
      refreshManaged: vi.fn(async () => undefined),
    });
    expect(switchedOut).toBe(false);
    expect(fake2.inputs('conversations.runtimeSwitch')).toHaveLength(0);
  });
});
