/**
 * 设置 → 通用 → 外观 → 主题：一个色卡网格放内置主题与我的主题（自定义 / 主题包），点选即时生效。
 *
 * - 标题行右侧：跟随系统开关、新建主题、导入主题包（弹窗：拖入 / 选择文件 / 下载模板）；
 * - 网格：我的主题 → 内置主题，默认一行，其余收进「更多主题」；
 * - 网格下方是选中主题的设置：图片主题选图与蒙版，自定义主题编辑 / 导出 / 删除；
 * - 新建与编辑在右侧抽屉里（CustomThemeEditor）。
 */
import {
  Button,
  Icon,
  ModalHostContext,
  SettingRow,
  Switch,
  THEMES,
  currentTheme,
  customThemeName,
  customThemePref,
  customThemeSwatch,
  getLocale,
  isAdaptiveTheme,
  isCustomThemePref,
  otherBase,
  setTheme,
  t as tr,
  type CustomThemeDef,
  type SeedKey,
  type ThemeInfo,
  type ThemePref,
  type ThemeState,
} from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Image,
  Palette,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { hostAssetUrl } from '../../services/api';
import {
  chatBgErrorMessage,
  chatBgStyle,
  getChatBackground,
  pickChatBackgroundImage,
  subscribeChatBackground,
  type ChatBackgroundState,
} from '../../services/chatBackground';
import {
  deleteCustomTheme,
  exportThemePack,
  listCustomThemes,
  themeErrorText,
} from '../../services/customThemes';
import { confirmDialog } from '../ConfirmDialog';

import { ChatBackgroundSettings } from './ChatBackgroundSettings';
import { CustomThemeEditor } from './CustomThemeEditor';
import styles from './index.module.css';
import { ThemeImportDialog } from './ThemeImportDialog';

/** 默认只显示一行（5 个），其余点「更多主题」展开 */
export const THEMES_FIRST_ROW = 5;

export type ThemeItem =
  | { kind: 'builtin'; id: ThemePref; info: ThemeInfo }
  | { kind: 'custom'; id: ThemePref; def: CustomThemeDef };

/**
 * 排序：我的主题在前（始终露在第一行）→ 内置主题（THEMES 顺序，不含「跟随系统」，它是标题行的开关）；
 * 当前选的不在第一行时挪到第一行最后一个，这样收起时也看得到选中的是哪个。
 */
export function orderThemes(pref: ThemePref, customs: CustomThemeDef[] = []): ThemeItem[] {
  const items: ThemeItem[] = [
    ...customs.map((def): ThemeItem => ({ kind: 'custom', id: customThemePref(def.id), def })),
    ...THEMES.filter((x) => x.id !== 'system').map((info): ThemeItem => ({
      kind: 'builtin',
      id: info.id,
      info,
    })),
  ];
  const i = items.findIndex((x) => x.id === pref);
  if (i < THEMES_FIRST_ROW) return items;
  const [picked] = items.splice(i, 1);
  items.splice(THEMES_FIRST_ROW - 1, 0, picked!);
  return items;
}

/** 当前主题的显示名（品牌卡速览也用） */
export function themeLabel(cur: ThemeState): string {
  if (cur.custom && isCustomThemePref(cur.pref)) return customThemeName(cur.custom, getLocale());
  const def = THEMES.find((x) => x.id === cur.pref);
  if (cur.pref === 'system')
    return tr(
      'ui.chat-settings.system',
      cur.resolved === 'cream'
        ? tr('ui.mascot-theme.cream-short')
        : tr('ui.chat-settings.graphite'),
    );
  return def ? tr(def.name) : cur.pref;
}

/** 自定义主题的一句话说明：自定义主题 · 跟随系统切换两套 · 带背景图 */
function customThemeDesc(def: CustomThemeDef): string {
  return [
    tr('ui.chat-settings.theme-custom-desc'),
    isAdaptiveTheme(def) ? tr('ui.chat-settings.theme-trait-adaptive') : null,
    def.background ? tr('ui.chat-settings.theme-trait-background') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function useThemeState(): ThemeState {
  const [cur, setCur] = useState<ThemeState>(currentTheme);
  useEffect(() => {
    const on = (e: Event) => setCur((e as CustomEvent<ThemeState>).detail);
    window.addEventListener('cd:theme-changed', on);
    return () => window.removeEventListener('cd:theme-changed', on);
  }, []);
  return cur;
}

/**
 * 图片主题还没有任何图片（预设缺失且未选图）时先弹选图，选到了才切主题，避免切到无图的空深色。
 * 选图失败返回给用户看的错误文案，否则返回 null。
 */
export async function selectTheme(
  id: ThemePref,
  background: ChatBackgroundState,
): Promise<string | null> {
  if (id === 'image' && !background.imageUrl) {
    let picked: ChatBackgroundState;
    try {
      picked = await pickChatBackgroundImage();
    } catch (error) {
      return chatBgErrorMessage(error);
    }
    if (!picked.imageUrl) return null;
  }
  await setTheme(id);
  return null;
}

/** 新建主题的起点：当前主题的色卡（自定义主题用它自己的种子） */
function startSeedsOf(cur: ThemeState): Record<SeedKey, string> {
  const swatch = cur.custom
    ? customThemeSwatch(cur.custom)
    : (THEMES.find((x) => x.id === cur.resolved) ?? THEMES[0]!).swatch;
  const [background, surface, text, accent] = swatch;
  return { accent, background, surface, text };
}

const cssUrl = (url: string) => `url("${hostAssetUrl(url).replace(/"/g, '\\"')}")`;

/** 编辑器以右侧抽屉打开（设置页里的 Modal 默认内嵌） */
const DRAWER_HOST = { mode: 'drawer' as const };

type EditorState = { initial: CustomThemeDef | null } | null;
const SYSTEM = THEMES.find((x) => x.id === 'system')!;
/** testId：图片主题选图失败沿用 theme-image-error */
type Notice = { text: string; error: boolean; testId?: string } | null;

export const ThemeSettings: React.FC = () => {
  const cur = useThemeState();
  const lang = getLocale();
  const [background, setBackground] = useState<ChatBackgroundState>(getChatBackground);
  useEffect(() => subscribeChatBackground(setBackground), []);
  const [customs, setCustoms] = useState<CustomThemeDef[]>([]);
  const reload = useCallback(
    () => void listCustomThemes().then(setCustoms, () => setCustoms([])),
    [],
  );
  useEffect(reload, [reload]);

  const [notice, setNotice] = useState<Notice>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const following = cur.pref === 'system';

  // 列表变了、或收起时选中变了（新建 / 导入后切过去）才重排，让选中的露在第一行；
  // 展开时点选不重排（不让卡片在手下跳）
  const [orderPref, setOrderPref] = useState(cur.pref);
  if (!expanded && orderPref !== cur.pref) setOrderPref(cur.pref);
  const ordered = useMemo(() => orderThemes(orderPref, customs), [orderPref, customs]);
  const hiddenCount = Math.max(0, ordered.length - THEMES_FIRST_ROW);
  const shown = expanded ? ordered : ordered.slice(0, THEMES_FIRST_ROW);

  const builtin = THEMES.find((x) => x.id === cur.pref);
  const active = customs.find((x) => cur.pref === customThemePref(x.id)) ?? null;
  const description = active
    ? customThemeDesc(active)
    : builtin
      ? builtin.id === 'system'
        ? tr(
            'ui.chat-settings.current',
            tr(builtin.desc),
            cur.resolved === 'cream'
              ? tr('ui.mascot-theme.cream-short')
              : tr('ui.chat-settings.graphite'),
          )
        : tr(builtin.desc)
      : undefined;

  const fail = (key: string) => (e: unknown) =>
    setNotice({ text: tr(key, themeErrorText(e)), error: true });

  const pick = (item: ThemeItem) => {
    setNotice(null);
    if (item.kind === 'custom') return void setTheme(item.id);
    void selectTheme(item.id, background).then((err) =>
      setNotice(err ? { text: err, error: true, testId: 'theme-image-error' } : null),
    );
  };

  const onImported = (def: CustomThemeDef) => {
    setImporting(false);
    reload();
    setNotice({
      text: tr('ui.chat-settings.theme-imported', customThemeName(def, lang)),
      error: false,
    });
    void setTheme(customThemePref(def.id));
  };

  /** 关掉跟随系统时停在当前看到的那套（浅色 / 深色） */
  const setFollowing = (on: boolean) => {
    setNotice(null);
    void setTheme(on ? 'system' : cur.resolved);
  };

  const onExport = (def: CustomThemeDef) =>
    void exportThemePack(def.id).then((path) => {
      if (path) setNotice({ text: tr('ui.knowledge-local.exported-to-path', path), error: false });
    }, fail('ui.knowledge-local.export-failed'));

  const onDelete = async (def: CustomThemeDef) => {
    const ok = await confirmDialog({
      title: tr('ui.chat-settings.delete-theme-title', customThemeName(def, lang)),
      message: tr('ui.chat-settings.delete-theme-message'),
      confirmLabel: tr('ui.foundation.delete'),
      danger: true,
    });
    if (!ok) return;
    deleteCustomTheme(def.id).then(() => {
      setNotice(null);
      reload();
    }, fail('ui.chat-settings.theme-delete-failed'));
  };

  return (
    <div className={styles.themeBlock} data-testid="theme-settings" id="settings-theme">
      <SettingRow title={tr('ui.chat-settings.theme')} description={description}>
        <div className={styles.themeHeaderActions}>
          <label className={styles.followSystem} title={tr(SYSTEM.desc)}>
            <Switch
              checked={following}
              onChange={setFollowing}
              aria-label={tr(SYSTEM.name)}
              data-testid="theme-follow-system"
            />
            {tr(SYSTEM.name)}
          </label>
          <Button size="sm" onClick={() => setEditor({ initial: null })} data-testid="theme-new">
            <Icon icon={Plus} size={14} />
            {tr('ui.chat-settings.new-theme')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setImporting(true)}
            data-testid="theme-import"
          >
            <Icon icon={Upload} size={14} />
            {tr('ui.chat-settings.import-theme-pack')}
          </Button>
        </div>
      </SettingRow>

      <div
        className={styles.themes}
        role="radiogroup"
        aria-label={tr('ui.chat-settings.theme')}
        id="settings-theme-options"
      >
        {shown.map((item) => (
          <ThemeCard
            key={item.id}
            item={item}
            on={cur.pref === item.id}
            background={background}
            lang={lang}
            onPick={() => pick(item)}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className={styles.themeMore}
          aria-expanded={expanded}
          aria-controls="settings-theme-options"
          onClick={() => setExpanded((v) => !v)}
          data-testid="theme-more"
        >
          {expanded
            ? tr('ui.knowledge-local.collapse')
            : tr('ui.chat-settings.more-themes', String(hiddenCount))}
          <Icon icon={expanded ? ChevronUp : ChevronDown} size={14} />
        </button>
      )}

      {active && (
        <SettingRow
          title={customThemeName(active, lang)}
          description={tr('ui.chat-settings.theme-custom-actions-desc')}
          data-testid="custom-theme-actions"
        >
          <div className={styles.themeHeaderActions}>
            <Button
              size="sm"
              onClick={() => setEditor({ initial: active })}
              data-testid="theme-edit"
            >
              <Icon icon={Pencil} size={14} />
              {tr('ui.foundation.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onExport(active)}
              data-testid="theme-export"
            >
              <Icon icon={Download} size={14} />
              {tr('ui.chat-settings.export-theme-pack')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onDelete(active)}
              data-testid="theme-delete"
            >
              <Icon icon={Trash2} size={14} />
              {tr('ui.foundation.delete')}
            </Button>
          </div>
        </SettingRow>
      )}
      {cur.pref === 'image' && <ChatBackgroundSettings />}

      {notice && (
        <div
          className={notice.error ? styles.warn : styles.themeNotice}
          role={notice.error ? 'alert' : 'status'}
          data-testid={notice.testId ?? 'theme-notice'}
        >
          {notice.text}
        </div>
      )}

      {importing && (
        <ThemeImportDialog onClose={() => setImporting(false)} onImported={onImported} />
      )}
      {editor && (
        <ModalHostContext.Provider value={DRAWER_HOST}>
          <CustomThemeEditor
            initial={editor.initial}
            startSeeds={startSeedsOf(cur)}
            onClose={() => setEditor(null)}
            onSaved={() => {
              setEditor(null);
              setNotice(null);
              reload();
            }}
          />
        </ModalHostContext.Provider>
      )}
    </div>
  );
};

/** 一张主题色卡：内置主题按 swatch 画；自定义主题按种子画，跟随系统的左右各一套，带图的显示背景图 */
const ThemeCard: React.FC<{
  item: ThemeItem;
  on: boolean;
  background: ChatBackgroundState;
  lang: string;
  onPick: () => void;
}> = ({ item, on, background, lang, onPick }) => {
  let swatch: [string, string, string, string];
  let label: string;
  let title: string;
  let previewImage = 'none';
  let split: string | null = null;
  const isImage = item.kind === 'builtin' && item.id === 'image';
  if (item.kind === 'builtin') {
    swatch = item.info.swatch;
    label = tr(item.info.name);
    title = tr(item.info.desc);
  } else {
    const { def } = item;
    swatch = customThemeSwatch(def);
    label = customThemeName(def, lang);
    title = `${label} · ${customThemeDesc(def)}`;
    if (def.background) previewImage = cssUrl(def.background.image);
    else if (isAdaptiveTheme(def)) split = customThemeSwatch(def, otherBase(def.base))[0];
  }
  const [bg, surface, text, accent] = swatch;
  if (split) previewImage = `linear-gradient(110deg, ${bg} 50%, ${split} 50%)`;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      title={title}
      className={`${styles.theme} ${on ? styles.themeOn : ''}`}
      onClick={onPick}
      data-testid={item.kind === 'custom' ? `theme-custom-${item.def.id}` : `theme-${item.id}`}
    >
      <span
        className={styles.themePreview}
        style={{
          ...(isImage ? chatBgStyle(background) : {}),
          backgroundColor: bg,
          borderColor: surface,
          backgroundImage: previewImage,
        }}
        aria-hidden
        data-testid={isImage ? 'theme-bg-preview' : undefined}
      >
        {isImage && background.imageUrl && (
          <span className={styles.themeImageLayers}>
            <span className="chat-bg-image" data-testid="theme-bg-image" />
            <span className="chat-bg-mask" data-testid="theme-bg-mask" />
          </span>
        )}
        {isImage && !background.imageUrl ? (
          <span className={styles.themeImagePlaceholder}>
            <Icon icon={Image} size={24} />
          </span>
        ) : (
          <span
            style={{
              background: isImage ? `color-mix(in srgb, ${surface} 55%, transparent)` : surface,
            }}
            className={styles.themeCard}
          >
            <span style={{ background: text }} className={styles.themeLine} />
            <span style={{ background: text, opacity: 0.45 }} className={styles.themeLine} />
            <span style={{ background: accent }} className={styles.themeDot} />
          </span>
        )}
        {on && (
          <span className={styles.themeCheck}>
            <Icon icon={Check} size={12} />
          </span>
        )}
      </span>
      <span className={styles.themeName}>
        {item.kind === 'custom' && (
          <Icon icon={Palette} size={12} className={styles.themeNameIcon} />
        )}
        {label}
      </span>
    </button>
  );
};
