/**
 * SessionFacade —— 会话 CRUD 与派生。
 *
 * P5 阶段没有 插件宿主 session store 可注入（P6 才落地），本 Facade 采用**内存版占位实现**，
 * 与 插件宿主 runtime 接入时替换为 `ctx.inject(SessionStoreKey)`。
 */

import type { Session } from '../types/Session';

export interface CreateSessionInput {
  title?: string;
  agentPreset?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface SessionFacade {
  list(): Session[];
  get(id: string): Session | undefined;
  create(input?: CreateSessionInput): Session;
  fork(id: string, overrides?: Partial<CreateSessionInput>): Session;
  rename(id: string, title: string): Session;
  delete(id: string): boolean;
}

export function createSessionFacade(): SessionFacade {
  const map = new Map<string, Session>();
  const now = () => Date.now();

  const upsert = (s: Session): Session => {
    map.set(s.id, s);
    return { ...s };
  };

  return {
    list() {
      return [...map.values()].map((s) => ({ ...s }));
    },
    get(id) {
      const s = map.get(id);
      return s ? { ...s } : undefined;
    },
    create(input) {
      const s: Session = {
        id: `sess_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title: input?.title ?? 'New Session',
        createdAt: now(),
        updatedAt: now(),
        agentPreset: input?.agentPreset,
        meta: input?.meta,
      };
      return upsert(s);
    },
    fork(id, overrides) {
      const src = map.get(id);
      if (!src) throw new Error(`session '${id}' not found`);
      const s: Session = {
        ...src,
        id: `sess_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title: overrides?.title ?? `${src.title} (copy)`,
        createdAt: now(),
        updatedAt: now(),
        agentPreset: overrides?.agentPreset ?? src.agentPreset,
        meta: overrides?.meta ?? src.meta,
      };
      return upsert(s);
    },
    rename(id, title) {
      const src = map.get(id);
      if (!src) throw new Error(`session '${id}' not found`);
      const s: Session = { ...src, title, updatedAt: now() };
      return upsert(s);
    },
    delete(id) {
      return map.delete(id);
    },
  };
}
