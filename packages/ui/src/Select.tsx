import { Check as CheckIcon, ChevronDown } from 'lucide-react';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { cx } from './cx';
import { getLocale, t as tr } from './i18n';
import { Icon } from './icons';
import { FloatingTip } from './Tooltip';

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  /** 分组标题；相同 group 的选项连续显示在同一组下 */
  group?: string;
  /** 右侧次要说明（如模型来源） */
  description?: React.ReactNode;
  /** 只在悬停提示里显示的说明（如模型能力），不占选项行的宽度 */
  hint?: string;
  /** 左侧图标 */
  icon?: React.ReactNode;
  /** 搜索用文本（label 不是字符串时提供） */
  searchText?: string;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md';
  /**
   * 外观：default 实底；ghost 透明底（与旁边的透明按钮 / chip 同一行时用）；
   * chip 胶囊形、ms 高（输入栏工具行，与模型 / 权限按钮同形同高，忽略 size）
   */
  variant?: 'default' | 'ghost' | 'chip';
  /** 简写：传 options；也可以继续写 <option>/<optgroup> children */
  options?: SelectOption[];
  /** 是否显示搜索框；默认选项多于 8 个时自动开启 */
  searchable?: boolean;
  placeholder?: string;
  /** 弹层最小宽度（默认与触发器同宽） */
  menuMinWidth?: number;
  /** 触发器上显示的内容（默认与选项的 label 相同；如列表里只写模型名、触发器写「供应商 / 模型」） */
  renderValue?: (option: SelectOption) => React.ReactNode;
}

const SEARCH_THRESHOLD = 8;
const MENU_MAX_H = 296;
const GAP = 4;
/** 停留多久才出悬停提示（ms） */
const TIP_DELAY = 350;

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node))
    return textOf(node.props.children);
  return '';
}

/** 把 <option>/<optgroup> children 转成选项数组（保持旧调用方式可用）。 */
function optionsFromChildren(children: React.ReactNode, group?: string): SelectOption[] {
  const out: SelectOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as {
      value?: string | number;
      label?: string;
      disabled?: boolean;
      children?: React.ReactNode;
    };
    if (child.type === 'optgroup') {
      out.push(...optionsFromChildren(props.children, props.label));
    } else if (child.type === 'option') {
      const label = props.children ?? props.label ?? props.value;
      out.push({
        value: String(props.value ?? textOf(props.children)),
        label,
        disabled: props.disabled,
        group,
      });
    } else if (child.type === React.Fragment) {
      out.push(...optionsFromChildren(props.children, group));
    }
  });
  return out;
}

const Chevron = () => <Icon icon={ChevronDown} className="cd-dropdown__chevron" size={14} />;
const Check = () => <Icon icon={CheckIcon} className="cd-dropdown__check" size={14} />;

/**
 * 弹层里的一行。单独 memo：悬停 / 方向键移动高亮时只有高亮变化的两行重渲染，
 * 否则几百个选项每次都要重新翻译标签、拼悬停提示，长列表上移动鼠标会卡。
 */
const MenuOption = React.memo(function MenuOption({
  o,
  index,
  id,
  active,
  selected,
  describedBy,
  setActive,
  onPick,
}: {
  o: SelectOption;
  index: number;
  id: string;
  active: boolean;
  selected: boolean;
  describedBy?: string;
  setActive: (i: number) => void;
  onPick: (o: SelectOption) => void;
}) {
  return (
    <div
      id={id}
      role="option"
      data-index={index}
      data-value={o.value}
      aria-selected={selected}
      aria-disabled={o.disabled || undefined}
      className={cx('cd-dropdown__option', active && 'is-active', selected && 'is-selected')}
      aria-describedby={describedBy}
      onMouseMove={() => !active && setActive(index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(o)}
    >
      {o.icon && <span className="cd-dropdown__icon">{o.icon}</span>}
      <span className="cd-dropdown__label cd-truncate">{tr(o.label)}</span>
      {o.description && <span className="cd-dropdown__desc">{tr(o.description)}</span>}
      <span className="cd-dropdown__checkslot">{selected && <Check />}</span>
    </div>
  );
});

interface MenuPos {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'bottom' | 'top';
}

/**
 * 自绘下拉框：搜索、键盘导航（↑↓ Home End Enter Esc Tab、输入即搜）、选中勾选、分组、
 * 弹层用 portal + fixed 定位，下方空间不足自动翻到上方，超长滚动。
 * 内部仍保留一个透明的原生 <select>（承载 value / name / data-testid / onChange），
 * 让表单、测试（Playwright selectOption）与旧代码无需改动。
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    size = 'md',
    variant = 'default',
    options,
    className,
    children,
    searchable,
    placeholder = tr('ui.mascot-theme.please-select'),
    menuMinWidth,
    renderValue,
    value,
    defaultValue,
    disabled,
    onChange,
    style,
    title,
    id,
    'aria-label': ariaLabel,
    ...rest
  },
  ref,
) {
  const all = useMemo(
    () => [...(options ?? []), ...optionsFromChildren(children)],
    [options, children],
  );
  // 隐藏的原生 <option> 列表（模型选择器有几百个）：选项与语言不变就复用同一组元素，
  // 父组件重渲染时不再逐个比对；locale 变化时要重新翻译
  const locale = getLocale();
  const nativeOptions = useMemo(
    () =>
      all.map((o) => (
        <option key={`${o.group ?? ''}:${o.value}`} value={o.value} disabled={o.disabled}>
          {tr(textOf(o.label)) || o.value}
        </option>
      )),
    [all, locale],
  );
  const nativeRef = useRef<HTMLSelectElement>(null);
  useImperativeHandle(ref, () => nativeRef.current as HTMLSelectElement);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<MenuPos | null>(null);
  // 自绘悬停提示（不用原生 title）：鼠标 / 方向键停在某一行一会儿后，在菜单旁显示完整名称与说明
  const tipId = useId();
  const [tipArmed, setTipArmed] = useState(false);
  const [tipFor, setTipFor] = useState(-1);
  const [triggerTip, setTriggerTip] = useState(false);
  const triggerTipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [uncontrolled, setUncontrolled] = useState<string>(
    defaultValue != null ? String(defaultValue) : (all[0]?.value ?? ''),
  );
  const current = value != null ? String(value) : uncontrolled;
  const selected = all.find((o) => o.value === current);
  const showSearch = searchable ?? all.length > SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // 选项文案可以是翻译 key：按界面上显示的文字搜，不按 key 搜
    return all.filter((o) =>
      `${tr(o.searchText ?? textOf(o.label))} ${o.value} ${tr(o.group ?? '')}`
        .toLowerCase()
        .includes(q),
    );
  }, [all, query]);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const below = vh - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const placement: MenuPos['placement'] = below < 180 && above > below ? 'top' : 'bottom';
    const maxHeight = Math.max(120, Math.min(MENU_MAX_H, placement === 'bottom' ? below : above));
    const width = Math.max(r.width, menuMinWidth ?? 0);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const top = placement === 'bottom' ? r.bottom + GAP : r.top - GAP;
    setPos({ left, top, width, maxHeight, placement });
  }, [menuMinWidth]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    place();
    setQuery('');
    setTipArmed(false);
    setTipFor(-1);
    clearTimeout(triggerTipTimer.current);
    setTriggerTip(false);
    setActive(
      Math.max(
        0,
        all.findIndex((o) => o.value === current),
      ),
    );
    setOpen(true);
  }, [all, current, disabled, place]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (opt: SelectOption | undefined) => {
      if (!opt || opt.disabled) return;
      const el = nativeRef.current;
      if (value == null) setUncontrolled(opt.value);
      if (el && opt.value !== current) {
        el.value = opt.value;
        onChange?.({
          target: el,
          currentTarget: el,
          type: 'change',
          nativeEvent: new Event('change'),
          preventDefault() {},
          stopPropagation() {},
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
          persist() {},
        } as unknown as React.ChangeEvent<HTMLSelectElement>);
      }
      close();
    },
    [close, current, onChange, value],
  );

  useLayoutEffect(() => {
    if (!open) return;
    if (showSearch) searchRef.current?.focus();
    else menuRef.current?.focus();
  }, [open, showSearch]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onWin = () => place();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [open, close, place]);

  // 让高亮项保持在可视区域
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    setTipFor(-1);
    if (!open || !tipArmed || active < 0) return;
    const timer = setTimeout(() => setTipFor(active), TIP_DELAY);
    return () => clearTimeout(timer);
  }, [open, tipArmed, active, filtered]);

  useEffect(() => () => clearTimeout(triggerTipTimer.current), []);

  const move = (delta: number) => {
    if (!filtered.length) return;
    let i = active;
    for (let n = 0; n < filtered.length; n++) {
      i = (i + delta + filtered.length) % filtered.length;
      if (!filtered[i].disabled) break;
    }
    setActive(i);
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setTipArmed(true);
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setTipArmed(true);
        move(-1);
        break;
      case 'Home':
        if (!showSearch) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (!showSearch) {
          e.preventDefault();
          setActive(filtered.length - 1);
        }
        break;
      case 'Enter':
        e.preventDefault();
        commit(filtered[active]);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openMenu();
    }
  };

  // 只在有额外信息时提示：有说明 / 能力，或名称被截断
  const tipOption = open && tipFor >= 0 ? filtered[tipFor] : undefined;
  const tipRow = tipOption
    ? (menuRef.current?.querySelector<HTMLElement>(`[data-index="${tipFor}"]`) ?? null)
    : null;
  const tipLabel = tipRow?.querySelector<HTMLElement>('.cd-dropdown__label');
  const showOptionTip =
    !!tipOption &&
    !!tipRow &&
    !!(
      tipOption.hint ||
      tipOption.description ||
      (tipLabel && tipLabel.scrollWidth > tipLabel.clientWidth)
    );
  const optionTip = showOptionTip ? (
    <FloatingTip id={tipId} anchor={tipRow} boundary={menuRef.current} placement="side">
      {tr(tipOption.label)}
      {(tipOption.description || tipOption.hint) && (
        <span className="cd-floating-tip__meta">
          {tipOption.description && tr(tipOption.description)}
          {tipOption.description && tipOption.hint && ' · '}
          {tipOption.hint && tr(tipOption.hint)}
        </span>
      )}
    </FloatingTip>
  ) : null;

  const onTriggerEnter = () => {
    clearTimeout(triggerTipTimer.current);
    if (open) return;
    const v = triggerRef.current?.querySelector<HTMLElement>('.cd-dropdown__value');
    const truncated = !!v && v.scrollWidth > v.clientWidth;
    if (!title && !(truncated && selected)) return;
    triggerTipTimer.current = setTimeout(() => setTriggerTip(true), TIP_DELAY);
  };
  const onTriggerLeave = () => {
    clearTimeout(triggerTipTimer.current);
    setTriggerTip(false);
  };

  let lastGroup: string | undefined;
  const menu =
    open && pos
      ? createPortal(
          <div
            ref={menuRef}
            className={cx('cd-dropdown__menu', `cd-dropdown__menu--${pos.placement}`)}
            style={{
              left: pos.left,
              width: pos.width,
              ...(pos.placement === 'bottom'
                ? { top: pos.top }
                : { bottom: window.innerHeight - pos.top }),
            }}
            tabIndex={-1}
            onKeyDown={onMenuKey}
            data-testid={
              rest['data-testid' as keyof typeof rest]
                ? `${String(rest['data-testid' as keyof typeof rest])}-menu`
                : undefined
            }
          >
            {showSearch && (
              <div className="cd-dropdown__search">
                <input
                  ref={searchRef}
                  className="cd-input cd-input--sm"
                  placeholder={tr('ui.mascot-theme.search')}
                  value={query}
                  aria-controls={listId}
                  aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                />
              </div>
            )}
            <div
              id={listId}
              role="listbox"
              className="cd-dropdown__list"
              style={{ maxHeight: pos.maxHeight - (showSearch ? 44 : 0) }}
              onMouseMove={() => !tipArmed && setTipArmed(true)}
              onMouseLeave={() => setTipArmed(false)}
              onScroll={() => setTipFor(-1)}
            >
              {filtered.length === 0 && (
                <div className="cd-dropdown__empty">{tr('ui.mascot-theme.no-matches')}</div>
              )}
              {filtered.map((o, i) => {
                const header =
                  o.group && o.group !== lastGroup ? (
                    <div className="cd-dropdown__group" role="presentation">
                      {tr(o.group)}
                    </div>
                  ) : null;
                lastGroup = o.group;
                return (
                  <React.Fragment key={`${o.group ?? ''}:${o.value}`}>
                    {header}
                    <MenuOption
                      o={o}
                      index={i}
                      id={`${listId}-${i}`}
                      active={i === active}
                      selected={o.value === current}
                      describedBy={showOptionTip && i === tipFor ? tipId : undefined}
                      setActive={setActive}
                      onPick={commit}
                    />
                  </React.Fragment>
                );
              })}
            </div>
            {optionTip}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={cx(
        'cd-dropdown',
        size === 'sm' && 'cd-dropdown--sm',
        variant !== 'default' && `cd-dropdown--${variant}`,
        className,
      )}
      style={style}
      data-open={open || undefined}
    >
      <select
        ref={nativeRef}
        className="cd-dropdown__native"
        tabIndex={-1}
        aria-hidden
        value={current}
        disabled={disabled}
        onChange={(e) => {
          if (value == null) setUncontrolled(e.target.value);
          onChange?.(e);
        }}
        {...rest}
      >
        {!selected && <option value={current}>{current}</option>}
        {nativeOptions}
      </select>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="cd-dropdown__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-describedby={triggerTip ? `${tipId}-trigger` : undefined}
        disabled={disabled}
        onMouseEnter={onTriggerEnter}
        onMouseLeave={onTriggerLeave}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {selected?.icon && <span className="cd-dropdown__icon">{selected.icon}</span>}
        <span className={cx('cd-dropdown__value cd-truncate', !selected && 'is-placeholder')}>
          {selected
            ? renderValue
              ? renderValue(selected)
              : tr(selected.label)
            : current || placeholder}
        </span>
        <Chevron />
      </button>
      {menu}
      {triggerTip && !open && (
        <FloatingTip id={`${tipId}-trigger`} anchor={triggerRef.current}>
          {title ?? (selected ? tr(selected.label) : null)}
        </FloatingTip>
      )}
    </div>
  );
});
