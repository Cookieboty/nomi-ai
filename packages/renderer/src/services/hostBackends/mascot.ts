/**
 * D5：把契约接到共享包的注入点上（只属于 D5，见 ../api.ts）。
 * 例：`setThemeBackend({ get: () => api.theme.get(), … })`。
 *
 * - avatar-runtime 的互动设置推给主进程的看板娘窗口控制器（`mascot.setInteractionConfig`）。
 */

import type { AppClient } from '@nomi-ai/ai-sdk-client';
import { setInteractionConfigBackend } from '@nomi-ai/avatar-runtime';

export function installMascotBackends(api: AppClient): void {
  setInteractionConfigBackend((cfg) => api.mascot.setInteractionConfig({ ...cfg }));
}
