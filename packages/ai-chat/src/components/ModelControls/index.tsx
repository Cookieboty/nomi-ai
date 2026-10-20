/**
 * 输入栏的「模型 · 思考深度」按钮（仅官方账号 / CLI 后端：Codex / Claude Code / Grok）。
 *
 * 交互参考 Codex：一个按钮显示「模型 · 档位」，点开一个浮层，节省输入栏空间；
 * - 默认页：大字显示当前档位，下面「模型名 ›」，再下面是分档滑杆（只在推理模型上出现）；
 *   不选档位 = 不发覆盖参数，沿用 CLI 默认，滑杆不显示滑块，可「恢复默认」；
 * - 点「模型名 ›」进入模型页：跟随 CLI 默认 / 目录内模型 / 自定义模型 id，选完回到滑杆。
 * 模型列表、每个模型的档位与默认档位全部来自 CLI 自己（主进程读取并缓存，见
 * electron/src/cli/modelDiscovery.ts），这里不写死任何模型或档位；读不到时只保留默认与自定义。
 * 覆盖是标签级的，主进程在每轮启动时以进程级参数注入
 * （codex `-c model=...`、grok `-m ... --reasoning-effort ...`、claude `--model ... --effort ...`），
 * 不改写用户的全局 CLI 配置；每轮新进程的后端下一条消息即生效，Claude 长驻进程空闲时重启复用。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  PencilLine,
  RefreshCw,
} from 'lucide-react';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  cliProviderClient,
  type CliProviderKind,
  type CliProviderState,
} from '../../services/cliProviderClient';
import {
  harnessClient,
  type BackendModelCatalog,
  type HarnessTabMeta,
  type ModelCatalogModel,
  type ReasoningEffort,
} from '../../services/harnessClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { activeProfileOf } from '../CliProviderChip';

import styles from './index.module.css';

/** 档位由浅到深的顺序（只用于排序 CLI 返回的值，不代表某个模型支持哪些） */
const EFFORT_ORDER: ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export function effortLabel(e: ReasoningEffort): string {
  switch (e) {
    case 'minimal':
      return t('极简');
    case 'low':
      return t('低');
    case 'medium':
      return t('中');
    case 'high':
      return t('高');
    case 'xhigh':
      return t('极高');
    case 'max':
      return t('最高');
    case 'ultra':
      return t('极限');
  }
}

function effortHint(e: ReasoningEffort): string {
  switch (e) {
    case 'minimal':
      return t('最快，几乎不思考');
    case 'low':
      return t('浅思考，响应快');
    case 'medium':
      return t('均衡');
    case 'high':
      return t('深思考，更慢');
    case 'xhigh':
      return t('很深，明显更慢更耗额度');
    case 'max':
      return t('最深，最慢也最耗额度');
    case 'ultra':
      return t('超出最高档的极限推理，非常慢且耗额度');
  }
}

/** 主进程返回的目录做结构校验：无效 / 空后端一律当作「不支持」 */
function validCatalog(c: unknown): BackendModelCatalog | null {
  if (!c || typeof c !== 'object') return null;
  const cat = c as Partial<BackendModelCatalog>;
  if (typeof cat.backend !== 'string' || !Array.isArray(cat.models)) return null;
  const okModel = (m: unknown) =>
    !!m &&
    typeof (m as ModelCatalogModel).id === 'string' &&
    Array.isArray((m as ModelCatalogModel).efforts);
  if (!cat.models.every(okModel)) return null;
  if (cat.defaultModel && !okModel(cat.defaultModel)) return null;
  return { ...cat, defaultModel: cat.defaultModel ?? null } as BackendModelCatalog;
}

/** 向主进程要目录（主进程从 CLI 读取并缓存）；IPC 本身失败当作不支持 */
function fetchCatalog(backend: string, refresh: boolean): Promise<BackendModelCatalog | null> {
  return harnessClient
    .modelCatalog(backend as HarnessTabMeta['backend'], refresh ? { refresh } : {})
    .then(validCatalog)
    .catch(() => null);
}

/**
 * 某个后端的模型目录。catalog：undefined = 还在读；null = 该后端不支持切换（按钮整体不渲染）。
 * refresh 让主进程重新从 CLI 读；重读失败时保留原目录。
 */
function useCatalog(backend: string) {
  const [catalog, setCatalog] = useState<BackendModelCatalog | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetchCatalog(backend, false).then((c) => {
      if (alive) setCatalog(c);
    });
    return () => {
      alive = false;
    };
  }, [backend]);
  const refresh = () => {
    setRefreshing(true);
    void fetchCatalog(backend, true).then((c) => {
      if (c) setCatalog(c);
      setRefreshing(false);
    });
  };
  return { catalog, refreshing, refresh };
}

/** 目录里所有模型档位的并集（自定义的未知模型 / CLI 没告诉我们默认模型时用） */
function catalogEfforts(catalog: BackendModelCatalog): ReasoningEffort[] {
  const set = new Set(catalog.models.flatMap((m) => m.efforts));
  return EFFORT_ORDER.filter((e) => set.has(e));
}

/** 按钮浮层的外壳：挂 body、fixed、向上弹，避免输入栏 overflow 裁剪 */
const ChipMenu: React.FC<{
  btnRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  label: string;
  testId: string;
  width?: number;
  children: React.ReactNode;
}> = ({ btnRef, menuRef, onClose, label, testId, width = 300, children }) => {
  const [pos, setPos] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - r.top + 6,
      width,
    });
  }, [btnRef, width]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        onClose();
        btnRef.current?.focus();
        return;
      }
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menuRef, btnRef, onClose]);
  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      style={pos}
      role="dialog"
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  );
};

/** 滑块直径（与 CSS 的 .slider --thumb 一致） */
const THUMB = 18;

/**
 * 分档滑杆（参考 Codex 的推理强度滑杆）：细轨道上每档一个点，下方是档位名；
 * 点击 / 拖动吸附到最近一档，点档位名直接选，键盘 ← → Home End 调档。
 * value = null（沿用 CLI 默认）时不显示滑块与填充。
 * 拖动中只预览，松手才提交，避免每移一格就重启一次 Claude 长驻进程。
 */
const EffortSlider: React.FC<{
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
        aria-label={t('思考深度')}
        aria-valuemin={0}
        aria-valuemax={levels.length - 1}
        aria-valuenow={idx < 0 ? undefined : idx}
        aria-valuetext={value ? effortLabel(value) : t('默认')}
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

/** 模型 · 思考深度按钮（一个按钮 + 一个浮层，参考 Codex） */
const ModelChip: React.FC<{
  tab: HarnessTabMeta;
  catalog: BackendModelCatalog;
  refreshing: boolean;
  onRefresh: () => void;
}> = ({ tab, catalog, refreshing, onRefresh }) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'model'>('effort');
  const [note, setNote] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  /** 拖动滑杆时的预览档位（松手提交后清空，回到以主进程广播的 tab 为准） */
  const [preview, setPreview] = useState<ReasoningEffort | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = tab.modelOverride?.trim() || null;
  const currentModel = useMemo(
    () => catalog.models.find((m) => m.id === current) ?? null,
    [catalog, current],
  );
  // 档位所依据的模型：选了模型用它；没选用 CLI 告诉我们的默认模型
  const info = current ? currentModel : catalog.defaultModel;
  // CLI 明确说不支持思考深度：不显示滑杆
  const noReasoning = !!info && !info.reasoning;
  // 档位全部来自 CLI：模型自己的 > 目录并集（自定义的未知模型 / 默认模型未知）
  const levels: ReasoningEffort[] = noReasoning
    ? []
    : info?.efforts.length
      ? info.efforts
      : catalogEfforts(catalog);
  const reasoningSupported = levels.length > 0;
  const effort = reasoningSupported
    ? ((tab.reasoningEffort ?? null) as ReasoningEffort | null)
    : null;
  const shown = preview ?? effort;

  const defaultLabel = catalog.defaultModel?.label ?? catalog.defaultModel?.id;
  // 没选模型时显示 CLI 默认用的那个模型名（浮层里再标「默认」）
  const modelLabel = current ? (currentModel?.label ?? current) : (defaultLabel ?? t('默认模型'));
  const shortLabel = effort ? `${modelLabel} · ${effortLabel(effort)}` : modelLabel;
  const backendName = ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME];

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(id);
  }, [note]);

  const run = async (fn: () => Promise<unknown>) => {
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = () => {
    setView('effort');
    setCustomOpen(false);
    setPreview(null);
    setOpen((o) => !o);
  };

  // 选完模型回到滑杆页，接着调档位（与 Codex 一致的「一次选完」）
  const pickModel = (model: string) => {
    setCustomOpen(false);
    setView('effort');
    if (model === (current ?? '')) return;
    void run(() => harnessClient.setTabModel(tab.id, model));
  };

  const pickEffort = (e: ReasoningEffort | null) => {
    setPreview(null);
    if (e === effort) return;
    void run(() => harnessClient.setTabEffort(tab.id, e));
  };

  return (
    <div className={styles.wrap}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.chip} ${!current && !effort ? styles.chipMuted : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('模型与思考深度：{0}', shortLabel)}
        title={t('下一条消息起生效，仅影响当前标签')}
        data-testid="model-chip"
        onClick={toggle}
      >
        <Icon icon={Cpu} size={14} />
        <span className={styles.label}>{shortLabel}</span>
        <Icon icon={ChevronDown} size={12} />
      </button>
      {note && (
        <span className={styles.note} role="status" data-testid="model-chip-note">
          {note}
        </span>
      )}
      {open && (
        <ChipMenu
          btnRef={btnRef}
          menuRef={menuRef}
          onClose={() => setOpen(false)}
          label={t('模型与思考深度')}
          testId="model-menu"
          width={300}
        >
          {view === 'effort' ? (
            <div className={styles.effortView} data-testid="effort-view">
              <div className={styles.effortHead}>
                <span className={styles.effortHeadLabel}>{t('思考深度')}</span>
                {effort && (
                  <button
                    type="button"
                    className={styles.link}
                    data-testid="effort-default"
                    onClick={() => pickEffort(null)}
                  >
                    {t('恢复默认')}
                  </button>
                )}
              </div>
              <div className={styles.effortValue}>
                <span className={styles.effortTitle} data-testid="effort-title" aria-live="polite">
                  {noReasoning
                    ? t('无思考深度')
                    : shown
                      ? effortLabel(shown)
                      : info?.defaultEffort
                        ? t('默认（{0}）', effortLabel(info.defaultEffort))
                        : t('默认')}
                </span>
                <span className={styles.effortHint} data-testid="effort-hint">
                  {noReasoning
                    ? t('这个模型不支持调节思考深度')
                    : !reasoningSupported
                      ? t('{0} 没有提供可选档位，沿用它的默认设置', backendName)
                      : shown
                        ? effortHint(shown)
                        : t('跟随 {0} 默认档位', backendName)}
                </span>
              </div>
              {reasoningSupported && (
                <EffortSlider
                  levels={levels}
                  value={shown}
                  onPreview={setPreview}
                  onCommit={pickEffort}
                />
              )}
              <button
                type="button"
                className={styles.modelRow}
                data-testid="model-open"
                aria-label={t('切换模型：{0}', modelLabel)}
                onClick={() => setView('model')}
              >
                <span className={styles.modelRowLabel}>{t('模型')}</span>
                <span className={styles.modelRowValue}>
                  <span className={styles.modelLinkText}>{modelLabel}</span>
                  {!current && <span className={styles.tag}>{t('默认')}</span>}
                </span>
                <Icon icon={ChevronRight} size={14} />
              </button>
            </div>
          ) : (
            <>
              <div className={styles.modelHead}>
                <button
                  type="button"
                  className={styles.back}
                  data-testid="model-back"
                  onClick={() => setView('effort')}
                >
                  <Icon icon={ChevronLeft} size={14} />
                  {t('模型')}
                </button>
                <button
                  type="button"
                  className={styles.back}
                  data-testid="model-refresh"
                  disabled={refreshing}
                  aria-label={t('重新从 {0} 读取模型列表', backendName)}
                  title={t('重新从 {0} 读取模型列表', backendName)}
                  onClick={onRefresh}
                >
                  <span className={refreshing ? styles.spin : undefined}>
                    <Icon icon={RefreshCw} size={13} />
                  </span>
                </button>
              </div>
              {catalog.error && (
                <div className={styles.modelError} role="status" data-testid="model-error">
                  {t('没能从 {0} 读到模型列表：{1}', backendName, catalog.error)}
                </div>
              )}
              <div className={styles.models} role="listbox" aria-label={t('模型')}>
                <button
                  type="button"
                  role="option"
                  aria-selected={!current}
                  className={styles.item}
                  data-testid="model-default"
                  title={t('跟随 {0} 自己的选择', backendName)}
                  onClick={() => pickModel('')}
                >
                  <span className={styles.itemLabel}>{t('默认模型')}</span>
                  <span className={styles.itemHint}>{defaultLabel ?? backendName}</span>
                  {!current && <Icon icon={Check} size={14} />}
                </button>
                {catalog.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={current === m.id}
                    className={styles.item}
                    data-testid={`model-${m.id}`}
                    title={m.description ? `${m.id} · ${m.description}` : m.id}
                    onClick={() => pickModel(m.id)}
                  >
                    <span className={styles.itemLabel}>{m.label ?? m.id}</span>
                    {!m.reasoning && <span className={styles.itemHint}>{t('无思考深度')}</span>}
                    {current === m.id && <Icon icon={Check} size={14} />}
                  </button>
                ))}
                {current && !currentModel && (
                  <button
                    type="button"
                    role="option"
                    aria-selected
                    className={styles.item}
                    data-testid="model-current-custom"
                    onClick={() => pickModel(current)}
                  >
                    <span className={styles.itemLabel}>{current}</span>
                    <span className={styles.itemHint}>{t('自定义')}</span>
                    <Icon icon={Check} size={14} />
                  </button>
                )}
              </div>
              <div className={styles.custom}>
                {customOpen ? (
                  <form
                    className={styles.customForm}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = customName.trim();
                      if (name) pickModel(name);
                    }}
                  >
                    <input
                      autoFocus
                      className={styles.customInput}
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder={t('模型 id')}
                      aria-label={t('自定义模型 id')}
                      maxLength={128}
                      data-testid="model-custom-input"
                    />
                    <button
                      type="submit"
                      className={styles.link}
                      disabled={!customName.trim()}
                      data-testid="model-custom-ok"
                    >
                      {t('使用')}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className={styles.link}
                    data-testid="model-custom-toggle"
                    onClick={() => {
                      setCustomName(current ?? '');
                      setCustomOpen(true);
                    }}
                  >
                    <Icon icon={PencilLine} size={13} />
                    {t('自定义模型 id')}
                  </button>
                )}
              </div>
            </>
          )}
        </ChipMenu>
      )}
    </div>
  );
};

/**
 * 目录还在从 CLI 读（Claude / Grok 冷启动要一两秒）：先放一个不可点的按钮占位，免得读完才突然冒出来。
 * 不支持切换的后端主进程立刻返回 null，所以只在读取超过一小会儿时才显示，避免一闪而过。
 */
const LoadingChip: React.FC<{ tab: HarnessTabMeta }> = ({ tab }) => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  const label = tab.modelOverride?.trim() || t('默认模型');
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.chip} ${styles.chipMuted}`}
        disabled
        aria-busy="true"
        aria-label={t(
          '正在从 {0} 读取模型列表',
          ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME],
        )}
        data-testid="model-chip-loading"
      >
        <Icon icon={Cpu} size={14} />
        <span className={styles.label}>{label}</span>
        <span className={styles.spin}>
          <Icon icon={RefreshCw} size={12} />
        </span>
      </button>
    </div>
  );
};

/** 输入栏入口：无模型目录的后端不渲染；第三方供应商激活时也不渲染（模型由供应商管理） */
export const ModelControls: React.FC<{ tab: HarnessTabMeta }> = ({ tab }) => {
  const { catalog, refreshing, refresh } = useCatalog(tab.backend);
  const [providers, setProviders] = useState<CliProviderState | null>(null);
  // 供应商状态到之前不渲染，避免按钮先出现再因供应商激活消失
  const [providersReady, setProvidersReady] = useState(() => !cliProviderClient.available());

  useEffect(() => {
    if (!cliProviderClient.available()) return;
    let alive = true;
    const settle = (s: CliProviderState | null) => {
      if (!alive) return;
      setProviders(s);
      setProvidersReady(true);
    };
    void cliProviderClient
      .state()
      .then(settle)
      .catch(() => settle(null));
    const off = cliProviderClient.onChanged(settle);
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (catalog === null || !providersReady) return null;
  if (catalog === undefined) return <LoadingChip tab={tab} />;
  // 第三方供应商激活：模型在供应商 / /model 卡片里管理，避免双入口与 -c/配置文件相互打架
  // （主进程同样不注入覆盖参数，见 CliHarnessService.effectiveOverrides）
  if (tab.backend !== 'nomi' && activeProfileOf(providers, tab.backend as CliProviderKind))
    return null;
  return <ModelChip tab={tab} catalog={catalog} refreshing={refreshing} onRefresh={refresh} />;
};
