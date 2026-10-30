import { AIProvider } from '@nomi-ai/ai-sdk-client/react';
import React, { useMemo } from 'react';
import type { FC, PropsWithChildren } from 'react';

import CompanionLipSyncBridge from './CompanionLipSyncBridge';

import { hasTransport } from '@/services/api';

const CompanionAIRoot: FC<PropsWithChildren> = ({ children }) => {
  const ready = useMemo(() => hasTransport(), []);

  if (!ready) {
    return <>{children}</>;
  }

  return (
    <AIProvider>
      <CompanionLipSyncBridge />
      {children}
    </AIProvider>
  );
};

export default CompanionAIRoot;
