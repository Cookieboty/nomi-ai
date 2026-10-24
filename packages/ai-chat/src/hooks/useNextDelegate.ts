/** `/cli 名字` 指定的「下一个需求交给谁」（发送后自动清除） */
import { useSyncExternalStore } from 'react';

import {
  getNextDelegate,
  subscribeNextDelegate,
  type DelegateCli,
} from '../services/delegateClient';

export function useNextDelegate(): DelegateCli | null {
  return useSyncExternalStore(subscribeNextDelegate, getNextDelegate, () => null);
}
