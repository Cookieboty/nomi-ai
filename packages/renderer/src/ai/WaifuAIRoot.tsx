import { AIProvider } from '@nomi-ai/ai-sdk-client/react';
import React, { useMemo } from 'react';
import type { FC, PropsWithChildren } from 'react';

import WaifuLipSyncBridge from './WaifuLipSyncBridge';

import { hasTransport } from '@/services/api';

const WaifuAIRoot: FC<PropsWithChildren> = ({ children }) => {
  const ready = useMemo(() => hasTransport(), []);

  if (!ready) {
    return <>{children}</>;
  }

  return (
    <AIProvider>
      <WaifuLipSyncBridge />
      {children}
    </AIProvider>
  );
};

export default WaifuAIRoot;
