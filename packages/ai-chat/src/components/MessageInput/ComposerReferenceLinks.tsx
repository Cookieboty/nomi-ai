import { Icon, t } from '@nomi-ai/ui';
import { X } from 'lucide-react';
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
          <a
            href={reference.href}
            title={reference.href}
            onClick={(event) => {
              event.preventDefault();
              context?.open(reference.href, context.scope);
            }}
          >
            {reference.label}
          </a>
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
