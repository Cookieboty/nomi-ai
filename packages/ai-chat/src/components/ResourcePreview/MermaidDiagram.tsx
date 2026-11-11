import { Icon, t, useLocale } from '@nomi-ai/ui';
import { Maximize2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { MermaidLightbox } from '../ImageLightbox/MermaidLightbox';

import styles from './MermaidDiagram.module.css';
import { diagramTheme, renderDiagram } from './mermaidRenderer';

/** A diagram is supplementary; syntax errors must never hide the document or its original source. */
export function MermaidDiagram({ code }: { code: string }) {
  useLocale();
  const [theme, setTheme] = useState(() => JSON.stringify(diagramTheme()));
  const [result, setResult] = useState<{ key: string; svg?: string; failed?: boolean } | null>(
    null,
  );
  const [source, setSource] = useState(false);

  const svgHost = useRef<HTMLDivElement>(null);
  const key = `${code}\u0000${theme}`;
  const [preview, setPreview] = useState({ key, open: false });
  if (preview.key !== key) setPreview({ key, open: false });
  useEffect(() => {
    const update = () => setTheme(JSON.stringify(diagramTheme()));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-chat-bg'],
    });
    window.addEventListener('cd:theme-changed', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('cd:theme-changed', update);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void renderDiagram(code, JSON.parse(theme), () => cancelled).then(
      (svg) => {
        if (!cancelled) setResult({ key, svg });
      },
      () => {
        if (!cancelled) setResult({ key, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, theme, key]);
  useEffect(() => {
    if (!svgHost.current) return;
    const svg = svgHost.current.querySelector('svg');
    if (!svg) return;
    const width = Number(svg.getAttribute('viewBox')?.split(/\s+/)[2]);
    if (Number.isFinite(width) && width > 0) svg.style.setProperty('--mermaid-width', `${width}px`);
    svg.style.maxWidth = 'none';
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('ui.session-workspace.mermaid-diagram'));
  }, [result, source]);
  const current = result?.key === key ? result : null;
  return (
    <section className={styles.diagram} data-testid="mermaid-diagram">
      <div className={styles.toolbar}>
        <span>Mermaid</span>
        <div className={styles.actions}>
          {!source && current?.svg && (
            <button
              type="button"
              onClick={() => setPreview({ key, open: true })}
              aria-label={t('ui.usage-tools.view-full-image')}
              title={t('ui.usage-tools.view-full-image')}
            >
              <Icon icon={Maximize2} size={16} />
            </button>
          )}
          <button type="button" aria-pressed={source} onClick={() => setSource(!source)}>
            {t(source ? 'ui.foundation.preview' : 'ui.session-workspace.preview-source')}
          </button>
        </div>
      </div>
      {current?.failed && (
        <p role="status" className={styles.notice}>
          {t('ui.session-workspace.mermaid-error')}
        </p>
      )}
      {!current && (
        <p role="status" className={styles.notice}>
          {t('ui.session-workspace.mermaid-loading')}
        </p>
      )}
      {source || current?.failed ? (
        <pre className={styles.source} data-testid="mermaid-source">
          <code>{code}</code>
        </pre>
      ) : current?.svg ? (
        <div
          ref={svgHost}
          className={styles.canvas}
          data-testid="mermaid-canvas"
          role="button"
          tabIndex={0}
          aria-label={t('ui.usage-tools.view-full-image')}
          onClick={() => setPreview({ key, open: true })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              setPreview({ key, open: true });
            }
          }}
          dangerouslySetInnerHTML={{ __html: current.svg }}
        />
      ) : null}
      {preview.key === key && preview.open && current?.svg && (
        <MermaidLightbox
          svg={current.svg}
          background={JSON.parse(theme).background}
          onClose={() => setPreview({ key, open: false })}
        />
      )}
    </section>
  );
}
