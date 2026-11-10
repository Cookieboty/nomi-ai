import { Select, t } from '@nomi-ai/ui';
import React from 'react';

import { codeLanguages, syntaxName } from './codeSyntax';

const languages = [...codeLanguages].sort((a, b) => syntaxName(a).localeCompare(syntaxName(b)));

/** Manual syntax selection belongs to this file view, never to the file contents. */
export function CodeSyntaxSelect({
  detected,
  value,
  onChange,
}: {
  detected: string;
  value?: string;
  onChange: (language: string) => void;
}) {
  const name = (language: string) =>
    language === 'text' ? t(syntaxName('text')) : syntaxName(language);
  return (
    <Select
      size="sm"
      variant="chip"
      style={{ width: 'auto', flexShrink: 0, maxWidth: '12rem' }}
      value={value ?? 'auto'}
      aria-label={t('ui.session-workspace.preview-syntax')}
      data-testid="preview-syntax-select"
      searchable
      menuMinWidth={220}
      onChange={(event) => onChange(event.target.value)}
      options={[
        { value: 'auto', label: t('ui.session-workspace.preview-syntax-auto', name(detected)) },
        { value: 'text', label: name('text') },
        ...languages.map((language) => ({ value: language, label: name(language) })),
      ]}
      renderValue={(option) => name(option.value === 'auto' ? detected : option.value)}
    />
  );
}
