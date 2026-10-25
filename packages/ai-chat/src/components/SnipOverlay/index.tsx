/**
 * 截图框选遮罩（对话页 #snip 路由，在全屏无边框窗口里运行）。
 * 拖拽框选 → Enter / 「提问」确认；F / 「整屏」；Esc / 右键取消。
 */
import { t } from '@nomi-ai/ui';
import { Button } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { screenClient } from '../../services/screenClient';

import styles from './index.module.css';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const norm = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

export const SnipOverlay: React.FC = () => {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    screenClient
      .snipSource()
      .then((s) =>
        s ? setSrc(s.url) : setErr(t('ui.chat-settings.screenshot-expired-please-take-it-again')),
      )
      .catch((e: Error) => setErr(e.message));
  }, []);

  const view = () => ({ width: window.innerWidth, height: window.innerHeight });
  const done = useCallback((r: Rect | null) => void screenClient.snipDone(r, view()), []);
  const full = useCallback(() => done({ x: 0, y: 0, ...view() }), [done]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter' && sel && sel.width > 4) done(sel);
      else if (e.key.toLowerCase() === 'f') full();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, done, full]);

  const ok = !!sel && sel.width > 4 && sel.height > 4;
  // 工具条放在选区下方，空间不够时放上方
  const barTop = sel
    ? sel.y + sel.height + 52 > window.innerHeight
      ? sel.y - 48
      : sel.y + sel.height + 8
    : 0;

  return (
    <div
      className={styles.root}
      data-testid="snip-overlay"
      onContextMenu={(e) => {
        e.preventDefault();
        done(null);
      }}
      onMouseDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
        start.current = { x: e.clientX, y: e.clientY };
        setDragging(true);
        setSel({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
      }}
      onMouseMove={(e) => {
        if (dragging && start.current) setSel(norm(start.current, { x: e.clientX, y: e.clientY }));
      }}
      onMouseUp={() => setDragging(false)}
    >
      {src && <img className={styles.shot} src={src} alt="" draggable={false} />}
      {!sel && <div className={styles.dim} />}
      {sel && (
        <div
          className={styles.sel}
          style={{ left: sel.x, top: sel.y, width: sel.width, height: sel.height }}
          data-testid="snip-selection"
        >
          <span className={styles.size}>
            {Math.round(sel.width)} × {Math.round(sel.height)}
          </span>
        </div>
      )}
      {!dragging && (
        <div
          className={styles.bar}
          style={
            ok
              ? { left: Math.max(8, Math.min(sel!.x, window.innerWidth - 340)), top: barTop }
              : { left: '50%', top: 24, transform: 'translateX(-50%)' }
          }
        >
          {err ? (
            <span className={styles.tip}>{err}</span>
          ) : (
            <span className={styles.tip}>
              {ok
                ? t('ui.chat-settings.selected-ask-something')
                : t('ui.chat-settings.drag-to-select-the-area-to-ask-about')}
            </span>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={!ok}
            onClick={() => done(sel)}
            data-testid="snip-confirm"
          >
            {t('ui.chat-settings.ask')}
          </Button>
          <Button size="sm" onClick={full} data-testid="snip-full">
            {t('ui.chat-settings.full-screen-f')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => done(null)} data-testid="snip-cancel">
            {t('ui.chat-settings.cancel-esc')}
          </Button>
        </div>
      )}
    </div>
  );
};
