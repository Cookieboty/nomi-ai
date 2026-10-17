/**
 * EXPERIMENTAL — Rive renderer for the Nomi mascot (docs/brand/rive-eval.md).
 * Off by default: the layered canvas rig stays the only shipped renderer. Opt in per machine with
 *   localStorage.setItem('nomi.experimental.rive', '1')   (then reload)
 * or per page with `?rive=1` (half-body) / `?rive=full` (full-body).
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
