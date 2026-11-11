import { t, useLocale } from '@nomi-ai/ui';
import React, { useMemo } from 'react';

import { ImageLightbox } from './ImageLightbox';

/** Receives sanitized SVG from either Markdown renderer; keeps diagrams vector-sharp on zoom. */
export function MermaidLightbox({
  svg,
  background,
  onClose,
}: {
  svg: string;
  background: string;
  onClose: () => void;
}) {
  useLocale();
  const src = useMemo(() => {
    const image = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('svg');
    if (!image) {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
    const [, , width, height] = (image.getAttribute('viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    // Mermaid often emits width="100%" and a max-width; standalone images need intrinsic dimensions.
    if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) {
      image.setAttribute('width', String(width));
      image.setAttribute('height', String(height));
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
    }
    image.style.maxWidth = 'none';
    image.style.backgroundColor = background;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(image))}`;
  }, [svg, background]);
  return (
    <ImageLightbox src={src} alt={t('ui.session-workspace.mermaid-diagram')} onClose={onClose} />
  );
}
