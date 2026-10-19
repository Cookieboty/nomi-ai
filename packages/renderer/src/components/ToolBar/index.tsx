import { createLogger, t as tr } from '@nomi-ai/ui';
import { Switch, Tooltip } from '@nomi-ai/ui';
import {
  AudioLines,
  Bot,
  Ellipsis,
  EyeOff,
  Hand,
  Info,
  Mic,
  RotateCcw,
  Settings2,
  UserRound,
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

import {
  loadToolbarPrefs,
  saveToolbarPrefs,
  PALETTES,
  PRIMARY_TOOLS,
  type ToolbarPrefs,
} from './prefs';
import styles from './style.module.css';

import { useMascot } from '@/contexts/MascotContext';
import { useWaifuMessage } from '@/hooks/useWaifuMessage';
import { nextModel } from '@/mascot/catalog';
import { layoutStore, placeGutter, type GutterPlacement } from '@/mascot/layoutStore';
import { closeMascot, useMascotClosable } from '@/mascot/presence';
import { scalePercent, scaleStore, useMascotScale } from '@/mascot/scaleStore';
import { registerSpeechStopper, stopAllSpeech } from '@/mascot/speechStop';
import { MESSAGES } from '@/mascot/tips';
import { MascotMicTool, toggleMascotHandsfree } from '@/mascot/voice/MascotVoice';
import { setCache } from '@/utils/cache';

const log = createLogger('toolbar');

/**
 * 看板娘工具栏。
 * - 柔和配色（磨砂玻璃 + 低饱和强调色，无霓虹辉光），Lucide（ISC）统一图标，@nomi-ai/ui Tooltip。
 * - 独立图层（高于画布），放在角色包围盒旁的“预留槽位”，不压住角色；贴近屏幕边缘时翻到另一侧。
 * - 空闲自动隐藏，光标靠近角色 / 工具栏时出现；可收起为单个「更多」按钮。
 * - 显示时带 data-mascot-ui，点击穿透命中测试（Win/mac elementFromPoint、Linux setShape）都会算上它。
 */

let globalVoiceService: VoiceService | null = null;

/** 光标离角色包围盒多近（px）算“靠近” */
const NEAR_PX = 72;
const HIDE_DELAY_MS = 1500;

const TIP_BAR_WIDTH = 48; // 与样式里的工具栏宽度（按钮 + 内边距）一致，仅用于估算提示的可用宽度

export const ToolBar: React.FC = () => {
  const closable = useMascotClosable();
  const {
    config: { tools: configTools = [] },
    state: mascotState,
    dispatch: mascotDispatch,
    selectModel,
  } = useMascot();
  const { showMessage: say } = useWaifuMessage();
  const showMessage = useCallback(
    (message: string, timeout: number = 4000) => say(message, timeout, 9),
    [say],
  );

  // 默认界面为看板娘时她是进入主界面的入口，不提供「关闭看板娘」
  const availableTools = closable ? configTools : configTools.filter((t) => t !== 'close-mascot');
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [voiceService, setVoiceService] = useState<VoiceService | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceMode, setVoiceMode] = useState<'fixed' | 'tts'>('fixed');
  const [prefs, setPrefs] = useState<ToolbarPrefs>(loadToolbarPrefs);
  const [menuOpen, setMenuOpen] = useState(false);
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
      // 等待electronAPI准备就绪
      const waitForElectronAPI = () => {
        return new Promise<void>((resolve) => {
          const checkAPI = () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
            if ((window as any).electronAPI) {
              resolve();
            } else {
              setTimeout(checkAPI, 100);
            }
          };
          checkAPI();
        });
      };

      try {
        // 等待electronAPI准备就绪
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
    if (!(await closeMascot())) showMessage(tr('关闭看板娘失败，请稍后再试'));
  }, [showMessage]);

  // 拍照功能
  const takeScreenshot = useCallback(() => {
    const canvas = document.querySelector('#mascot-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      showMessage(tr('找不到画布元素，无法截图'));
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

      showMessage(tr('照好了，保存在下载目录了'));
    } catch (error) {
      log.error('截图失败:', error);
      showMessage(tr('截图失败'));
    }
  }, [showMessage]);

  // 显示信息
  // 信息：打开致谢 / Credits（角色、动作与图标的作者和许可）
  const showInfo = useCallback(() => {
    mascotDispatch({ type: 'SET_PANEL', payload: 'credits' });
  }, [mascotDispatch]);

  // 关闭应用
  const quitApp = useCallback(async () => {
    await setCache('waifu-display', Date.now());
    showMessage(tr('再见了，下次见！'), 2000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
    const electronAPI = (window as any).electronAPI;
    if (electronAPI?.quit) {
      setTimeout(() => {
        electronAPI.quit();
      }, 2000);
    }
  }, [showMessage]);

  // 切换到下一个内置角色（右键打开角色列表）
  const switchModel = useCallback(() => {
    const next = nextModel(mascotState.modelList, mascotState.modelName);
    if (!next) {
      showMessage(tr('没有可切换的角色'));
      return;
    }
    selectModel(next.name);
    showMessage(MESSAGES.modelSwitched(next.displayName));
  }, [mascotState.modelList, mascotState.modelName, selectModel, showMessage]);

  const openModelPicker = useCallback(() => {
    mascotDispatch({ type: 'SET_PICKER_OPEN', payload: true });
  }, [mascotDispatch]);

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
      showMessage(tr('语音服务尚未初始化，请稍后再试...'));
      return;
    }

    const newMode = voiceMode === 'fixed' ? 'tts' : 'fixed';

    try {
      // 更新本地状态
      setVoiceMode(newMode);

      // 通过VoiceService保存到Electron配置
      await voiceService.updateSettings({ voiceMode: newMode });

      // 显示切换成功消息
      const modeText = newMode === 'fixed' ? tr('固定语音') : tr('TTS语音');
      showMessage(tr('已切换到{0}模式', modeText));
    } catch (error) {
      log.error('语音模式切换失败:', error);
      showMessage(tr('语音模式切换失败，请重试'));
      // 回滚状态
      setVoiceMode(voiceMode);
    }
  }, [voiceMode, voiceService, showMessage]);

  // 获取工具处理函数
  const getToolHandler = (toolId: string) => {
    switch (toolId) {
      case 'voice-input':
        return () => void toggleMascotHandsfree();
      case 'switch-model':
        return switchModel;
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
            showMessage(tr('语音服务正在初始化中，请稍后再试...'));
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
            showMessage(tr('语音功能已启用！'));
          } else {
            showMessage(tr('语音功能已禁用！'));
          }
        };
      case 'voice-mode-toggle':
        return toggleVoiceMode;
      case 'tts-config':
        return () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
          const electronAPI = (window as any).electronAPI;
          if (electronAPI?.openTTSConfig) {
            electronAPI
              .openTTSConfig()
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
              .then((result: any) => {
                if (result?.success) {
                  showMessage(tr('TTS配置窗口已打开'));
                } else {
                  showMessage(tr('打开失败: {0}', result?.error || tr('未知错误')));
                }
              })
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
              .catch((error: any) => {
                log.error('打开TTS配置窗口失败:', error);
                showMessage(tr('打开TTS配置窗口失败，请稍后再试'));
              });
          } else {
            log.warn('Electron API不可用，无法打开TTS配置窗口');
            showMessage(tr('TTS配置功能需要在Electron环境中运行'));
          }
        };
      case 'ai-chat':
        return () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
          const electronAPI = (window as any).electronAPI;
          if (electronAPI?.openAiChat) {
            electronAPI
              .openAiChat()
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
              .then((result: any) => {
                if (result?.success) {
                  showMessage(tr('AI对话窗口已打开'));
                } else {
                  showMessage(tr('打开失败: {0}', result?.error || tr('未知错误')));
                }
              })
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
              .catch((error: any) => {
                log.error('打开AI对话窗口失败:', error);
                showMessage(tr('打开AI对话窗口失败，请稍后再试'));
              });
          } else {
            log.warn('Electron API不可用，无法打开AI对话窗口');
            showMessage(tr('AI对话功能需要在Electron环境中运行'));
          }
        };
      case 'motion':
        return playRandomMotion;
      default:
        return () => {};
    }
  };

  // ---------- 显示 / 隐藏 ----------
  useEffect(() => {
    const api = window.electronAPI as
      | {
          onWindowMouseEnter?: (cb: () => void) => void;
          onWindowMouseLeave?: (cb: () => void) => void;
          removeWindowMouseListeners?: () => void;
        }
      | undefined;
    if (api?.onWindowMouseEnter) {
      api.onWindowMouseEnter(() => setHoverWin(true));
      api.onWindowMouseLeave?.(() => setHoverWin(false));
      return () => api.removeWindowMouseListeners?.();
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

  // 光标靠近角色或工具栏 → 显示（全局光标轮询，点击穿透状态下同样有效）
  useEffect(
    () =>
      layoutStore.subscribe(({ box, cursor }) => {
        if (!cursor || !cursor.inside) {
          setNear(false);
          return;
        }
        const { x, y } = cursor;
        let n = false;
        if (box)
          n =
            x >= box.left - NEAR_PX &&
            x <= box.right + NEAR_PX &&
            y >= box.top - NEAR_PX &&
            y <= box.bottom + NEAR_PX;
        const r = rootRef.current?.getBoundingClientRect();
        if (!n && r && r.width > 0)
          n = x >= r.left - 32 && x <= r.right + 32 && y >= r.top - 32 && y <= r.bottom + 32;
        setNear(n);
      }),
    [],
  );

  const wantVisible = near || hoverWin || focusWithin || menuOpen || showVoiceSettings;
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
  const secondary = availableTools.filter((t) => !primary.includes(t));
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

  // 菜单纵向位置：尽量与工具栏顶部对齐，但整体留在窗口内（过高时内部滚动）
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuTop, setMenuTop] = useState(0);
  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const h = Math.min(menuRef.current.scrollHeight, window.innerHeight - 16);
    const y0 = place?.y ?? 0;
    const want = Math.max(8, Math.min(window.innerHeight - h - 8, y0));
    setMenuTop(want - y0);
  }, [menuOpen, place, prefs.compact]);

  // ---------- 按钮 ----------
  const toolIcon = (toolId: string): LucideIcon => {
    switch (toolId) {
      case 'ai-chat':
        return Bot;
      case 'voice-input':
        return Mic;
      case 'switch-model':
        return UserRound;
      case 'motion':
        return Hand;
      case 'voice-settings':
        return voiceEnabled ? Volume2 : VolumeX;
      case 'voice-mode-toggle':
        return voiceMode === 'fixed' ? Mic : AudioLines;
      case 'tts-config':
        return Settings2;
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
      case 'switch-model':
        return tr('切换角色（右键：角色列表）');
      case 'photo':
        return tr('截图保存');
      case 'info':
        return tr('致谢 / Credits');
      case 'quit':
        return tr('关闭应用');
      case 'close-mascot':
        return tr('关闭看板娘（可在设置中重新打开）');
      case 'voice-settings':
        return voiceEnabled ? tr('语音：开（右键：语音设置）') : tr('语音：关（右键：语音设置）');
      case 'voice-mode-toggle':
        return voiceMode === 'fixed' ? tr('语音模式：固定语音') : tr('语音模式：TTS');
      case 'tts-config':
        return tr('TTS 语音配置');
      case 'ai-chat':
        return tr('AI 对话');
      case 'voice-input':
        return tr('免按键语音：开/关（工具栏麦克风按住说话）');
      case 'motion':
        return tr('做个动作');
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
      : toolId === 'switch-model'
        ? (e: React.MouseEvent) => {
            e.preventDefault();
            openModelPicker();
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
          className={`${styles.btn} ${toolId === 'quit' ? styles.danger : ''}`}
          id={`waifu-tool-${toolId}`}
          data-testid={`tool-${toolId}`}
          aria-label={label}
          aria-pressed={pressed(toolId)}
          onClick={() => handler()}
          onContextMenu={onContext(toolId)}
        >
          <Icon size={19} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
    );
  };

  const menuItem = (toolId: string) => {
    const Icon = toolIcon(toolId);
    const label = toolLabel(toolId);
    const handler = getToolHandler(toolId);
    return (
      <button
        key={toolId}
        type="button"
        role="menuitem"
        className={`${styles.menuItem} ${toolId === 'quit' ? styles.danger : ''}`}
        id={`waifu-tool-${toolId}`}
        data-testid={`tool-${toolId}`}
        aria-pressed={pressed(toolId)}
        onClick={() => {
          setMenuOpen(false);
          handler();
        }}
        onContextMenu={onContext(toolId)}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        <span>{label.replace(/（右键：.*）$/, '')}</span>
      </button>
    );
  };

  const style: React.CSSProperties & Record<string, string | number> = {
    ...(place ? { left: place.x, top: place.y } : { right: 8, top: '30%' }),
    '--tb-tip-max': `${tipMax}px`,
  };

  return (
    <>
      <div
        ref={rootRef}
        className={`${styles.root} ${visible ? styles.shown : styles.hidden}`}
        data-palette={prefs.palette}
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
          aria-label={tr('Nomi 工具栏')}
          aria-orientation="vertical"
        >
          {primary.map(iconButton)}
          {primary.length > 0 && secondary.length > 0 && <div className={styles.sep} aria-hidden />}
          <Tooltip content={menuOpen ? tr('收起') : tr('更多')} placement={tipSide}>
            <button
              type="button"
              className={styles.btn}
              data-testid="tool-more"
              aria-label={tr('更多')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Ellipsis size={19} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        </div>

        {menuOpen && (
          <div
            className={styles.menu}
            role="menu"
            aria-label={tr('更多工具')}
            data-testid="toolbar-menu"
            ref={menuRef}
            style={{ top: menuTop }}
          >
            {secondary.map(menuItem)}
            <div className={styles.sep} aria-hidden />
            <div className={styles.menuRow}>
              <span>{tr('收起为单个按钮')}</span>
              <Switch
                checked={prefs.compact}
                onChange={(v: boolean) => updatePrefs({ compact: v })}
                aria-label={tr('收起为单个按钮')}
                data-testid="toolbar-compact"
              />
            </div>
            {size && (
              <div className={styles.menuRow} role="group" aria-label={tr('看板娘大小')}>
                <span>{tr('大小')}</span>
                <div className={styles.sizeCtl}>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    aria-label={tr('缩小')}
                    title={tr('缩小')}
                    data-testid="toolbar-zoom-out"
                    disabled={size.scale <= size.min + 1e-6}
                    onClick={() => scaleStore.step(-1)}
                  >
                    <ZoomOut size={15} strokeWidth={1.75} aria-hidden />
                  </button>
                  <span className={styles.sizeValue} data-testid="toolbar-scale-value">
                    {scalePercent(size.scale)}%
                  </span>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    aria-label={tr('放大')}
                    title={tr('放大')}
                    data-testid="toolbar-zoom-in"
                    disabled={size.scale >= size.max - 1e-6}
                    onClick={() => scaleStore.step(1)}
                  >
                    <ZoomIn size={15} strokeWidth={1.75} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    aria-label={tr('重置大小')}
                    title={tr('重置大小')}
                    data-testid="toolbar-zoom-reset"
                    disabled={Math.abs(size.scale - size.default) < 1e-6}
                    onClick={() => scaleStore.reset()}
                  >
                    <RotateCcw size={15} strokeWidth={1.75} aria-hidden />
                  </button>
                </div>
              </div>
            )}
            <div className={styles.menuRow}>
              <span>{tr('配色')}</span>
              <div className={styles.swatches} role="radiogroup" aria-label={tr('工具栏配色')}>
                {PALETTES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={prefs.palette === p.id}
                    aria-label={tr(p.label)}
                    title={tr(p.label)}
                    data-testid={`toolbar-palette-${p.id}`}
                    className={styles.swatch}
                    style={{ background: p.swatch }}
                    onClick={() => updatePrefs({ palette: p.id })}
                  />
                ))}
              </div>
            </div>
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
