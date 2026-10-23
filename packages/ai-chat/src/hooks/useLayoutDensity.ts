/**
 * 工作台界面模式（精简 / 全量）偏好（React 订阅），见 services/chatPrefs 的 LayoutDensity。
 */
import { useCallback, useSyncExternalStore } from 'react';

import {
  getLayoutDensity,
  setLayoutDensity as persistLayoutDensity,
  subscribeLayoutDensity,
  type LayoutDensity,
} from '../services/chatPrefs';

export function useLayoutDensity(): {
  density: LayoutDensity;
  isCompact: boolean;
  setDensity: (d: LayoutDensity) => void;
} {
  const density = useSyncExternalStore(
    subscribeLayoutDensity,
    getLayoutDensity,
    () => 'full' as LayoutDensity,
  );
  const setDensity = useCallback((d: LayoutDensity) => persistLayoutDensity(d), []);
  return { density, isCompact: density === 'compact', setDensity };
}
