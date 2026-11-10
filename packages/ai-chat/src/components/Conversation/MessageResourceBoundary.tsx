import React from 'react';

import { ResourceContext } from '../../contexts/ResourceContext';

/** Render-only adapter. Nomi's persisted delegate result is plain report text, not a
 * document with a file base. Keep upstream link behavior here rather than borrowing
 * the parent conversation's workspace. Cards supply their own explicit child scope.
 * This must not alter messages, delegate events, task state or the save protocol. */
export const MessageResourceBoundary: React.FC<{
  id: string;
  origin?: string;
  children: React.ReactNode;
}> = ({ id, origin, children }) =>
  origin === 'background' && id.startsWith('delegate-') ? (
    <ResourceContext.Provider value={null}>{children}</ResourceContext.Provider>
  ) : (
    <>{children}</>
  );
