/**
 * D2：把契约接到共享包的注入点上（只属于 D2，见 ../api.ts）。
 * `@nomi-ai/ui` 的主题与语言：主进程持久化、解析「跟随系统」并广播给所有窗口（`theme.*` / `locale.*`）。
 */

import type { AppClient } from '@nomi-ai/ai-sdk-client';
import { setLocaleBackend, setThemeBackend } from '@nomi-ai/ui';

export function installShellBackends(api: AppClient): void {
  setThemeBackend({
    get: () => api.theme.get(),
    set: (pref) => api.theme.set({ pref }),
    onChanged: (fn) => api.on('theme.changed', fn),
  });
  setLocaleBackend({
    get: () => api.locale.get(),
    set: (pref) => api.locale.set({ pref }),
    onChanged: (fn) => api.on('locale.changed', fn),
  });
}
