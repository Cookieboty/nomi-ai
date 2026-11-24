import React from 'react';

import { useManagedRuntime } from '../../contexts/ManagedRuntimeContext';

import { ManagedRuntimePanel, type ManagedRuntimeView } from './panel';

export { ManagedRuntimePanel, type ManagedRuntimeView };

export const ManagedRuntimeDock: React.FC = () => {
  const managed = useManagedRuntime();
  if (!managed?.view) return null;

  return (
    <ManagedRuntimePanel
      view={managed.view}
      onResolve={(decision = 'new-native') => void managed.resolve(decision)}
      onApprove={(approvalId, allow) => void managed.approve(approvalId, allow)}
      onDismissError={managed.clearError}
    />
  );
};
