import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { cx } from './cx';
import { emitInputValue } from './emitInputValue';
import { getLocale, t as tr } from './i18n';
import { Icon } from './icons';

export type DateTimeKind = 'date' | 'time' | 'datetime-local';

export interface DateTimeFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'size' | 'type'
> {
  /** 取值格式与原生输入框相同：date `YYYY-MM-DD`、time `HH:MM`、datetime-local `YYYY-MM-DDTHH:MM` */
  type: DateTimeKind;
  size?: 'sm' | 'md';
  invalid?: boolean;
}

const GAP = 4;
const MARGIN = 8;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseDay(s: string | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseTime(s: string | undefined): { h: number; m: number } | null {
  const m = /(?:^|T)(\d{2}):(\d{2})/.exec(s ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** 换月时日期收在当月最后一天内（1 月 31 日 → 2 月 28 日） */
function addMonths(d: Date, n: number): Date {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
}

/** 中文日历从周一开始，英文从周日开始 */
const weekStart = () => (getLocale() === 'en' ? 0 : 1);

function formatDisplay(kind: DateTimeKind, value: string): string {
  const day = parseDay(value);
  const time = parseTime(value);
  const dayText = day
    ? new Intl.DateTimeFormat(getLocale(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(day)
    : '';
  const timeText = time ? `${pad(time.h)}:${pad(time.m)}` : '';
  if (kind === 'date') return dayText;
  if (kind === 'time') return timeText;
  return day && time ? `${dayText} ${timeText}` : '';
}

interface PopPos {
  left: number;
  top: number;
}

/**
 * 自绘日期 / 时间选择器，替代原生 date / time / datetime-local（系统日历样式不跟主题、文案跟系统语言）。
 * 触发器外观与 Input 一致；弹层 portal + fixed 定位，下方放不下翻到上方。
 * 内部保留一个隐藏的原生输入框承载 value / name / data-testid / onChange，
 * 调用方与测试（fireEvent.change）沿用原生输入框的写法。
 */
export const DateTimeField = forwardRef<HTMLInputElement, DateTimeFieldProps>(
  function DateTimeField(
    {
      type,
      size = 'md',
      invalid,
      className,
      style,
      value,
      defaultValue,
      onChange,
      disabled,
      min,
      max,
      placeholder,
      id,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
      autoFocus,
      ...rest
    },
    ref,
  ) {
    const nativeRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => nativeRef.current as HTMLInputElement);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    const popId = useId();
    const [uncontrolled, setUncontrolled] = useState(
      defaultValue != null ? String(defaultValue) : '',
    );
    const current = value != null ? String(value) : uncontrolled;
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<PopPos | null>(null);
    const hasDate = type !== 'time';
    const hasTime = type !== 'date';
    const minDay = parseDay(typeof min === 'string' ? min : undefined);
    const maxDay = parseDay(typeof max === 'string' ? max : undefined);

    const selDay = parseDay(current);
    const selTime = parseTime(current);
    // 日历上键盘焦点所在的那天；翻月只改它
    const [cursor, setCursor] = useState<Date>(() => selDay ?? new Date());

    const outOfRange = useCallback(
      (d: Date) =>
        (minDay != null && d.getTime() < minDay.getTime()) ||
        (maxDay != null && d.getTime() > maxDay.getTime()),
      [minDay, maxDay],
    );

    const place = useCallback(() => {
      const t = triggerRef.current;
      const p = popRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const w = p?.offsetWidth ?? 0;
      const h = p?.offsetHeight ?? 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = r.bottom + GAP;
      if (top + h > vh - MARGIN && r.top - GAP - h >= MARGIN) top = r.top - GAP - h;
      const left = Math.max(MARGIN, Math.min(r.left, vw - w - MARGIN));
      setPos({ left, top: Math.max(MARGIN, top) });
    }, []);

    const commit = useCallback(
      (next: string) => {
        const el = nativeRef.current;
        if (!el || next === current) return;
        emitInputValue(el, next);
      },
      [current],
    );

    const close = useCallback((refocus = true) => {
      setOpen(false);
      setPos(null);
      if (refocus) triggerRef.current?.focus();
    }, []);

    const openPop = () => {
      if (disabled) return;
      setCursor(selDay ?? new Date());
      setOpen(true);
    };

    // 先隐藏渲染一次量出尺寸，再定位
    useLayoutEffect(() => {
      if (open) place();
    }, [open, place]);

    // 打开后把焦点放到选中的那天（没有日期时放到选中的小时）
    useLayoutEffect(() => {
      if (!open || !pos) return;
      const pop = popRef.current;
      const target =
        pop?.querySelector<HTMLElement>('.cd-datefield__day[tabindex="0"]') ??
        pop?.querySelector<HTMLElement>('.cd-datefield__cell.is-selected') ??
        pop?.querySelector<HTMLElement>('.cd-datefield__cell');
      target?.focus({ preventScroll: true });
      pop
        ?.querySelectorAll<HTMLElement>('.cd-datefield__col .is-selected')
        .forEach((el) => el.scrollIntoView({ block: 'center' }));
      // 只在刚打开、刚定好位时聚焦一次
    }, [open, pos != null]);

    // 键盘焦点跟着 cursor 走（方向键、翻月）
    useEffect(() => {
      if (!open) return;
      const el = popRef.current?.querySelector<HTMLElement>(
        `.cd-datefield__day[data-day="${dayKey(cursor)}"]`,
      );
      if (el && popRef.current?.contains(document.activeElement)) {
        if (document.activeElement?.classList.contains('cd-datefield__day')) el.focus();
      }
    }, [cursor, open]);

    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        const t = e.target as Node;
        if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
        close(false);
      };
      // window 捕获阶段：先于对话框的焦点陷阱处理 Esc / Tab，Esc 只关选择器、Tab 在弹层内循环
      const onKey = (e: KeyboardEvent) => {
        const pop = popRef.current;
        if (!pop) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === 'Tab' && pop.contains(document.activeElement)) {
          const list = Array.from(
            pop.querySelectorAll<HTMLElement>(
              'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]',
            ),
          );
          if (!list.length) return;
          const i = list.indexOf(document.activeElement as HTMLElement);
          const next = e.shiftKey
            ? list[(i - 1 + list.length) % list.length]
            : list[(i + 1) % list.length];
          e.preventDefault();
          e.stopPropagation();
          next?.focus();
        }
      };
      const onWin = () => place();
      document.addEventListener('mousedown', onDown, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onWin);
      window.addEventListener('scroll', onWin, true);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onWin);
        window.removeEventListener('scroll', onWin, true);
      };
    }, [open, close, place]);

    const timePart = (t: { h: number; m: number } | null) =>
      t ? `${pad(t.h)}:${pad(t.m)}` : '00:00';

    const pickDay = (d: Date) => {
      if (outOfRange(d)) return;
      setCursor(d);
      if (type === 'date') {
        commit(dayKey(d));
        close();
      } else {
        commit(`${dayKey(d)}T${timePart(selTime)}`);
      }
    };

    const pickTime = (t: { h: number; m: number }) => {
      if (type === 'time') commit(timePart(t));
      else commit(`${dayKey(selDay ?? cursor)}T${timePart(t)}`);
    };

    const pickNow = () => {
      const now = new Date();
      const t = { h: now.getHours(), m: now.getMinutes() };
      setCursor(now);
      if (type === 'date') {
        if (!outOfRange(now)) commit(dayKey(now));
        close();
      } else if (type === 'time') commit(timePart(t));
      else commit(`${dayKey(now)}T${timePart(t)}`);
    };

    const onGridKey = (e: React.KeyboardEvent) => {
      const ws = weekStart();
      const dow = (cursor.getDay() - ws + 7) % 7;
      const moves: Record<string, () => Date> = {
        ArrowLeft: () => addDays(cursor, -1),
        ArrowRight: () => addDays(cursor, 1),
        ArrowUp: () => addDays(cursor, -7),
        ArrowDown: () => addDays(cursor, 7),
        Home: () => addDays(cursor, -dow),
        End: () => addDays(cursor, 6 - dow),
        PageUp: () => addMonths(cursor, e.shiftKey ? -12 : -1),
        PageDown: () => addMonths(cursor, e.shiftKey ? 12 : 1),
      };
      const move = moves[e.key];
      if (move) {
        e.preventDefault();
        setCursor(move());
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pickDay(cursor);
      }
    };

    const onColKey = (e: React.KeyboardEvent, unit: 'h' | 'm') => {
      const delta =
        e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 5 : 0;
      const step = e.key === 'PageUp' ? -5 : delta;
      if (!step) return;
      e.preventDefault();
      const base = selTime ?? { h: 0, m: 0 };
      const span = unit === 'h' ? 24 : 60;
      const next = { ...base, [unit]: (base[unit] + step + span) % span };
      pickTime(next);
      requestAnimationFrame(() => {
        const col = popRef.current?.querySelector(`.cd-datefield__col[data-unit="${unit}"]`);
        const cell = col?.querySelector<HTMLElement>(`[data-v="${next[unit]}"]`);
        cell?.focus();
        cell?.scrollIntoView({ block: 'nearest' });
      });
    };

    const locale = getLocale();
    const today = new Date();
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const ws = weekStart();
    const gridStart = addDays(monthStart, -((monthStart.getDay() - ws + 7) % 7));
    const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
    const weekdays = Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(addDays(gridStart, i)),
    );
    const monthTitle = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(
      monthStart,
    );

    const display = formatDisplay(type, current);
    const defaultPlaceholder =
      type === 'date'
        ? tr('ui.foundation.pick-date')
        : type === 'time'
          ? tr('ui.foundation.pick-time')
          : tr('ui.foundation.pick-datetime');

    const timeColumn = (unit: 'h' | 'm') => {
      const items = unit === 'h' ? HOURS : MINUTES;
      const sel = selTime?.[unit];
      return (
        <div
          className="cd-datefield__col"
          data-unit={unit}
          role="listbox"
          aria-label={tr(unit === 'h' ? 'ui.foundation.hour' : 'ui.foundation.minute')}
        >
          {items.map((v) => (
            <button
              key={v}
              type="button"
              role="option"
              data-v={v}
              aria-selected={v === sel}
              tabIndex={v === (sel ?? 0) ? 0 : -1}
              className={cx('cd-datefield__cell', v === sel && 'is-selected')}
              onClick={() => pickTime({ ...(selTime ?? { h: 0, m: 0 }), [unit]: v })}
              onKeyDown={(e) => onColKey(e, unit)}
            >
              {pad(v)}
            </button>
          ))}
        </div>
      );
    };

    const pop = open
      ? createPortal(
          <div
            ref={popRef}
            id={popId}
            role="dialog"
            aria-label={ariaLabel ?? defaultPlaceholder}
            className="cd-datefield__pop"
            style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
            // 弹层 portal 在 body 下：外层弹层按 DOM 判断「点了外面」，在这里截住，免得点日期时外层一起关掉
            onMouseDown={(e) => e.stopPropagation()}
            data-testid={
              rest['data-testid' as keyof typeof rest]
                ? `${String(rest['data-testid' as keyof typeof rest])}-pop`
                : undefined
            }
          >
            <div className="cd-datefield__body">
              {hasDate && (
                <div className="cd-datefield__cal">
                  <div className="cd-datefield__head">
                    <button
                      type="button"
                      className="cd-datefield__nav"
                      aria-label={tr('ui.foundation.prev-month')}
                      onClick={() => setCursor((c) => addMonths(c, -1))}
                    >
                      <Icon icon={ChevronLeft} size={14} />
                    </button>
                    <span className="cd-datefield__month" aria-live="polite">
                      {monthTitle}
                    </span>
                    <button
                      type="button"
                      className="cd-datefield__nav"
                      aria-label={tr('ui.foundation.next-month')}
                      onClick={() => setCursor((c) => addMonths(c, 1))}
                    >
                      <Icon icon={ChevronRight} size={14} />
                    </button>
                  </div>
                  <div className="cd-datefield__grid" role="grid" onKeyDown={onGridKey}>
                    <div className="cd-datefield__row" role="row">
                      {weekdays.map((w, i) => (
                        <span
                          key={i}
                          role="columnheader"
                          className="cd-datefield__weekday"
                          aria-hidden
                        >
                          {w}
                        </span>
                      ))}
                    </div>
                    {Array.from({ length: 6 }, (_, row) => (
                      <div key={row} className="cd-datefield__row" role="row">
                        {days.slice(row * 7, row * 7 + 7).map((d) => {
                          const key = dayKey(d);
                          const isSel = selDay != null && key === dayKey(selDay);
                          const isCursor = key === dayKey(cursor);
                          const off = outOfRange(d);
                          return (
                            <button
                              key={key}
                              type="button"
                              role="gridcell"
                              data-day={key}
                              aria-selected={isSel}
                              aria-disabled={off || undefined}
                              aria-label={new Intl.DateTimeFormat(locale, {
                                dateStyle: 'full',
                              }).format(d)}
                              tabIndex={isCursor ? 0 : -1}
                              className={cx(
                                'cd-datefield__day',
                                d.getMonth() !== cursor.getMonth() && 'is-outside',
                                key === dayKey(today) && 'is-today',
                                isSel && 'is-selected',
                              )}
                              onClick={() => pickDay(d)}
                            >
                              {d.getDate()}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {hasTime && (
                <div className="cd-datefield__time">
                  {timeColumn('h')}
                  {timeColumn('m')}
                </div>
              )}
            </div>
            <div className="cd-datefield__foot">
              <button type="button" className="cd-datefield__link" onClick={pickNow}>
                {tr(type === 'date' ? 'ui.chat-settings.today' : 'ui.foundation.now')}
              </button>
              {hasTime && (
                <button
                  type="button"
                  className="cd-btn cd-btn--primary cd-btn--sm"
                  onClick={() => close()}
                >
                  {tr('ui.foundation.ok')}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

    return (
      <div
        className={cx('cd-datefield', size === 'sm' && 'cd-datefield--sm', className)}
        style={style}
        data-open={open || undefined}
      >
        <button
          ref={triggerRef}
          id={id}
          type="button"
          className={cx(
            'cd-input cd-datefield__trigger',
            size === 'sm' && 'cd-input--sm',
            invalid && 'cd-input--invalid',
          )}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popId : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          autoFocus={autoFocus}
          onClick={() => (open ? close() : openPop())}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (!open) openPop();
            }
          }}
        >
          <span className={cx('cd-datefield__value cd-truncate', !display && 'is-placeholder')}>
            {display || placeholder || defaultPlaceholder}
          </span>
          <Icon icon={hasDate ? CalendarDays : Clock} size={14} className="cd-datefield__icon" />
        </button>
        {/* 放在触发器后面：外层 <label> 点击时激活的是触发器 */}
        <input
          ref={nativeRef}
          type="text"
          className="cd-datefield__native"
          tabIndex={-1}
          aria-hidden
          value={current}
          disabled={disabled}
          onChange={(e) => {
            if (value == null) setUncontrolled(e.target.value);
            onChange?.(e);
          }}
          {...rest}
        />
        {pop}
      </div>
    );
  },
);
