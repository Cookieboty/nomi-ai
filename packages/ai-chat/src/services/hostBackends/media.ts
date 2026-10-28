/**
 * D1：把契约接到共享包的注入点上（只属于 D1，见 ../api.ts）。
 * 例：`setThemeBackend({ get: () => api.theme.get(), … })`。没有要注入的就保持空函数。
 */

import type { AppClient } from '@nomi-ai/ai-sdk-client';

export function installMediaBackends(_api: AppClient): void {}
