/**
 * 输入栏的「模型」与「思考深度」芯片（仅官方账号 / CLI 后端：Codex / Claude Code / Grok）。
 *
 * 交互参考 Codex：模型与思考深度是两个独立维度；
 * - 模型芯片：跟随 CLI 默认，或选目录内模型 / 填自定义模型 id；
 * - 思考芯片：只在推理模型上出现（非推理模型隐藏）；「默认」= 不发覆盖参数。
 * 覆盖是标签级的，主进程在每轮启动时以进程级参数注入
 * （codex `-c model=...`、grok `-m ... --reasoning-effort ...`、claude `--model ... --effort ...`），
 * 不改写用户的全局 CLI 配置；每轮新进程的后端下一条消息即生效，Claude 长驻进程空闲时重启复用。
 */
import { Icon, t } from '@nomi-ai/ui';
import { Brain, Check, ChevronDown, Cpu, PencilLine } from 'lucide-react';
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
  type ReasoningEffort,
} from '../../services/harnessClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { activeProfileOf } from '../CliProviderChip';

import styles from './index.module.css';

/** 档位并集（顺序即由浅到深）；菜单只渲染后端目录支持的子集 */
const ALL_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
    case 'max':
      return t('最深，最慢也最耗额度');
  }
}

/** 主进程返回的目录做结构校验：无效 / 空后端一律当作「不支持」 */
function validCatalog(c: unknown): BackendModelCatalog | null {
  if (!c || typeof c !== 'object') return null;
  const cat = c as Partial<BackendModelCatalog>;
  if (typeof cat.backend !== 'string' || !Array.isArray(cat.models)) return null;
  if (!cat.models.every((m) => m && typeof m.id === 'string')) return null;
  return cat as BackendModelCatalog;
}

/** 拉取某个后端的模型目录（无目录 = 不支持切换，芯片整体不渲染） */
function useCatalog(backend: string): BackendModelCatalog | null {
  const [catalog, setCatalog] = useState<BackendModelCatalog | null>(null);
  useEffect(() => {
    let alive = true;
    void harnessClient
      .modelCatalog(backend as HarnessTabMeta['backend'])
      .then((c) => {
        if (alive) setCatalog(validCatalog(c));
      })
      .catch(() => {
        if (alive) setCatalog(null);
      });
    return () => {
      alive = false;
    };
  }, [backend]);
  return catalog;
}

/** 芯片菜单的通用外壳：挂 body、fixed、向上弹，避免输入栏 overflow 裁剪 */
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
      role="menu"
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  );
};

const ChipButton: React.FC<{
  btnRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onToggle: () => void;
  label: string;
  shortLabel: string;
  icon: React.ReactNode;
  testId: string;
  muted?: boolean;
}> = ({ btnRef, open, onToggle, label, shortLabel, icon, testId, muted }) => (
  <button
    ref={btnRef}
    type="button"
    className={`${styles.chip} ${muted ? styles.chipMuted : ''}`}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={t('下一条消息起生效，仅影响当前标签')}
    data-testid={testId}
    onClick={onToggle}
  >
    {icon}
    <span className={styles.label}>{shortLabel}</span>
    <Icon icon={ChevronDown} size={12} />
  </button>
);

/** 模型芯片 */
const ModelChip: React.FC<{ tab: HarnessTabMeta; catalog: BackendModelCatalog }> = ({
  tab,
  catalog,
}) => {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = tab.modelOverride?.trim() || null;
  const currentModel = useMemo(
    () => catalog.models.find((m) => m.id === current) ?? null,
    [catalog, current],
  );
  const shortLabel = current ? (currentModel?.label ?? current) : t('默认模型');
  const backendName = ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME];

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(id);
  }, [note]);

  const apply = async (model: string) => {
    setNote(null);
    try {
      await harnessClient.setTabModel(tab.id, model);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const pick = (model: string) => {
    setOpen(false);
    setCustomOpen(false);
    btnRef.current?.focus();
    void apply(model);
  };

  return (
    <div className={styles.wrap}>
      <ChipButton
        btnRef={btnRef}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        label={t('模型：{0}', shortLabel)}
        shortLabel={shortLabel}
        icon={<Icon icon={Cpu} size={14} />}
        testId="model-chip"
        muted={!current}
      />
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
          label={t('模型')}
          testId="model-menu"
          width={320}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!current}
            className={styles.item}
            data-testid="model-default"
            onClick={() => pick('')}
          >
            <span className={styles.itemIcon}>
              <Icon icon={Cpu} size={15} />
            </span>
            <span className={styles.itemText}>
              <span className={styles.itemLabel}>{t('默认模型')}</span>
              <span className={styles.itemHint}>{t('跟随 {0} 自己的选择', backendName)}</span>
            </span>
            {!current && <Icon icon={Check} size={14} />}
          </button>
          {catalog.models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={current === m.id}
              disabled={m.deprecated}
              className={styles.item}
              data-testid={`model-${m.id}`}
              onClick={() => pick(m.id)}
            >
              <span className={styles.itemIcon}>
                <Icon icon={Cpu} size={15} />
              </span>
              <span className={styles.itemText}>
                <span className={styles.itemLabel}>{m.label ?? m.id}</span>
                {!m.reasoning && <span className={styles.itemHint}>{t('无思考深度')}</span>}
              </span>
              {current === m.id && <Icon icon={Check} size={14} />}
            </button>
          ))}
          <div className={styles.foot}>
            {customOpen ? (
              <form
                className={styles.customForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = customName.trim();
                  if (name) pick(name);
                }}
              >
                <input
                  autoFocus
                  className={styles.customInput}
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={t('模型 id，如 gpt-5.4-codex')}
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
        </ChipMenu>
      )}
    </div>
  );
};

/** 思考深度芯片：仅推理模型出现（无模型覆盖 = 沿用 CLI 默认推理模型，同样显示） */
const EffortChip: React.FC<{ tab: HarnessTabMeta; catalog: BackendModelCatalog }> = ({
  tab,
  catalog,
}) => {
  const model = tab.modelOverride?.trim() || null;
  const meta = model ? (catalog.models.find((m) => m.id === model) ?? null) : null;
  // 目录内显式标记为非推理的模型：不渲染；未知自定义模型默认当作推理模型（主进程兜底校验）
  const reasoningSupported = !meta || meta.reasoning !== false;
  // 档位集：模型专属 > 后端档位集 > 并集兜底（主进程仍做最终校验）
  const levels: ReasoningEffort[] = meta?.efforts?.length
    ? meta.efforts
    : (catalog.efforts ?? ALL_EFFORTS);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = tab.reasoningEffort ?? null;
  const shortLabel = current ? effortLabel(current as ReasoningEffort) : t('思考默认');
  const backendName = ENDPOINT_NAME[tab.backend as keyof typeof ENDPOINT_NAME];

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(id);
  }, [note]);

  if (!reasoningSupported) return null;

  const apply = async (e: ReasoningEffort | null) => {
    setNote(null);
    try {
      await harnessClient.setTabEffort(tab.id, e);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.wrap}>
      <ChipButton
        btnRef={btnRef}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        label={t('思考深度：{0}', shortLabel)}
        shortLabel={shortLabel}
        icon={<Icon icon={Brain} size={14} />}
        testId="effort-chip"
        muted={!current}
      />
      {note && (
        <span className={styles.note} role="status" data-testid="effort-chip-note">
          {note}
        </span>
      )}
      {open && (
        <ChipMenu
          btnRef={btnRef}
          menuRef={menuRef}
          onClose={() => setOpen(false)}
          label={t('思考深度')}
          testId="effort-menu"
          width={300}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!current}
            className={styles.item}
            data-testid="effort-default"
            onClick={() => {
              setOpen(false);
              btnRef.current?.focus();
              void apply(null);
            }}
          >
            <span className={styles.itemIcon}>
              <Icon icon={Brain} size={15} />
            </span>
            <span className={styles.itemText}>
              <span className={styles.itemLabel}>{t('默认')}</span>
              <span className={styles.itemHint}>{t('跟随 {0} 默认档位', backendName)}</span>
            </span>
            {!current && <Icon icon={Check} size={14} />}
          </button>
          {levels.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitemradio"
              aria-checked={current === e}
              className={styles.item}
              data-testid={`effort-${e}`}
              onClick={() => {
                setOpen(false);
                btnRef.current?.focus();
                void apply(e);
              }}
            >
              <span className={styles.itemIcon}>
                <Icon icon={Brain} size={15} />
              </span>
              <span className={styles.itemText}>
                <span className={styles.itemLabel}>{effortLabel(e)}</span>
                <span className={styles.itemHint}>{effortHint(e)}</span>
              </span>
              {current === e && <Icon icon={Check} size={14} />}
            </button>
          ))}
        </ChipMenu>
      )}
    </div>
  );
};

/** 输入栏入口：无模型目录的后端不渲染；第三方供应商档案激活时也不渲染（模型由档案管理） */
export const ModelControls: React.FC<{ tab: HarnessTabMeta }> = ({ tab }) => {
  const catalog = useCatalog(tab.backend);
  const [providers, setProviders] = useState<CliProviderState | null>(null);

  useEffect(() => {
    if (!cliProviderClient.available()) return;
    let alive = true;
    void cliProviderClient
      .state()
      .then((s) => alive && setProviders(s))
      .catch(() => alive && setProviders(null));
    const off = cliProviderClient.onChanged((s) => alive && setProviders(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!catalog) return null;
  // 第三方档案激活：模型在档案 / /model 卡片里管理，避免双入口与 -c/配置文件相互打架
  if (tab.backend !== 'nomi' && activeProfileOf(providers, tab.backend as CliProviderKind))
    return null;
  return (
    <>
      <ModelChip tab={tab} catalog={catalog} />
      <EffortChip tab={tab} catalog={catalog} />
    </>
  );
};
