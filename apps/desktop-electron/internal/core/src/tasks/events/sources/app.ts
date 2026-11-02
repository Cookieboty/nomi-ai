/**
 * `app` 事件源（§6.2）：应用内部事件，直接推送，不经网络。
 * - `cli.finished`：编程助手会话的一轮结束（任务自己开的标签不算，免得任务触发自己）；
 * - `knowledge.updated`：知识库有变化。
 * Go 版：apps/desktop-go/internal/core/tasks/events/app.go。
 */
import { t } from '../../../i18n';
import type { EventSource } from '../types';

export const APP_EVENTS = ['cli.finished', 'knowledge.updated'] as const;
export type AppEventKind = (typeof APP_EVENTS)[number];

export interface AppFilter {
  event: AppEventKind;
  /** cli.finished：只看这个编程助手 */
  backend?: string;
}

export interface AppBus {
  onCliFinished(
    fn: (e: {
      tabId: string;
      title: string;
      backend: string;
      ok: boolean;
      taskTab: boolean;
    }) => void,
  ): () => void;
  onKnowledgeChanged(fn: () => void): () => void;
}

export function createAppSource(bus: AppBus, deps: { now?: () => number } = {}): EventSource {
  const now = deps.now ?? Date.now;
  let seq = 0;
  return {
    id: 'app',
    minIntervalMs: 0,
    validate(filter) {
      const f = filter as AppFilter | null;
      if (!f || !APP_EVENTS.includes(f.event)) return 'bad event';
      return null;
    },
    subscribe(filter, _task, emit) {
      const f = filter as AppFilter;
      if (f.event === 'cli.finished')
        return bus.onCliFinished((e) => {
          if (e.taskTab || (f.backend && e.backend !== f.backend)) return;
          const at = now();
          emit({
            key: `app:cli:${e.tabId}:${at}:${++seq}`,
            occurredAt: at,
            summary: t('electron.common.task-event-cli-finished', e.title, e.backend),
            payload: { tabId: e.tabId, title: e.title, backend: e.backend, ok: e.ok },
          });
        });
      return bus.onKnowledgeChanged(() => {
        const at = now();
        emit({
          key: `app:kb:${at}:${++seq}`,
          occurredAt: at,
          summary: t('electron.common.task-event-kb-updated'),
          payload: { event: 'knowledge.updated' },
        });
      });
    },
  };
}
