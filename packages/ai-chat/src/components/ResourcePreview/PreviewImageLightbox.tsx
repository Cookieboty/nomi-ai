import { Icon, ModalHostContext, t, useFocusTrap } from '@nomi-ai/ui';
import { ChevronLeft, ChevronRight, Download, Info, Minus, Plus, X } from 'lucide-react';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { isEditableTarget } from '../../utils/keyboard';
import { useImageViewport } from '../ImageLightbox/useImageViewport';

import styles from './PreviewImageLightbox.module.css';

export interface PreviewImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  actions?: React.ReactNode;
  details?: React.ReactNode;
  download?: React.ReactNode;
  index?: number;
  count?: number;
  onIndex?: (index: number) => void;
  pending?: boolean;
  error?: string;
  'data-testid'?: string;
}
/** Image-only full-window overlay; never resizes the conversation or document preview. */
export function PreviewImageLightbox({
  src,
  alt = '',
  onClose,
  onLoad,
  onError,
  actions,
  details,
  download,
  index = 0,
  count = 1,
  onIndex,
  pending,
  error,
  'data-testid': testId = 'preview-image-lightbox',
}: PreviewImageLightboxProps) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useFocusTrap(root, true, () => close.current());
  const [info, setInfo] = useState(false);
  const [failed, setFailed] = useState(false);
  const { stage, zoom, offset, changeZoom, reset, imageEvents } = useImageViewport(
    !pending && !error && !failed,
  );
  const pick = (next: number) => {
    if (next < 0 || next >= count || !onIndex) return;
    reset();
    setFailed(false);
    onIndex(next);
  };
  return createPortal(
    <ModalHostContext.Provider value={null}>
      <div
        ref={root}
        className={styles.overlay}
        role="dialog"
        aria-modal="true"
        aria-label={t('ui.usage-tools.view-full-image')}
        data-testid={testId}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            isEditableTarget(event.target)
          )
            return;
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            pick(index - 1);
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            pick(index + 1);
          }
        }}
      >
        <div className={styles.toolbar}>
          {actions}
          {details && (
            <button
              type="button"
              aria-expanded={info}
              aria-label={t('ui.media.details')}
              title={t('ui.media.details')}
              onClick={() => setInfo(!info)}
              data-testid="image-lightbox-info"
            >
              <Icon icon={Info} size={16} />
            </button>
          )}
          {download ??
            (src && (
              <a
                href={src}
                download
                target="_blank"
                rel="noreferrer noopener"
                aria-label={t('ui.knowledge-local.download')}
                title={t('ui.knowledge-local.download')}
                data-testid="image-lightbox-download"
              >
                <Icon icon={Download} size={16} />
              </a>
            ))}
          <button
            type="button"
            onClick={onClose}
            data-autofocus
            aria-label={t('ui.providers-schedule.close')}
            title={t('ui.providers-schedule.close')}
            data-testid="image-lightbox-close"
          >
            <Icon icon={X} size={16} />
          </button>
        </div>
        <div
          ref={stage}
          className={styles.stage}
          data-testid="image-lightbox-stage"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          {pending ? (
            <p role="status">{t('ui.session-workspace.preview-loading')}</p>
          ) : error || failed ? (
            <p role="alert">{error || t('ui.usage-tools.image-failed-to-load')}</p>
          ) : (
            <img
              key={src}
              src={src}
              alt={alt}
              draggable={false}
              referrerPolicy="no-referrer"
              className={styles.image}
              data-zoomed={zoom > 1 || offset.x !== 0 || offset.y !== 0 || undefined}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
              onLoad={onLoad}
              onError={(event) => {
                setFailed(true);
                onError?.(event);
              }}
              {...imageEvents}
            />
          )}
        </div>
        {count > 1 && (
          <>
            <button
              className={styles.previous}
              type="button"
              disabled={index === 0}
              onClick={() => pick(index - 1)}
              aria-label={t('ui.session-workspace.previous')}
              data-testid="image-lightbox-previous"
            >
              <Icon icon={ChevronLeft} size={18} />
            </button>
            <button
              className={styles.next}
              type="button"
              disabled={index === count - 1}
              onClick={() => pick(index + 1)}
              aria-label={t('ui.session-workspace.next')}
              data-testid="image-lightbox-next"
            >
              <Icon icon={ChevronRight} size={18} />
            </button>
          </>
        )}
        <div className={styles.zoom} data-testid="image-lightbox-zoom">
          <button
            type="button"
            disabled={zoom <= 0.25 || pending || !!error || failed}
            onClick={() => changeZoom(zoom - 0.25)}
            aria-label={t('ui.usage-tools.zoom-out')}
          >
            <Icon icon={Minus} size={16} />
          </button>
          <button
            type="button"
            onClick={reset}
            title={t('ui.media.fit-image')}
            data-testid="image-lightbox-reset"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            disabled={zoom >= 4 || pending || !!error || failed}
            onClick={() => changeZoom(zoom + 0.25)}
            aria-label={t('ui.usage-tools.zoom-in')}
          >
            <Icon icon={Plus} size={16} />
          </button>
          {count > 1 && (
            <span>
              {index + 1} / {count}
            </span>
          )}
        </div>
        {details && (
          <aside className={styles.details} hidden={!info} data-testid="image-lightbox-details">
            {details}
          </aside>
        )}
      </div>
    </ModalHostContext.Provider>,
    document.body,
  );
}
