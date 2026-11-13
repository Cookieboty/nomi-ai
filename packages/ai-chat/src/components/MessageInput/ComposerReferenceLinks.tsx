import { Icon, t } from '@nomi-ai/ui';
import { Quote, X } from 'lucide-react';
import React from 'react';

import { useResourceContext } from '../../contexts/ResourceContext';

import styles from './ComposerReferenceLinks.module.css';
import type { useReferenceDraft } from './useReferenceDraft';

export function ComposerReferenceLinks({ draft }: { draft: ReturnType<typeof useReferenceDraft> }) {
  const context = useResourceContext();
  if (!draft.references.length) return null;
  return (
    <div className={styles.references} data-composer-references>
      {draft.references.map((reference) => (
        <span className={styles.reference} key={reference.href}>
          {reference.quote ? (
            <span
              className={styles.quote}
              data-testid="composer-quote-chip"
              title={
                reference.quote.source
                  ? `${reference.quote.source}\n${reference.quote.text}`
                  : reference.quote.text
              }
            >
              <Icon icon={Quote} size={12} />
              {reference.label}
            </span>
          ) : (
            <a
              href={reference.href}
              onClick={(event) => {
                event.preventDefault();
                context?.open(reference.href, context.scope);
              }}
            >
              {reference.label}
            </a>
          )}
          <button
            type="button"
            aria-label={t('ui.session-workspace.preview-remove-reference', reference.label)}
            onClick={() => draft.remove(reference.href)}
          >
            <Icon icon={X} size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
