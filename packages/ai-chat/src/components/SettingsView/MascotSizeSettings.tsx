/**
 * 设置 → 通用：Nomi 大小（滑块 + 重置）。
 * 主进程 mascot/MascotWindowController.ts（mascot:scale-*）负责夹紧到当前屏幕、调整窗口并保持
 * 脚底中心不动、持久化；看板娘本体上的 Ctrl/⌘+滚轮、右键菜单、工具栏「更多」是另外几个入口，
 * 它们改动后会广播到这里，滑块同步。
 */
import type { MascotScaleState } from '@nomi-ai/types';
import { Button, SettingRow, Slider, t } from '@nomi-ai/ui';
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

/** 一行设置（放在「桌面 Nomi」分组里）；看板娘隐藏时整行置灰 */
export const MascotSizeSettings: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
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

  const off = !s || disabled;

  return (
    <SettingRow
      data-testid="settings-mascot-size"
      title={t('ui.usage-tools.nomi-size')}
      description={
        <>
          {disabled
            ? t('ui.chat-settings.nomi-is-hidden-show-it-to-adjust-its')
            : t('ui.usage-tools.you-can-also-hold-ctrl-on-macos-and')}
          {s && s.max < s.hardMax - 1e-6 && (
            <>
              {' '}
              <span data-testid="mascot-size-cap">
                {t('ui.usage-tools.largest-on-this-display').replace('{0}', String(pct(s.max)))}
              </span>
            </>
          )}
        </>
      }
    >
      <div className={styles.sizeRow}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('ui.usage-tools.zoom-out')}
          data-testid="mascot-size-minus"
          disabled={off || shown <= s.min + 1e-6}
          onClick={() => s && set(Math.max(s.min, Math.round((shown - s.step) * 100) / 100))}
        >
          <Minus size={16} strokeWidth={1.75} aria-hidden />
        </Button>
        <Slider
          className={styles.range}
          min={s?.min ?? 0.3}
          max={s?.max ?? 1.5}
          step={0.01}
          value={shown}
          disabled={off}
          aria-label={t('ui.usage-tools.nomi-size')}
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
          aria-label={t('ui.usage-tools.zoom-in')}
          data-testid="mascot-size-plus"
          disabled={off || shown >= s.max - 1e-6}
          onClick={() => s && set(Math.min(s.max, Math.round((shown + s.step) * 100) / 100))}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
        </Button>
        <span className={styles.sizeValue} data-testid="mascot-size-value">
          {pct(shown)}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="mascot-size-reset"
          disabled={off || Math.abs(shown - s.default) < 1e-6}
          onClick={() =>
            void a.scaleReset().then((r) => {
              setState(r);
              setValue(r.scale);
            })
          }
        >
          {t('ui.knowledge-local.reset')}
        </Button>
      </div>
    </SettingRow>
  );
};
