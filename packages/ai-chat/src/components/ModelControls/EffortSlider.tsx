/** 思考深度分档滑杆（模型按钮浮层的默认页，参考 Codex 推理强度浮层） */
import { t } from '@nomi-ai/ui';
import React, { useRef } from 'react';

import type { ReasoningEffort } from '../../services/harnessClient';

import { effortLabel } from './effortLabel';
import styles from './index.module.css';

/** 滑块直径（与 CSS 的 .slider --thumb 一致） */
const THUMB = 18;

/**
 * 分档滑杆（参考 Codex 的推理强度滑杆）：细轨道上每档一个点，下方是档位名；
 * 点击 / 拖动吸附到最近一档，点档位名直接选，键盘 ← → Home End 调档。
 * value = null（沿用 CLI 默认）时不显示滑块与填充。
 * 拖动中只预览，松手才提交，避免每移一格就重启一次 Claude 长驻进程。
 */
export const EffortSlider: React.FC<{
  levels: ReasoningEffort[];
  value: ReasoningEffort | null;
  onPreview: (e: ReasoningEffort | null) => void;
  onCommit: (e: ReasoningEffort) => void;
}> = ({ levels, value, onPreview, onCommit }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const idx = value ? levels.indexOf(value) : -1;
  const last = Math.max(levels.length - 1, 1);
  // 第 i 档在「轨道宽 - 滑块宽」区间里的偏移（两端各留半个滑块）
  const at = (i: number, plus = 0) => `calc((100% - ${THUMB}px) * ${i / last} + ${plus}px)`;

  const levelAt = (clientX: number): ReasoningEffort => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= THUMB) return levels[Math.max(idx, 0)];
    const ratio = (clientX - r.left - THUMB / 2) / (r.width - THUMB);
    return levels[Math.round(Math.min(1, Math.max(0, ratio)) * last)];
  };

  const step = (to: number) => {
    const e = levels[Math.min(levels.length - 1, Math.max(0, to))];
    if (e !== value) onCommit(e);
  };

  return (
    <div className={styles.sliderWrap}>
      <div
        ref={trackRef}
        className={styles.slider}
        role="slider"
        tabIndex={0}
        aria-label={t('ui.chat-settings.reasoning-effort')}
        aria-valuemin={0}
        aria-valuemax={levels.length - 1}
        aria-valuenow={idx < 0 ? undefined : idx}
        aria-valuetext={value ? effortLabel(value) : t('ui.providers-schedule.default')}
        data-testid="effort-slider"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(idx < 0 ? 0 : idx + 1);
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(idx < 0 ? 0 : idx - 1);
          else if (e.key === 'Home') step(0);
          else if (e.key === 'End') step(levels.length - 1);
          else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onPreview(levelAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging.current) onPreview(levelAt(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(levelAt(e.clientX));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          onPreview(null);
        }}
      >
        <span className={styles.sliderTrack} />
        {idx >= 0 && <span className={styles.sliderFill} style={{ width: at(idx) }} />}
        {levels.map((l, i) => (
          <span
            key={l}
            className={`${styles.sliderStop} ${i <= idx ? styles.sliderStopOn : ''}`}
            style={{ left: at(i, THUMB / 2) }}
            data-testid={`effort-${l}`}
          />
        ))}
        {idx >= 0 && <span className={styles.sliderThumb} style={{ left: at(idx) }} />}
      </div>
      {/* 档位名：鼠标直接点选（键盘走滑杆本身，这里不进 Tab 顺序） */}
      <div className={styles.sliderLabels} aria-hidden="true">
        {levels.map((l, i) => (
          <span
            key={l}
            className={`${styles.sliderLabel} ${i === idx ? styles.sliderLabelOn : ''}`}
            style={{ left: at(i, THUMB / 2) }}
            onClick={() => {
              if (l !== value) onCommit(l);
            }}
          >
            {effortLabel(l)}
          </span>
        ))}
      </div>
    </div>
  );
};
