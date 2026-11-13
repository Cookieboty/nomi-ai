/**
 * 输入栏的「模型 · 思考深度」按钮外壳（编程助手标签与 Nomi 对话共用同一份实现）。
 *
 * 交互参考 Codex：一个胶囊显示「模型 · 档位」，点开一个浮层：
 * - 档位页：思考深度（分档滑杆）+「模型：xxx ›」行（+ 编程助手的官方账号行）；
 * - 模型页：共享的 ModelPicker（inline，跨供应商标签、厂商筛选、搜索）；
 * - 账号页（仅编程助手有）：官方账号。
 *
 * 数据从哪来、改往哪写由使用方的 `ModelEffortSource` 适配器决定
 * （编程助手见 ModelControls/cliSource，Nomi 见 NomiModelSwitch）；这里只管触发器、浮层、
 * 页面切换与 testid 前缀。
 */
import {
  BrandIcon,
  Icon,
  ModelPicker,
  t,
  type PickerProvider,
  type SelectOption,
} from '@nomi-ai/ui';
import { ChevronDown, ChevronLeft, ChevronRight, Cpu } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { registerModelMenu } from '../../services/modelMenu';

import { ChipMenu, pickerHeight } from './ChipMenu';
import { EffortSlider } from './EffortSlider';
import styles from './index.module.css';
import { ModelChoicePage, ModelChoiceRow, type ModelChoiceSource } from './ModelChoicePage';

/** 档位页的数据与动作 */
export interface EffortPageSource {
  /** 这个模型能不能调档位：false 时显示原因，不画滑杆 */
  supported: boolean;
  levels: readonly string[];
  /** 滑杆当前定位（显式设置过的档位，或模型默认档） */
  value: string | null;
  /** 用户显式设置过档位：显示「恢复默认」 */
  explicit: boolean;
  /** 沿用默认又不知道默认是哪一档时的说明；null 不显示 */
  defaultUnknownNote: string | null;
  /** 不支持档位时的说明 */
  unavailableHint: string;
  onCommit: (level: string | null) => void;
  /** 「恢复默认」：回到沿用模型默认 */
  onRestore: () => void;
}

/** 模型页的数据与动作 */
export interface ModelPageSource {
  providers: PickerProvider[];
  value: string | null;
  extraOptions?: SelectOption[];
  tailOptions?: SelectOption[];
  notice?: React.ReactNode;
  /** 供应商标签行右端（如刷新按钮） */
  headerEnd?: React.ReactNode;
  /** 「‹ 模型」返回行右端（如刷新按钮） */
  backEnd?: React.ReactNode;
  /** 是否画「‹ 模型」返回行（第三方来源按标签浏览时不画） */
  showBack: boolean;
  /** 模型页底部（如长上下文一组） */
  footer?: React.ReactNode;
  focusProvider?: string;
  purpose?: 'chat' | 'coding';
  optionTestId?: (ref: string) => string | undefined;
  /** 选中后去哪：回档位页 / 关掉整个浮层 */
  onPick: (value: string) => 'effort' | 'close';
  /** 模型页要更宽（跨供应商标签） */
  wide: boolean;
}

/** 账号页（仅编程助手有） */
export interface AccountPageSource extends ModelChoiceSource {
  /** '' = 跟随默认账号 */
  onChange: (id: string | null) => void;
}

export interface ProviderPageSource extends ModelChoiceSource {
  /** 没有同名模型时去目标供应商的模型页，不立即改供应商。 */
  onChange: (id: string) => 'effort' | 'model' | 'close';
}

export interface ModelEffortSource {
  /** 触发器上的名字（含档位，或只有模型名） */
  label: string;
  muted?: boolean;
  /** 品牌图标 id；没有时用通用芯片图标 */
  brand?: string;
  ariaLabel: string;
  /** 浮层标题 */
  menuLabel: string;
  note?: string | null;
  longBadge?: boolean;
  /** 点触发器打开时停在哪一页 */
  initialView: 'effort' | 'model';
  /** `/model` 命令打开时停在哪一页 */
  menuCommandView: 'effort' | 'model';
  /** `/model` 命令登记的 key；空串 = 不登记 */
  menuKey: string;
  effort: EffortPageSource;
  model: ModelPageSource;
  account?: AccountPageSource | null;
  provider?: ProviderPageSource | null;
  /** 「模型：xxx ›」行显示的名字 */
  modelLabel: string;
  modelRowAria: string;
}

export interface ModelEffortChipProps {
  /** testid 前缀：'model' → model-chip / model-menu / model-picker；'nomi-model' → nomi-model-* */
  prefix: string;
  /** 档位页的 testid 前缀：'effort' → effort-view / effort-default；'nomi-effort' → nomi-effort-* */
  effortPrefix: string;
  /** 外层容器的 testid（如 nomi-model-switch） */
  wrapTestId?: string;
  source: ModelEffortSource;
  /** 浮层开 / 关（使用方据此读账号列表、清掉本地状态） */
  onOpenChange?: (open: boolean) => void;
  /** 不可用时只画一个不可点的胶囊 */
  disabled?: { label: string; ariaLabel: string } | null;
}

/** 模型 · 思考深度按钮（一个按钮 + 一个浮层，参考 Codex） */
export const ModelEffortChip: React.FC<ModelEffortChipProps> = ({
  prefix,
  effortPrefix,
  wrapTestId,
  source,
  onOpenChange,
  disabled = null,
}) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'model' | 'account' | 'provider'>(source.initialView);
  const [query, setQuery] = useState('');
  const [focusedProvider, setFocusedProvider] = useState<string>();
  /** 拖动滑杆时的预览档位（松手提交后清空，回到适配器给的值） */
  const [preview, setPreview] = useState<string | null>(null);
  const [pickerMax, setPickerMax] = useState(420);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 选中了一项（inline 时点当前值也通知）：与 Esc 区分开 */
  const picked = useRef(false);

  // 适配器每帧都是新对象：`/model` 的回调里用它拿最新的数据与度量参数
  const sourceRef = useRef(source);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    sourceRef.current = source;
    onOpenChangeRef.current = onOpenChange;
  });

  const setOpenWithNotify = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // `/model` 打开同一个浮层：直接到模型列表，搜索框里填上参数（不可用时（如供应商被锁定）不登记）
  const menuKey = disabled ? '' : source.menuKey;
  useEffect(() => {
    const key = sourceRef.current.menuKey;
    if (!menuKey || !key) return;
    return registerModelMenu(key, (q) => {
      const s = sourceRef.current;
      setPickerMax(pickerHeight(btnRef.current, s.model.showBack, !!s.model.footer));
      setView(s.menuCommandView);
      setQuery(q);
      setFocusedProvider(undefined);
      setPreview(null);
      setOpen(true);
      onOpenChangeRef.current?.(true);
    });
  }, [menuKey]);

  if (disabled) {
    return (
      <div className={styles.wrap} data-testid={wrapTestId}>
        <button
          type="button"
          className={`${styles.chip} ${styles.chipMuted}`}
          disabled
          aria-label={disabled.ariaLabel}
          data-testid={`${prefix}-chip`}
        >
          <Icon icon={Cpu} />
          <span className={styles.label}>{disabled.label}</span>
        </button>
      </div>
    );
  }

  const measure = () =>
    setPickerMax(pickerHeight(btnRef.current, source.model.showBack, !!source.model.footer));

  const toggle = () => {
    if (!open) measure();
    setView(source.initialView);
    setQuery('');
    setFocusedProvider(undefined);
    setPreview(null);
    setOpenWithNotify(!open);
  };

  const close = () => {
    setPreview(null);
    setOpenWithNotify(false);
  };

  const toEffort = () => {
    setQuery('');
    setFocusedProvider(undefined);
    setView('effort');
  };

  const onPick = (value: string) => {
    picked.current = true;
    const next = source.model.onPick(value);
    setQuery('');
    setFocusedProvider(undefined);
    setPreview(null);
    if (next === 'close') close();
    else setView('effort');
  };

  const onPickerOpenChange = (next: boolean) => {
    if (next) return;
    if (picked.current) {
      picked.current = false;
      return;
    }
    // 没有点选项（Esc）：关掉整个浮层，焦点回到按钮
    setOpenWithNotify(false);
    btnRef.current?.focus();
  };

  const onAccountPick = (id: string | null) => {
    picked.current = true;
    source.account?.onChange(id);
    setView('effort');
  };

  const onProviderPick = (id: string) => {
    const next = source.provider?.onChange(id);
    picked.current = true;
    setQuery('');
    setPreview(null);
    setFocusedProvider(next === 'model' ? id : undefined);
    if (next === 'close') close();
    else setView(next ?? 'effort');
  };

  const { effort, model, account, provider } = source;
  const providerRow = provider && (
    <ModelChoiceRow
      source={provider}
      testId={`${prefix}-provider-open`}
      onClick={() => setView('provider')}
    />
  );
  const shown = preview ?? effort.value;

  return (
    <div className={styles.wrap} data-testid={wrapTestId}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.chip} ${source.muted ? styles.chipMuted : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={source.ariaLabel}
        data-testid={`${prefix}-chip`}
        onClick={toggle}
      >
        {source.brand ? (
          <BrandIcon brand={source.brand} name={source.label} size={16} inline />
        ) : (
          <Icon icon={Cpu} />
        )}
        <span className={styles.label}>{source.label}</span>
        {source.longBadge && (
          <span className={styles.longBadge} data-testid={`${prefix}-chip-long`}>
            {t('ui.models.long-context-short')}
          </span>
        )}
        <Icon icon={ChevronDown} size={12} />
      </button>
      {source.note && (
        <span className={styles.note} role="status" data-testid={`${prefix}-chip-note`}>
          {source.note}
        </span>
      )}
      {open && (
        <ChipMenu
          btnRef={btnRef}
          menuRef={menuRef}
          onClose={() => setOpenWithNotify(false)}
          label={source.menuLabel}
          testId={`${prefix}-menu`}
          width={view === 'model' && model.wide ? 380 : 300}
        >
          {view === 'effort' ? (
            <div className={styles.effortView} data-testid={`${effortPrefix}-view`}>
              {effort.supported ? (
                <>
                  <div className={styles.effortHead}>
                    <span className={styles.effortHeadLabel}>
                      {t('ui.chat-settings.reasoning-effort')}
                    </span>
                    {effort.explicit ? (
                      <button
                        type="button"
                        className={styles.link}
                        data-testid={`${effortPrefix}-default`}
                        onClick={effort.onRestore}
                      >
                        {t('ui.providers-schedule.restore-defaults')}
                      </button>
                    ) : (
                      // 沿用默认、又没告诉我们默认是哪一档：说明由谁决定，而不是留一个空滑块
                      effort.defaultUnknownNote && (
                        <span
                          className={styles.effortNote}
                          data-testid={`${effortPrefix}-default-unknown`}
                        >
                          {effort.defaultUnknownNote}
                        </span>
                      )
                    )}
                  </div>
                  <EffortSlider
                    levels={effort.levels}
                    value={shown}
                    onPreview={setPreview}
                    onCommit={effort.onCommit}
                  />
                </>
              ) : (
                <div
                  className={`${styles.effortHead} ${styles.effortUnavailable}`}
                  data-testid={`${effortPrefix}-unavailable`}
                >
                  <span className={styles.effortHeadLabel}>
                    {t('ui.chat-settings.reasoning-effort')}
                  </span>
                  <p
                    className={styles.effortHint}
                    data-testid={`${effortPrefix}-hint`}
                    role="status"
                  >
                    {effort.unavailableHint}
                  </p>
                </div>
              )}
              <button
                type="button"
                className={styles.modelRow}
                data-testid={`${prefix}-open`}
                aria-label={source.modelRowAria}
                onClick={() => setView('model')}
              >
                <span className={styles.modelRowLabel}>{t('ui.foundation.model')}</span>
                <span className={styles.modelRowValue}>
                  <span className={styles.modelLinkText}>{source.modelLabel}</span>
                </span>
                <Icon icon={ChevronRight} size={14} />
              </button>
              {account && (
                <ModelChoiceRow
                  source={account}
                  testId="account-open"
                  onClick={() => setView('account')}
                />
              )}
              {providerRow}
            </div>
          ) : view === 'account' && account ? (
            <ModelChoicePage
              source={account}
              prefix="account"
              onBack={toEffort}
              onChange={(id) => onAccountPick(id || null)}
              onOpenChange={onPickerOpenChange}
            />
          ) : view === 'provider' && provider ? (
            <ModelChoicePage
              source={provider}
              prefix={`${prefix}-provider`}
              onBack={() => setView(source.initialView)}
              onChange={onProviderPick}
              onOpenChange={onPickerOpenChange}
            />
          ) : (
            <>
              {model.showBack && (
                <div className={styles.modelHead}>
                  <button
                    type="button"
                    className={styles.back}
                    data-testid={`${prefix}-back`}
                    onClick={toEffort}
                  >
                    <Icon icon={ChevronLeft} size={14} />
                    {t('ui.foundation.model')}
                  </button>
                  {model.backEnd}
                </div>
              )}
              <ModelPicker
                inline
                browse
                purpose={model.purpose ?? 'chat'}
                size="sm"
                inlineMaxHeight={pickerMax}
                defaultQuery={query}
                providers={model.providers}
                value={focusedProvider ? null : model.value}
                extraOptions={model.extraOptions}
                tailOptions={model.tailOptions}
                notice={model.notice}
                headerEnd={model.headerEnd}
                optionTestId={model.optionTestId}
                focusProvider={focusedProvider ?? model.focusProvider}
                onChange={onPick}
                onOpenChange={onPickerOpenChange}
                aria-label={t('ui.foundation.model')}
                data-testid={`${prefix}-picker`}
              />
              {model.footer}
              {!model.showBack && providerRow}
            </>
          )}
        </ChipMenu>
      )}
    </div>
  );
};
