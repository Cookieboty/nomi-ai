import { useTTSLipSync } from '@nomi-ai/ai-sdk-client/react';
import { useEffect } from 'react';
import type { FC } from 'react';

import { lipSyncStore } from './lipSyncStore';

const CompanionLipSyncBridge: FC = () => {
  const rms = useTTSLipSync();

  useEffect(() => {
    lipSyncStore.set(rms);
  }, [rms]);

  useEffect(() => {
    return () => {
      lipSyncStore.reset();
    };
  }, []);

  return null;
};

export default CompanionLipSyncBridge;
