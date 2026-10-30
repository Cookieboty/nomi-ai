/**
 * fakeSeams —— 一个 provider / tool / userProfile 的极简实现，专供 P5 集成测试使用。
 */

import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  LLMRegistry,
  ProfilePatch,
  ToolDefinition,
  ToolRegistry,
  UserProfile,
  UserProfileEvent,
  UserProfileService,
} from '@nomi-ai/bundle-ig-base';
import { makeDefaultUserProfile } from '@nomi-ai/bundle-ig-base';

export interface FakeLLM extends LLMProvider {
  chatCalls: ChatRequest[];
  streamCalls: ChatRequest[];
  aborted: string[];
}

export function createFakeLLM(id = 'fake'): FakeLLM {
  const chatCalls: ChatRequest[] = [];
  const streamCalls: ChatRequest[] = [];
  const aborted: string[] = [];

  return {
    id,
    chatCalls,
    streamCalls,
    aborted,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      chatCalls.push(req);
      return {
        reqId: req.reqId,
        provider: id,
        model: req.model,
        content: 'ok',
        finishReason: 'stop',
      };
    },
    stream(req: ChatRequest): AsyncIterable<ChatChunk> {
      streamCalls.push(req);
      return (async function* () {
        yield { type: 'delta', content: 'hel' };
        yield { type: 'delta', content: 'lo' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    },
    abort(reqId: string): void {
      aborted.push(reqId);
    },
  };
}

export function createFakeLLMRegistry(...providers: LLMProvider[]): LLMRegistry {
  const map = new Map<string, LLMProvider>();
  for (const p of providers) map.set(p.id, p);
  return {
    register: (p) => {
      map.set(p.id, p);
    },
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
}

export function createFakeToolRegistry(): ToolRegistry {
  const map = new Map<string, ToolDefinition>();
  return {
    register: <TIn, TOut>(tool: ToolDefinition<TIn, TOut>) => {
      map.set(tool.name, tool as unknown as ToolDefinition);
    },
    get: (n) => map.get(n),
    list: () => [...map.values()],
  };
}

export function createFakeProfileService(seed?: Partial<UserProfile>): UserProfileService {
  let profile: UserProfile = { ...makeDefaultUserProfile(1_700_000_000_000), ...seed };
  const subs = new Set<(p: UserProfile) => void>();
  const notify = () => subs.forEach((f) => f(profile));

  const svc: UserProfileService = {
    get: () => structuredClone(profile),
    getPath: <T>(path: string) => {
      const segs = path.split('.');
      let cur: unknown = profile;
      for (const s of segs) {
        if (cur && typeof cur === 'object' && s in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[s];
        } else return undefined;
      }
      return cur as T;
    },
    async set(patch: ProfilePatch) {
      profile = deepMerge(profile, patch.patch) as UserProfile;
      profile.updatedAt = Date.now();
      notify();
      return structuredClone(profile);
    },
    async reset() {
      profile = makeDefaultUserProfile();
      notify();
      return structuredClone(profile);
    },
    subscribe(_evt: UserProfileEvent, fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    async export() {
      return structuredClone(profile);
    },
    async import(data: unknown) {
      profile = data as UserProfile;
      notify();
      return structuredClone(profile);
    },
  };
  return svc;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}
