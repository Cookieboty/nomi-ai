/** 主动日程客户端：契约 `sched.*`（docs/design/core-host-decoupling.md §12 P1b，原 `ai:sched:*`） */
import { t as tr } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import type { RepeatRule } from './desktopClient';
import { plainError } from './hostBackends/knowledge';

export type Frequency = 'low' | 'medium' | 'high';

export interface SchedSettings {
  quiet: { enabled: boolean; start: string; end: string };
  proactive: {
    enabled: boolean;
    frequency: Frequency;
    activeStart: string;
    activeEnd: string;
    skipIfChattedMin: number;
  };
}

export interface SchedTask {
  id: string;
  name: string;
  prompt: string;
  time: string;
  repeat: RepeatRule;
  enabled: boolean;
  template?: 'briefing';
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
}

export interface TaskResult {
  id: string;
  taskId: string;
  name: string;
  at: number;
  ok: boolean;
  text: string;
  catchUp?: boolean;
}

export interface SchedState {
  settings: SchedSettings;
  tasks: SchedTask[];
  running: string[];
  quietNow: boolean;
  deferred: number;
  proactive: { today: number; lastAt: number; gate: { ok: boolean; reason: string } };
}

export const BRIEFING_PROMPT = 'ui.chat-settings.write-me-a-briefing-for-today-start-with';

async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport()) throw new Error(tr('ui.chat-settings.scheduling-requires-the-desktop-app'));
  try {
    return (await run()) as T;
  } catch (err) {
    throw plainError(err);
  }
}
const on = (subscribe: () => () => void): (() => void) =>
  hasTransport() ? subscribe() : () => undefined;

export const schedClient = {
  available: () => hasTransport(),
  state: () => call<SchedState>(() => api.sched.state()),
  setSettings: (
    p: Partial<{ [K in keyof SchedSettings]: Partial<SchedSettings[K]> | SchedSettings[K] }>,
  ) => call<SchedSettings>(() => api.sched.setSettings(p)),
  upsertTask: (t: Partial<SchedTask>) => call<SchedTask>(() => api.sched.upsertTask(t)),
  toggleTask: (id: string, v: boolean) =>
    call<boolean>(() => api.sched.toggleTask({ id, enabled: v })),
  removeTask: (id: string) => call<boolean>(() => api.sched.removeTask({ id })),
  runTask: (id: string) => call<TaskResult>(() => api.sched.runTask({ id })),
  results: () => call<TaskResult[]>(() => api.sched.results()),
  clearResults: () => call<boolean>(() => api.sched.clearResults()),
  proactiveNow: () => call<string>(() => api.sched.proactiveNow()),
  activity: () => {
    if (hasTransport()) void call(() => api.sched.activity()).catch(() => undefined);
  },
  onChanged: (fn: () => void) => on(() => api.on('sched.changed', () => fn())),
  onResult: (fn: (r: TaskResult) => void) =>
    on(() => api.on('sched.result', (p) => fn(p as TaskResult))),
};
