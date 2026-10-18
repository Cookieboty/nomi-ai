/**
 * Legacy Rive rollout flag retained for callers and tests that still need to detect
 * an explicit Rive URL or stored preference. MascotHost now uses Rive by default.
 */
export const RIVE_FLAG_KEY = 'nomi.experimental.rive';

export function isRiveExperimentEnabled(
  search: string = typeof location === 'undefined' ? '' : location.search,
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
): boolean {
  try {
    const rive = new URLSearchParams(search).get('rive');
    if (rive === '1' || rive === 'full') return true;
    return storage?.getItem(RIVE_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}
