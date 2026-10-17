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
import { t as tr } from './i18n';
import { Icon } from './icons';

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  /** 分组标题；相同 group 的选项连续显示在同一组下 */
  group?: string;
  /** 右侧次要说明（如模型来源） */
  description?: React.ReactNode;
  /** 左侧图标 */
  icon?: React.ReactNode;
  /** 搜索用文本（label 不是字符串时提供） */
  searchText?: string;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md';
  /** 简写：传 options；也可以继续写 <option>/<optgroup> children */
  options?: SelectOption[];
  /** 是否显示搜索框；默认选项多于 8 个时自动开启 */
  searchable?: boolean;
  placeholder?: string;
  /** 弹层最小宽度（默认与触发器同宽） */
  menuMinWidth?: number;
}

const SEARCH_THRESHOLD = 8;
const MENU_MAX_H = 296;
const GAP = 4;

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
    options,
    className,
    children,
    searchable,
    placeholder = tr('请选择'),
    menuMinWidth,
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
  const [uncontrolled, setUncontrolled] = useState<string>(
    defaultValue != null ? String(defaultValue) : (all[0]?.value ?? ''),
  );
  const current = value != null ? String(value) : uncontrolled;
  const selected = all.find((o) => o.value === current);
  const showSearch = searchable ?? all.length > SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((o) =>
      `${o.searchText ?? textOf(o.label)} ${o.value} ${o.group ?? ''}`.toLowerCase().includes(q),
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
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
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
                  placeholder={tr('搜索…')}
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
            >
              {filtered.length === 0 && <div className="cd-dropdown__empty">{tr('无匹配项')}</div>}
              {filtered.map((o, i) => {
                const header =
                  o.group && o.group !== lastGroup ? (
                    <div className="cd-dropdown__group" role="presentation">
                      {o.group}
                    </div>
                  ) : null;
                lastGroup = o.group;
                const isSel = o.value === current;
                return (
                  <React.Fragment key={`${o.group ?? ''}:${o.value}`}>
                    {header}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      data-index={i}
                      data-value={o.value}
                      aria-selected={isSel}
                      aria-disabled={o.disabled || undefined}
                      className={cx(
                        'cd-dropdown__option',
                        i === active && 'is-active',
                        isSel && 'is-selected',
                      )}
                      onMouseMove={() => i !== active && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(o)}
                    >
                      {o.icon && <span className="cd-dropdown__icon">{o.icon}</span>}
                      <span className="cd-dropdown__label cd-truncate" title={textOf(o.label)}>
                        {tr(o.label)}
                      </span>
                      {o.description && (
                        <span className="cd-dropdown__desc">{tr(o.description)}</span>
                      )}
                      <span className="cd-dropdown__checkslot">{isSel && <Check />}</span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={cx('cd-dropdown', size === 'sm' && 'cd-dropdown--sm', className)}
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
        {all.map((o) => (
          <option key={`${o.group ?? ''}:${o.value}`} value={o.value} disabled={o.disabled}>
            {tr(textOf(o.label)) || o.value}
          </option>
        ))}
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
        title={title ?? (selected ? tr(textOf(selected.label)) : undefined)}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {selected?.icon && <span className="cd-dropdown__icon">{selected.icon}</span>}
        <span className={cx('cd-dropdown__value cd-truncate', !selected && 'is-placeholder')}>
          {selected ? tr(selected.label) : current || placeholder}
        </span>
        <Chevron />
      </button>
      {menu}
    </div>
  );
});
