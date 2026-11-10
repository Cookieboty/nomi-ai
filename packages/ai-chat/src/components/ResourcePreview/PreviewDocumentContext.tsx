import { createContext, useContext } from 'react';

/** Metadata for resolving Markdown links and images within one opened document. */
export interface PreviewDocumentLocation {
  directory?: string;
  path?: string;
}

export const PreviewDocumentContext = createContext<PreviewDocumentLocation>({});
export const usePreviewDocumentLocation = () => useContext(PreviewDocumentContext);
