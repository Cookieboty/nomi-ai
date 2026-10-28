import { layoutStore } from '@nomi-ai/avatar-runtime';
import { brand } from '@nomi-ai/types';
import { createLogger, t as tr } from '@nomi-ai/ui';
import { Switch, Tooltip } from '@nomi-ai/ui';
import {
  AudioLines,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  EyeOff,
  Hand,
  Info,
  MessageCircleMore,
  Mic,
  RotateCcw,
  Sparkle,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { VoiceService } from '../../services/VoiceService';
import { VoiceSettings } from '../VoiceSettings';

import { placeGutter, type GutterPlacement } from './gutter';
import {
  loadToolbarPrefs,
  saveToolbarPrefs,
  PRIMARY_TOOLS,
  TOOLBAR_STYLES,
  type ToolbarPrefs,
} from './prefs';
import styles from './style.module.css';

import { useMascot } from '@/contexts/MascotContext';
import { useCompanionMessage } from '@/hooks/useCompanionMessage';
import { characterName } from '@/mascot/characterCopy';
import { closeMascot } from '@/mascot/presence';
import { scalePercent, scaleStore, useMascotScale } from '@/mascot/scaleStore';
import { registerSpeechStopper, stopAllSpeech } from '@/mascot/speechStop';
import { MascotMicTool, toggleMascotHandsfree } from '@/mascot/voice/MascotVoice';
import { CLIP_HINTS } from '@/mascot/voice/promptClips';
import { api, hasTransport } from '@/services/api';
import { setCache } from '@/utils/cache';

const log = createLogger('toolbar');

/**
 * 看板娘工具栏（设计稿「Nomi 桌面 AI 伙伴」）。
 * - 竖向胶囊：AI 对话（主按钮，橙色）/ 语音交互 / 任务看板 / 角色互动 / 声音设置 / 更多；
 *   四种样式（深色胶囊默认、浅色胶囊、毛玻璃、极简），Lucide（ISC）统一图标。
 * - 提示：深色两行（标题 + 说明，文本里用换行分隔，第一行加粗）。
 * - 点「更多」展开完整功能面板（Nomi 标题 + 关闭，图标 + 标题 + 说明）；面板里「更多」再展开设置 / 大小 / 样式。
 * - 光标只是靠近时不出现，悬停到角色 / 工具栏上才展开；离开 250ms 后收起，动效约 180ms。
 * - 独立图层（高于画布），放在角色包围盒旁的“预留槽位”，不压住角色；贴近屏幕边缘时翻到另一侧。
 * - 显示时带 data-mascot-ui，点击穿透命中测试（Win/mac elementFromPoint、Linux setShape）都会算上它。
 */

let globalVoiceService: VoiceService | null = null;

/** 光标在角色包围盒外多远（px）仍算悬停：只是靠近不展开（设计稿 01），悬停到角色上才展开（03） */
const NEAR_PX = 0;
/** 离开后延迟收起（设计稿：200–300ms） */
const HIDE_DELAY_MS = 250;
/** 工具栏与角色的间距：看板娘左右各留 60px，44 宽的胶囊 + 8 间距 + 6 边距放得下，靠右时能翻到左边 */
const BAR_GAP = 8;

/** 工具的标题与一行说明（提示 = 标题\n说明；面板行 = 标题 + 说明） */
const TOOL_META: Record<string, { title: () => string; desc: () => string }> = {
  'ai-chat': {
    title: () => tr('ui.voice-mascot.ai-chat'),
    desc: () => tr('ui.voice-mascot.chat-with-nomi', characterName()),
  },
  'voice-input': {
    title: () => tr('ui.voice-mascot.voice'),
    desc: () => tr('ui.voice-mascot.voice-input-output'),
  },
  'task-board': {
    title: () => tr('ui.voice-mascot.task-board'),
    desc: () => tr('ui.voice-mascot.view-and-manage-your-tasks'),
  },
  motion: {
    title: () => tr('ui.voice-mascot.interact'),
    desc: () => tr('ui.voice-mascot.motions-expressions-play'),
  },
  'voice-settings': {
    title: () => tr('ui.voice-mascot.sound'),
    desc: () => tr('ui.voice-mascot.volume-mute-voice-preferences'),
  },
  more: {
    title: () => tr('ui.voice-mascot.more'),
    desc: () => tr('ui.voice-mascot.settings-size-quit'),
  },
};

const TIP_BAR_WIDTH = 44;
/** 功能面板：常规宽度、与窗口边缘的距离、低于这个窗口高度时用紧凑排版 */
const PANEL_W = 236;
const PANEL_MARGIN = 6;
const PANEL_DENSE_H = 420; // 与样式里的工具栏宽度（按钮 + 内边距）一致，仅用于估算提示的可用宽度

export const ToolBar: React.FC = () => {
  const {
    config: { tools: configTools = [] },
    dispatch: mascotDispatch,
  } = useMascot();
  const { showMessage: say } = useCompanionMessage();
  const showMessage = useCallback(
    (message: string, timeout: number = 4000, clip?: string) =>
      say(message, timeout, 9, false, clip ? { clip } : {}),
    [say],
  );

  // 「关闭看板娘」随时可用（#55）：默认界面为看板娘时主进程会改为主界面并打开它
  const availableTools = configTools;
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [voiceService, setVoiceService] = useState<VoiceService | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceMode, setVoiceMode] = useState<'fixed' | 'tts'>('fixed');
  const [prefs, setPrefs] = useState<ToolbarPrefs>(loadToolbarPrefs);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 面板里「更多」一行是否展开（设置 / 大小 / 样式 / 其余工具） */
  const [moreOpen, setMoreOpen] = useState(false);
  const size = useMascotScale();
  const [near, setNear] = useState(false);
  const [hoverWin, setHoverWin] = useState(process.env.NODE_ENV === 'development');
  const [focusWithin, setFocusWithin] = useState(false);
  const [place, setPlace] = useState<GutterPlacement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [visible, setVisible] = useState(process.env.NODE_ENV === 'development');

  const updatePrefs = useCallback((patch: Partial<ToolbarPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      saveToolbarPrefs(next);
      return next;
    });
  }, []);

  // 初始化语音服务
  useEffect(() => {
    const initVoiceService = async () => {
      // 等待主进程桥（契约传输）准备就绪
      const waitForElectronAPI = () => {
        return new Promise<void>((resolve) => {
          const checkAPI = () => {
            if (hasTransport()) {
              resolve();
            } else {
              setTimeout(checkAPI, 100);
            }
          };
          checkAPI();
        });
      };

      try {
        // 等待主进程桥准备就绪
        await waitForElectronAPI();

        // 延迟一点时间确保所有API都完全加载
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 创建VoiceService实例
        if (!globalVoiceService) {
          globalVoiceService = new VoiceService();
          const svc = globalVoiceService;
          registerSpeechStopper(() => svc.stop());

          // 等待VoiceService初始化完成
          await globalVoiceService.waitForInit();
        }

        // 设置到状态中
        setVoiceService(globalVoiceService);

        // 获取VoiceService中的实际设置状态
        const actualSettings = globalVoiceService.getSettings();
        const actualEnabled = actualSettings?.enabled ?? false;
        const actualVoiceMode = actualSettings?.voiceMode ?? 'fixed';

        // 同步UI状态和实际状态
        setVoiceEnabled(actualEnabled);
        setVoiceMode(actualVoiceMode as 'fixed' | 'tts');
      } catch (error) {
        log.error('初始化语音服务失败:', error);
        // 即使失败也要设置状态，避免组件卡住
        setVoiceService(globalVoiceService);
        setVoiceEnabled(false);
      }
    };

    initVoiceService();
  }, []);

  // 关闭看板娘：隐藏窗口并停止语音（应用继续运行），在主界面「设置 → 通用」里可重新打开
  const hideMascot = useCallback(async () => {
    stopAllSpeech();
    if (!(await closeMascot()))
      showMessage(
        tr('ui.voice-mascot.couldn-t-close-nomi-please-try-again-later', characterName()),
      );
  }, [showMessage]);

  // 拍照功能
  const takeScreenshot = useCallback(() => {
    const canvas = document.querySelector('#mascot-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      showMessage(tr('ui.voice-mascot.canvas-not-found-can-t-take-a-screenshot'));
      return;
    }

    try {
      const imageUrl = canvas.toDataURL();
      const link = document.createElement('a');
      link.style.display = 'none';
      link.href = imageUrl;
      link.download = 'mascot-photo.png';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      showMessage(tr('ui.voice-mascot.got-it-saved-to-your-downloads-folder'));
    } catch (error) {
      log.error('截图失败:', error);
      showMessage(tr('ui.voice-mascot.screenshot-failed'));
    }
  }, [showMessage]);

  // 显示信息
  // 信息：打开致谢 / Credits（角色、动作与图标的作者和许可）
  const showInfo = useCallback(() => {
    mascotDispatch({ type: 'SET_PANEL', payload: 'credits' });
  }, [mascotDispatch]);

  // 关闭应用
  const quitApp = useCallback(async () => {
    await setCache('companion-display', Date.now());
    showMessage(tr('ui.voice-mascot.bye-see-you-next-time'), 2000);

    if (hasTransport()) {
      setTimeout(() => {
        void api.window.quit().catch((error: unknown) => log.error('退出应用失败:', error));
      }, 2000);
    }
  }, [showMessage]);

  // 动作：左键随机播放一个动作，右键打开动作菜单
  const playRandomMotion = useCallback(() => {
    window.dispatchEvent(new CustomEvent('mascot:motion', { detail: { name: 'random' } }));
  }, []);

  const openMotionMenu = useCallback(() => {
    mascotDispatch({ type: 'SET_PANEL', payload: 'motions' });
  }, [mascotDispatch]);

  // 切换语音模式（保存到应用配置）
  // 新手引导选择声音风格时开关语音（与工具栏按钮状态同步）
  useEffect(() => {
    const on = (e: Event) => {
      const enabled = Boolean((e as CustomEvent<{ enabled?: boolean }>).detail?.enabled);
      if (!globalVoiceService) return;
      void globalVoiceService.updateSettings({ enabled });
      setVoiceEnabled(enabled);
    };
    window.addEventListener('mascot:voice-enabled', on);
    return () => window.removeEventListener('mascot:voice-enabled', on);
  }, []);

  // 语音设置变化（含主进程回滚：模型下载失败 / 取消 / 删除）→ 同步按钮状态
  useEffect(() => {
    const on = (e: Event) => {
      const enabled = (e as CustomEvent<{ enabled?: boolean }>).detail?.enabled;
      if (typeof enabled === 'boolean') setVoiceEnabled(enabled);
    };
    window.addEventListener('mascot:voice-settings', on);
    return () => window.removeEventListener('mascot:voice-settings', on);
  }, []);

  const toggleVoiceMode = useCallback(async () => {
    if (!voiceService) {
      showMessage(tr('ui.voice-mascot.the-voice-service-isn-t-ready-yet-please'));
      return;
    }

    const newMode = voiceMode === 'fixed' ? 'tts' : 'fixed';

    try {
      // 更新本地状态
      setVoiceMode(newMode);

      // 通过VoiceService保存到Electron配置
      await voiceService.updateSettings({ voiceMode: newMode });

      // 显示切换成功消息
      const modeText =
        newMode === 'fixed' ? tr('ui.voice-mascot.fixed-voice') : tr('ui.voice-mascot.tts-voice');
      showMessage(
        tr('ui.voice-mascot.switched-to-mode', modeText),
        4000,
        newMode === 'fixed' ? CLIP_HINTS.modeFixed : CLIP_HINTS.modeTts,
      );
    } catch (error) {
      log.error('语音模式切换失败:', error);
      showMessage(tr('ui.voice-mascot.failed-to-switch-voice-mode-please-try-again'));
      // 回滚状态
      setVoiceMode(voiceMode);
    }
  }, [voiceMode, voiceService, showMessage]);

  // 获取工具处理函数
  const getToolHandler = (toolId: string) => {
    switch (toolId) {
      case 'voice-input':
        return () => void toggleMascotHandsfree();
      case 'photo':
        return takeScreenshot;
      case 'info':
        return showInfo;
      case 'quit':
        return quitApp;
      case 'close-mascot':
        return () => void hideMascot();
      case 'voice-settings':
        return () => {
          // 如果VoiceService还没有初始化，显示提示
          if (!voiceService) {
            showMessage(tr('ui.voice-mascot.the-voice-service-is-initializing-please-try-again'));
            return;
          }

          // 切换语音启用状态
          const newEnabled = !voiceEnabled;

          // 立即更新UI状态
          setVoiceEnabled(newEnabled);

          // 更新VoiceService中的设置
          voiceService.updateSettings({ enabled: newEnabled });

          // 显示消息
          if (newEnabled) {
            showMessage(tr('ui.voice-mascot.voice-enabled'));
          } else {
            showMessage(tr('ui.voice-mascot.voice-disabled'));
          }
        };
      case 'voice-mode-toggle':
        return toggleVoiceMode;
      case 'ai-chat':
        return () => {
          if (hasTransport()) {
            api.window
              .openAiChat()
              .then((result) => {
                if (result?.success) {
                  showMessage(tr('ui.voice-mascot.ai-chat-window-opened'));
                } else {
                  showMessage(
                    tr(
                      'ui.voice-mascot.couldn-t-open',
                      result?.error || tr('ui.voice-mascot.unknown-error'),
                    ),
                    4000,
                    CLIP_HINTS.openFailed,
                  );
                }
              })
              .catch((error: unknown) => {
                log.error('打开AI对话窗口失败:', error);
                showMessage(tr('ui.voice-mascot.couldn-t-open-the-ai-chat-window-please'));
              });
          } else {
            log.warn('Electron API不可用，无法打开AI对话窗口');
            showMessage(tr('ui.voice-mascot.ai-chat-requires-the-electron-environment'));
          }
        };
      case 'motion':
        return playRandomMotion;
      case 'task-board':
        return () => {
          if (!hasTransport()) {
            showMessage(tr('ui.voice-mascot.the-task-board-opens-in-the-desktop-app'));
            return;
          }
          void api.window
            .openTaskBoard()
            .then((r) => {
              if (!r?.success)
                showMessage(
                  tr(
                    'ui.voice-mascot.couldn-t-open',
                    r?.error || tr('ui.voice-mascot.unknown-error'),
                  ),
                  4000,
                  CLIP_HINTS.openFailed,
                );
            })
            .catch((error: unknown) => {
              log.error('打开任务看板失败:', error);
              showMessage(tr('ui.voice-mascot.couldn-t-open-the-task-board-please-try'));
            });
        };
      default:
        return () => {};
    }
  };

  // ---------- 显示 / 隐藏 ----------
  useEffect(() => {
    if (hasTransport()) {
      const offEnter = api.on('window.mouseEnter', () => setHoverWin(true));
      const offLeave = api.on('window.mouseLeave', () => setHoverWin(false));
      return () => {
        offEnter();
        offLeave();
      };
    }
    const on = () => setHoverWin(true);
    const off = () => setHoverWin(false);
    document.addEventListener('mouseenter', on);
    document.addEventListener('mouseleave', off);
    return () => {
      document.removeEventListener('mouseenter', on);
      document.removeEventListener('mouseleave', off);
    };
  }, []);

  // 光标悬停在角色或工具栏上 → 显示
  const hitTest = useCallback((x: number, y: number): boolean => {
    const box = layoutStore.get().box;
    if (
      box &&
      x >= box.left - NEAR_PX &&
      x <= box.right + NEAR_PX &&
      y >= box.top - NEAR_PX &&
      y <= box.bottom + NEAR_PX
    )
      return true;
    const r = rootRef.current?.getBoundingClientRect();
    return (
      !!r &&
      r.width > 0 &&
      x >= r.left - 32 &&
      x <= r.right + 32 &&
      y >= r.top - 32 &&
      y <= r.bottom + 32
    );
  }, []);
  // 全局光标轮询：点击穿透状态下收不到 DOM 事件时也有效
  useEffect(
    () =>
      layoutStore.subscribe(({ cursor }) => {
        setNear(!!cursor?.inside && hitTest(cursor.x, cursor.y));
      }),
    [hitTest],
  );
  // DOM 指针：窗口接收鼠标时比轮询更及时
  const [nearDom, setNearDom] = useState(false);
  useEffect(() => {
    const move = (e: PointerEvent) => setNearDom(hitTest(e.clientX, e.clientY));
    const leave = () => setNearDom(false);
    document.addEventListener('pointermove', move);
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      document.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, [hitTest]);

  // 全局光标可用时只看「是否悬停在角色 / 工具栏上」；拿不到光标（浏览器预览）时退回窗口悬停
  const cursorTracked = layoutStore.get().cursor != null;
  const wantVisible =
    near || nearDom || (hoverWin && !cursorTracked) || focusWithin || menuOpen || showVoiceSettings;
  useEffect(() => {
    clearTimeout(hideTimer.current);
    // 悬浮状态变化时立即显隐工具栏；外部交互驱动的派生状态，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (wantVisible) setVisible(true);
    else hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
    return () => clearTimeout(hideTimer.current);
  }, [wantVisible]);

  // 菜单打开时 Esc / 点外面关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  // ---------- 布局：角色旁的预留槽位 ----------
  const primary = prefs.compact ? [] : PRIMARY_TOOLS.filter((t) => availableTools.includes(t));
  // 「更多」里的其余工具：主按钮以外的（收起为单按钮时主按钮也在面板主行里，不重复）
  const secondary = availableTools.filter((t) => !PRIMARY_TOOLS.includes(t));
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const compute = () => {
      const bar = barRef.current;
      const bw = bar?.offsetWidth || 44;
      const bh = bar?.offsetHeight || 200;
      const force = (
        window as unknown as {
          __cdForceToolbarScreen?: { winX: number; availLeft: number; availWidth: number };
        }
      ).__cdForceToolbarScreen;
      const p = placeGutter({
        gap: BAR_GAP,
        box: layoutStore.get().box,
        bar: { width: bw, height: bh },
        view: { width: window.innerWidth, height: window.innerHeight },
        screen: force ?? {
          winX: window.screenX,
          availLeft: (window.screen as Screen & { availLeft?: number }).availLeft ?? 0,
          availWidth: window.screen.availWidth,
        },
      });
      layoutStore.setGutter({ left: p.x, right: p.x + bw, top: p.y, bottom: p.y + bh });
      setPlace((prev) =>
        prev && prev.side === p.side && Math.abs(prev.x - p.x) < 6 && Math.abs(prev.y - p.y) < 6
          ? prev
          : p,
      );
    };
    compute();
    const off = layoutStore.subscribe(compute);
    const t = setInterval(compute, 700); // 窗口被拖动 / 物理移动后检查是否贴边
    window.addEventListener('resize', compute);
    return () => {
      off();
      clearInterval(t);
      window.removeEventListener('resize', compute);
    };
  }, [primary.length]);

  useEffect(() => {
    const el = rootRef.current;
    if (el) {
      el.dataset.side = place?.side ?? 'right';
      document.documentElement.dataset.toolbarSide = place?.side ?? 'right';
      document.documentElement.dataset.toolbarVisible = visible ? '1' : '0';
    }
  }, [place, visible]);

  // 面板位置：贴着工具栏朝角色一侧展开，整体留在窗口内（过高时内部滚动）。
  // 看板娘缩小时窗口只有约 250px 宽：放不下就盖住工具栏，并改用紧凑排版（只留标题）。
  const menuRef = useRef<HTMLDivElement>(null);
  const [panelBox, setPanelBox] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    dense: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(PANEL_W, vw - 2 * PANEL_MARGIN);
    const dense = vh < PANEL_DENSE_H || width < PANEL_W;
    const maxHeight = vh - 2 * PANEL_MARGIN;
    const h = Math.min(menuRef.current?.scrollHeight ?? maxHeight, maxHeight);
    const barX = place?.x ?? vw - TIP_BAR_WIDTH - PANEL_MARGIN;
    const want = place?.side === 'left' ? barX + TIP_BAR_WIDTH + BAR_GAP : barX - BAR_GAP - width;
    const left = Math.max(PANEL_MARGIN, Math.min(vw - PANEL_MARGIN - width, want));
    const top = Math.max(PANEL_MARGIN, Math.min(vh - PANEL_MARGIN - h, place?.y ?? 0));
    setPanelBox((b) =>
      b &&
      b.left === left &&
      b.top === top &&
      b.width === width &&
      b.maxHeight === maxHeight &&
      b.dense === dense
        ? b
        : { left, top, width, maxHeight, dense },
    );
  }, [menuOpen, moreOpen, place, prefs.compact, size?.scale]);

  // ---------- 按钮 ----------
  const toolIcon = (toolId: string): LucideIcon => {
    switch (toolId) {
      case 'ai-chat':
        return MessageCircleMore;
      case 'voice-input':
        return Mic;
      case 'task-board':
        return CalendarCheck;
      case 'motion':
        return Hand;
      case 'voice-settings':
        return voiceEnabled ? Volume2 : VolumeX;
      case 'voice-mode-toggle':
        return voiceMode === 'fixed' ? Mic : AudioLines;
      case 'close-mascot':
        return EyeOff;
      case 'info':
        return Info;
      case 'quit':
        return X;
      default:
        return Ellipsis;
    }
  };

  const toolLabel = (toolId: string): string => {
    switch (toolId) {
      case 'photo':
        return tr('ui.voice-mascot.save-screenshot');
      case 'info':
        return tr('ui.chat-settings.credits');
      case 'quit':
        return tr('ui.voice-mascot.quit-app');
      case 'close-mascot':
        return tr('ui.voice-mascot.close-nomi-reopen-it-in-settings', characterName());
      case 'voice-settings':
        return voiceEnabled
          ? [
              tr('ui.voice-mascot.sound-on'),
              tr('ui.voice-mascot.click-to-mute-right-click-for-voice-preferences'),
            ].join('\n')
          : [
              tr('ui.voice-mascot.sound-off'),
              tr('ui.voice-mascot.click-to-unmute-right-click-for-voice-preferences'),
            ].join('\n');
      case 'voice-mode-toggle':
        return voiceMode === 'fixed'
          ? tr('ui.voice-mascot.voice-mode-fixed-voice')
          : tr('ui.voice-mascot.voice-mode-tts');
      case 'ai-chat':
      case 'task-board':
        return `${TOOL_META[toolId]!.title()}\n${TOOL_META[toolId]!.desc()}`;
      case 'voice-input':
        return tr('ui.voice-mascot.hands-free-voice-on-off-hold-the-toolbar');
      case 'motion':
        return [
          tr('ui.voice-mascot.interact'),
          tr('ui.voice-mascot.do-a-motion-right-click-to-pick-one'),
        ].join('\n');
      default:
        return toolId;
    }
  };

  const pressed = (toolId: string): boolean | undefined => {
    if (toolId === 'voice-settings') return voiceEnabled;
    return undefined;
  };

  const onContext = (toolId: string) =>
    toolId === 'voice-settings'
      ? (e: React.MouseEvent) => {
          e.preventDefault();
          setShowVoiceSettings(true);
        }
      : toolId === 'motion'
        ? (e: React.MouseEvent) => {
            e.preventDefault();
            openMotionMenu();
          }
        : undefined;

  // Tooltips open toward the mascot (left of the vertical bar when bar is on the right).
  const tipSide = place?.side === 'left' ? 'right' : 'left';
  // 提示的可用宽度 = 工具栏到窗口边缘的距离；超出就换行，不被窗口边缘裁掉
  const tipMax = place
    ? Math.max(
        96,
        tipSide === 'left' ? place.x - 10 : window.innerWidth - (place.x + TIP_BAR_WIDTH) - 10,
      )
    : 200;

  const iconButton = (toolId: string) => {
    if (toolId === 'voice-input')
      return <MascotMicTool key={toolId} className={styles.btn} tipSide={tipSide} />;
    const Icon = toolIcon(toolId);
    const label = toolLabel(toolId);
    const handler = getToolHandler(toolId);
    return (
      <Tooltip key={toolId} content={label} placement={tipSide}>
        <button
          type="button"
          className={`${styles.btn} ${toolId === 'ai-chat' ? styles.primary : ''} ${toolId === 'quit' ? styles.danger : ''}`}
          id={`companion-tool-${toolId}`}
          data-testid={`tool-${toolId}`}
          aria-label={label.split('\n')[0]}
          aria-pressed={pressed(toolId)}
          onClick={() => handler()}
          onContextMenu={onContext(toolId)}
        >
          <Icon size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
    );
  };

  // 「更多」里的其余工具：一行一个（图标 + 名称）
  const menuItem = (toolId: string) => {
    const Icon = toolIcon(toolId);
    const label = toolLabel(toolId);
    const handler = getToolHandler(toolId);
    return (
      <button
        key={toolId}
        type="button"
        role="menuitem"
        className={`${styles.subItem} ${toolId === 'quit' ? styles.danger : ''}`}
        id={`companion-tool-${toolId}`}
        data-testid={`tool-${toolId}`}
        aria-pressed={pressed(toolId)}
        title={label}
        onClick={() => {
          setMenuOpen(false);
          handler();
        }}
        onContextMenu={onContext(toolId)}
      >
        <Icon size={15} strokeWidth={1.75} aria-hidden />
        <span>{label.split('\n')[0].replace(/（[^）]*）$/, '')}</span>
      </button>
    );
  };

  // 面板主行（设计稿 05）：点一下执行并收起面板
  const panelAction = (toolId: string) => {
    switch (toolId) {
      case 'voice-input':
        return () => void toggleMascotHandsfree();
      case 'motion':
        return openMotionMenu;
      case 'voice-settings':
        return () => setShowVoiceSettings(true);
      default:
        return getToolHandler(toolId);
    }
  };
  const panelRows = PRIMARY_TOOLS.filter((id) => availableTools.includes(id));
  const panelRow = (toolId: string) => {
    const Icon = toolIcon(toolId);
    const meta = TOOL_META[toolId]!;
    return (
      <button
        key={toolId}
        type="button"
        role="menuitem"
        className={styles.row}
        data-testid={`panel-${toolId}`}
        onClick={() => {
          setMenuOpen(false);
          panelAction(toolId)();
        }}
      >
        <span className={`${styles.rowIcon} ${toolId === 'ai-chat' ? styles.rowIconPrimary : ''}`}>
          <Icon size={16} strokeWidth={1.75} aria-hidden />
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{meta.title()}</span>
          <span className={styles.rowDesc}>{meta.desc()}</span>
        </span>
        <ChevronRight size={14} strokeWidth={1.75} className={styles.rowChevron} aria-hidden />
      </button>
    );
  };

  const style: React.CSSProperties & Record<string, string | number> = {
    ...(place ? { left: place.x, top: place.y } : { right: 8, top: '30%' }),
    '--tb-tip-max': `${tipMax}px`,
  };

  const moreButton = (
    <button
      type="button"
      className={styles.btn}
      data-testid="tool-more"
      aria-label={menuOpen ? tr('ui.knowledge-local.collapse') : tr('ui.voice-mascot.more')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={() => {
        setMoreOpen(false);
        setMenuOpen((v) => !v);
      }}
    >
      <Ellipsis size={18} strokeWidth={1.75} aria-hidden />
    </button>
  );

  return (
    <>
      <div
        ref={rootRef}
        // 面板打开时不再弹工具提示（会压在面板上 / 从面板后露出来）
        className={`${styles.root} ${visible ? styles.shown : styles.hidden} ${menuOpen ? styles.tipOff : ''}`}
        data-style={prefs.style}
        data-testid="mascot-toolbar"
        data-mascot-ui={visible ? '' : undefined}
        style={style}
        onFocus={(e) => {
          // 只有键盘焦点（:focus-visible）才让工具栏保持显示；鼠标点击留下的焦点不算
          setFocusWithin((e.target as HTMLElement).matches(':focus-visible'));
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocusWithin(false);
        }}
      >
        <div
          ref={barRef}
          className={styles.bar}
          role="toolbar"
          aria-label={tr('ui.voice-mascot.nomi-toolbar', characterName())}
          aria-orientation="vertical"
        >
          {primary.map(iconButton)}
          <Tooltip
            content={`${TOOL_META.more!.title()}\n${TOOL_META.more!.desc()}`}
            placement={tipSide}
          >
            {moreButton}
          </Tooltip>
        </div>

        {menuOpen && (
          <div
            className={styles.panel}
            role="menu"
            aria-label={tr('ui.voice-mascot.nomi-panel', characterName())}
            data-testid="toolbar-menu"
            ref={menuRef}
            data-dense={panelBox?.dense ? '' : undefined}
            style={
              panelBox
                ? {
                    left: panelBox.left,
                    top: panelBox.top,
                    width: panelBox.width,
                    maxHeight: panelBox.maxHeight,
                  }
                : { visibility: 'hidden' }
            }
          >
            <div className={styles.panelHead}>
              <span className={styles.brand}>
                {brand.appName}
                <Sparkle size={11} strokeWidth={2.2} className={styles.brandMark} aria-hidden />
              </span>
              <button
                type="button"
                className={styles.panelClose}
                aria-label={tr('ui.providers-schedule.close')}
                data-testid="toolbar-menu-close"
                onClick={() => setMenuOpen(false)}
              >
                <X size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
            {panelRows.map(panelRow)}
            <button
              type="button"
              role="menuitem"
              className={styles.row}
              data-testid="panel-more"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span className={styles.rowIcon}>
                <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
              </span>
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>{TOOL_META.more!.title()}</span>
                <span className={styles.rowDesc}>{TOOL_META.more!.desc()}</span>
              </span>
              {moreOpen ? (
                <ChevronDown
                  size={14}
                  strokeWidth={1.75}
                  className={styles.rowChevron}
                  aria-hidden
                />
              ) : (
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  className={styles.rowChevron}
                  aria-hidden
                />
              )}
            </button>
            {moreOpen && (
              <div className={styles.more} data-testid="panel-more-section">
                {secondary.map(menuItem)}
                <div className={styles.sep} aria-hidden />
                <div className={styles.menuRow}>
                  <span>{tr('ui.voice-mascot.collapse-to-a-single-button')}</span>
                  <Switch
                    checked={prefs.compact}
                    onChange={(v: boolean) => updatePrefs({ compact: v })}
                    aria-label={tr('ui.voice-mascot.collapse-to-a-single-button')}
                    data-testid="toolbar-compact"
                  />
                </div>
                {size && (
                  <div
                    className={styles.menuRow}
                    role="group"
                    aria-label={tr('ui.usage-tools.nomi-size')}
                  >
                    <span>{tr('ui.usage-tools.size')}</span>
                    <div className={styles.sizeCtl}>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        aria-label={tr('ui.usage-tools.zoom-out')}
                        title={tr('ui.usage-tools.zoom-out')}
                        data-testid="toolbar-zoom-out"
                        disabled={size.scale <= size.min + 1e-6}
                        onClick={() => scaleStore.step(-1)}
                      >
                        <ZoomOut size={14} strokeWidth={1.75} aria-hidden />
                      </button>
                      <span className={styles.sizeValue} data-testid="toolbar-scale-value">
                        {scalePercent(size.scale)}%
                      </span>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        aria-label={tr('ui.usage-tools.zoom-in')}
                        title={tr('ui.usage-tools.zoom-in')}
                        data-testid="toolbar-zoom-in"
                        disabled={size.scale >= size.max - 1e-6}
                        onClick={() => scaleStore.step(1)}
                      >
                        <ZoomIn size={14} strokeWidth={1.75} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={styles.miniBtn}
                        aria-label={tr('ui.usage-tools.reset-size')}
                        title={tr('ui.usage-tools.reset-size')}
                        data-testid="toolbar-zoom-reset"
                        disabled={Math.abs(size.scale - size.default) < 1e-6}
                        onClick={() => scaleStore.reset()}
                      >
                        <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
                      </button>
                    </div>
                  </div>
                )}
                <div className={styles.menuRow}>
                  <span>{tr('ui.voice-mascot.toolbar-style')}</span>
                  <div
                    className={styles.swatches}
                    role="radiogroup"
                    aria-label={tr('ui.voice-mascot.toolbar-style')}
                  >
                    {TOOLBAR_STYLES.map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        role="radio"
                        aria-checked={prefs.style === st.id}
                        aria-label={tr(st.label)}
                        title={tr(st.label)}
                        data-testid={`toolbar-style-${st.id}`}
                        className={styles.swatch}
                        data-swatch={st.id}
                        style={{ background: st.swatch }}
                        onClick={() => updatePrefs({ style: st.id })}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {voiceService && (
        <VoiceSettings
          voiceService={voiceService}
          isVisible={showVoiceSettings}
          onClose={() => setShowVoiceSettings(false)}
          onSettingsChange={() =>
            setVoiceEnabled(globalVoiceService?.getSettings()?.enabled ?? false)
          }
        />
      )}
    </>
  );
};
