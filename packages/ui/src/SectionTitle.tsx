import React from 'react';

import { cx } from './cx';

export interface SectionTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** Heading level used by the page outline. */
  level?: 2 | 3 | 4;
}

/** Shared section heading with one semantic and visual contract across windows. */
export function SectionTitle({ level = 3, className, ...rest }: SectionTitleProps) {
  const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
  return <Tag className={cx('cd-section-title', className)} {...rest} />;
}
