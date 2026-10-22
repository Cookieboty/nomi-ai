/** CLI 端是否接受用户附图（与主进程 promptImages.imageSupportFor 对齐） */
import type { HarnessBackend } from '../services/harnessClient';

export type CliImageCapability = 'full' | 'none';

export function cliImageSupport(backend: HarnessBackend | undefined | null): CliImageCapability {
  if (!backend || backend === 'nomi') return 'full';
  if (backend === 'dsh') return 'none';
  return 'full';
}
