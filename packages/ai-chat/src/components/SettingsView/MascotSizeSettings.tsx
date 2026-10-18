/**
 * 设置 → 通用：看板娘大小（滑块 + 重置）。
 * 主进程 mascot/MascotWindowController.ts（mascot:scale-*）负责夹紧到当前屏幕、调整窗口并保持
 * 脚底中心不动、持久化；看板娘本体上的 Ctrl/⌘+滚轮、右键菜单、工具栏「更多」是另外几个入口，
 * 它们改动后会广播到这里，滑块同步。
 */
import type { MascotScaleState } from '@nomi-ai/types';
import { Button, t } from '@nomi-ai/ui';
import { Minus, Plus } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import styles from './index.module.css';

interface MascotApi {
  scaleGet: () => Promise<MascotScaleState>;
  scaleSet: (scale: number) => Promise<MascotScaleState>;
  scaleReset: () => Promise<MascotScaleState>;
  onScale: (cb: (s: MascotScaleState) => void) => () => void;
}

function api(): MascotApi | null {
  const w = window as unknown as { electronAPI?: { mascot?: MascotApi } };
  return w.electronAPI?.mascot ?? null;
}

const pct = (v: number) => Math.round(v * 100);

export const MascotSizeSettings: React.FC = () => {
  const [state, setState] = useState<MascotScaleState | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const a = api();
    if (!a) return undefined;
    const adopt = (s: MascotScaleState) => {
      setState(s);
      // 拖动滑块时不被回传的旧值拉回去；松手后以主进程为准
      if (!dragging.current) setValue(s.scale);
    };
    void a.scaleGet().then(adopt);
    return a.onScale(adopt);
  }, []);

  const a = api();
  if (!a) return null;
  const s = state;
  const shown = value ?? s?.scale ?? 0.5;
  const set = (v: number) => {
    setValue(v);
    void a.scaleSet(v).then((r) => {
      setState(r);
      if (!dragging.current) setValue(r.scale);
    });
  };
  const release = () => {
    dragging.current = false;
    if (state) setValue(state.scale);
  };

  return (
    <section className={styles.block} data-testid="settings-mascot-size">
      <h2 className={styles.h2}>{t('看板娘大小')}</h2>
      <div className={styles.sizeRow}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('缩小')}
          data-testid="mascot-size-minus"
          disabled={!s || shown <= s.min + 1e-6}
          onClick={() => s && set(Math.max(s.min, Math.round((shown - s.step) * 100) / 100))}
        >
          <Minus size={16} strokeWidth={1.75} aria-hidden />
        </Button>
        <input
          type="range"
          className={styles.range}
          min={s?.min ?? 0.3}
          max={s?.max ?? 1.5}
          step={0.01}
          value={shown}
          disabled={!s}
          aria-label={t('看板娘大小')}
          aria-valuetext={`${pct(shown)}%`}
          data-testid="mascot-size-slider"
          onPointerDown={() => {
            dragging.current = true;
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onBlur={release}
          onChange={(e) => set(Number(e.target.value))}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('放大')}
          data-testid="mascot-size-plus"
          disabled={!s || shown >= s.max - 1e-6}
          onClick={() => s && set(Math.min(s.max, Math.round((shown + s.step) * 100) / 100))}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
        </Button>
        <span className={styles.sizeValue} data-testid="mascot-size-value">
          {pct(shown)}%
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="mascot-size-reset"
          disabled={!s || Math.abs(shown - s.default) < 1e-6}
          onClick={() =>
            void a.scaleReset().then((r) => {
              setState(r);
              setValue(r.scale);
            })
          }
        >
          {t('重置为默认')}
        </Button>
      </div>
      <p className={styles.muted}>
        {t('也可以在看板娘身上按住 Ctrl（macOS 为 ⌘）并滚动滚轮，或右键选择放大 / 缩小。')}
        {s && s.max < s.hardMax - 1e-6 && (
          <>
            {' '}
            <span data-testid="mascot-size-cap">
              {t('当前屏幕最大 {0}%').replace('{0}', String(pct(s.max)))}
            </span>
          </>
        )}
      </p>
    </section>
  );
};
