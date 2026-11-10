import React, { useMemo } from 'react';

import { ResourceScopeProvider, type ResourceContextValue } from '../../contexts/ResourceContext';

import { captureDocumentAnchor, type DocumentAnchor } from './documentAnchor';
import type { DocumentNavigation } from './documentNavigation';
import { DocumentOutline } from './DocumentOutline';
import { EditableMarkdown } from './EditableMarkdown';
import type { MarkdownEditHistory } from './markdownEditHistory';
import { PreviewDocumentContext } from './PreviewDocumentContext';
import { PreviewMarkdown } from './PreviewMarkdown';
import styles from './ResourcePreview.module.css';
import { useDocumentScrollspy } from './useDocumentScrollspy';

export const MarkdownDocument: React.FC<{
  text: string;
  context: ResourceContextValue;
  documentDir?: string;
  documentPath?: string;
  outline: boolean;
  showOutlineControls?: boolean;
  outlineWidth?: number;
  onOutlineWidthChange?: (width: number) => void;
  onOutlineChange: (v: boolean) => void;
  scrollTop: number;
  anchor?: DocumentAnchor;
  onScroll: (top: number, anchor?: DocumentAnchor) => void;
  navigation?: DocumentNavigation;
  onNavigated?: (top: number) => void;
  editable?: boolean;
  onChange?: (text: string) => void;
  editHistory?: MarkdownEditHistory;
}> = ({
  text,
  context,
  documentDir,
  documentPath,
  outline,
  showOutlineControls = true,
  outlineWidth,
  onOutlineWidthChange,
  onOutlineChange,
  scrollTop,
  anchor,
  onScroll,
  navigation,
  onNavigated,
  editable = false,
  onChange,
  editHistory,
}) => {
  const { root, headings, active, pick, syncScroll } = useDocumentScrollspy(
    text,
    editable,
    scrollTop,
    navigation,
    onNavigated,
    anchor,
  );
  const value = useMemo(() => context, [context]);
  return (
    <div className={styles.documentLayout}>
      {showOutlineControls && (
        <DocumentOutline
          headings={headings}
          active={active}
          open={outline}
          onOpen={onOutlineChange}
          width={outlineWidth}
          onWidth={onOutlineWidthChange}
          onPick={pick}
        />
      )}
      <div
        ref={root}
        className={styles.documentBody}
        data-resource-document
        data-preview-find-content
        data-testid="preview-markdown"
        onScroll={(e) => {
          const el = e.currentTarget;
          onScroll(el.scrollTop, captureDocumentAnchor(el));
          syncScroll();
        }}
      >
        <ResourceScopeProvider value={value}>
          <PreviewDocumentContext.Provider value={{ directory: documentDir, path: documentPath }}>
            {editable && onChange ? (
              <EditableMarkdown
                text={text}
                editable
                onChange={onChange}
                editHistory={editHistory}
              />
            ) : (
              <PreviewMarkdown text={text} className={styles.markdown} />
            )}
          </PreviewDocumentContext.Provider>
        </ResourceScopeProvider>
      </div>
    </div>
  );
};
