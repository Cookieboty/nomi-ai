/** Surface-neutral resource-opening interface; no rendering or lifecycle ownership. */
import React, { createContext, useContext } from 'react';

export interface ResourceScope {
  id: string;
  cwd?: string | null;
  source?: string;
  /** Known workspace candidates after a delegated worktree was removed. Kernel validates each. */
  fallbackCwds?: string[];
}
export interface ResourceImageInfo {
  origin: 'assistant' | 'user' | 'document';
  kind?: 'image';
  prompt?: string;
  model?: string;
  aspect?: string;
  createdAt?: number;
  source?: string;
  editedFrom?: string;
  references?: string[];
}
/** Identity of a resource request, independent of any preview UI. */
export interface ResourceEntry {
  key: string;
  href: string;
  scope: ResourceScope;
  image?: ResourceImageInfo;
}
export interface ResourceContextValue {
  scope: ResourceScope;
  open: (href: string, scope: ResourceScope, image?: ResourceImageInfo) => void;
}
export const ResourceContext = createContext<ResourceContextValue | null>(null);
export const useResourceContext = () => useContext(ResourceContext);
export const ResourceScopeProvider: React.FC<{
  value: ResourceContextValue;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <ResourceContext.Provider value={value}>{children}</ResourceContext.Provider>
);
