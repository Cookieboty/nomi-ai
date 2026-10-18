import { mkAiPreload } from '@nomi-ai/ai-sdk-client/preload';
import { type DesktopBubble, type IpcApi } from '@nomi-ai/types';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// 挂载 ai IPC 桥：`window.aiIPC.invoke/on/off` 走白名单校验的 `ai:` 通道。
// 与旧 `electronAPI` 并存；ai-sdk-client 的 ClientAIClient 会自动查找 `window.aiIPC`。
mkAiPreload({ contextBridge, ipcRenderer });

// 向渲染进程暴露安全的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 退出应用
  quit: () => {
    ipcRenderer.send('quit-app');
  },
  // 设置窗口置顶
  setAlwaysOnTop: (flag: boolean) => {
    ipcRenderer.send('set-always-on-top', flag);
  },
  // 移动窗口
  moveWindow: (deltaX: number, deltaY: number) => {
    ipcRenderer.send('move-window', deltaX, deltaY);
  },
  // 获取窗口位置
  getPosition: async () => {
    return await ipcRenderer.invoke('get-position');
  },
  // 设置窗口位置
  setPosition: (x: number, y: number) => {
    try {
      // 确保参数是数字并转为整数
      const intX = Math.round(Number(x) || 0);
      const intY = Math.round(Number(y) || 0);
      ipcRenderer.send('set-position', intX, intY);
    } catch (err) {
      console.error('设置位置参数错误:', err);
    }
  },
  // 保存当前模型
  saveModel: (modelName: string) => {
    ipcRenderer.send('save-model', modelName);
  },
  // 获取保存的模型
  getSavedModel: async () => {
    return await ipcRenderer.invoke('get-saved-model');
  },
  // 获取鼠标位置
  getCursorPosition: async () => {
    return await ipcRenderer.invoke('get-cursor-position');
  },
  // 监听窗口鼠标事件
  /** 桌面能力：确认气泡 / 对话框、拖文件到看板娘 */
  desktop: {
    onConfirmRequest: (cb: (req: unknown) => void) => {
      const l = (_: unknown, r: unknown) => cb(r);
      ipcRenderer.on('desktop:confirm-request', l);
      return () => {
        ipcRenderer.removeListener('desktop:confirm-request', l);
      };
    },
    onConfirmCancel: (cb: (id: string) => void) => {
      const l = (_: unknown, id: string) => cb(id);
      ipcRenderer.on('desktop:confirm-cancel', l);
      return () => {
        ipcRenderer.removeListener('desktop:confirm-cancel', l);
      };
    },
    onBubble: (cb: (p: DesktopBubble) => void) => {
      const l = (_: unknown, p: DesktopBubble) => cb(p);
      ipcRenderer.on('desktop:bubble', l);
      return () => {
        ipcRenderer.removeListener('desktop:bubble', l);
      };
    },
    onReminder: (cb: (p: unknown) => void) => {
      const l = (_: unknown, p: unknown) => cb(p);
      ipcRenderer.on('desktop:reminder', l);
      return () => {
        ipcRenderer.removeListener('desktop:reminder', l);
      };
    },
    takeMissedReminders: () => ipcRenderer.invoke('desktop:reminders-missed'),
    reminderAction: (id: string, action: 'dismiss' | 'snooze', minutes?: number) =>
      ipcRenderer.send('desktop:reminder-action', id, action, minutes),
    answer: (id: string, allow: boolean, remember: boolean) =>
      ipcRenderer.send('desktop:confirm-answer', id, allow, remember),
    /** 只接受真实拖入的 File：路径由 Electron 从 File 对象解析，渲染层不能伪造任意路径字符串 */
    dropFile: (file: File) => {
      const p = webUtils.getPathForFile(file);
      if (p) ipcRenderer.send('desktop:drop-file', p);
      return !!p;
    },
  },
  /** 桌面互动：点击穿透 / 拖拽 / 物理 / 全局光标 */
  mascotWindow: {
    platform: process.platform,
    setShape: (rects: unknown) => ipcRenderer.send('mascot:shape', rects),
    setHit: (hit: boolean) => ipcRenderer.send('mascot:hit', hit),
    setGeometry: (box: unknown) => ipcRenderer.send('mascot:geometry', box),
    dragStart: (sx?: number, sy?: number) => ipcRenderer.send('mascot:drag-start', sx, sy),
    dragMove: (sx: number, sy: number) => ipcRenderer.send('mascot:drag-move', sx, sy),
    dragEnd: () => ipcRenderer.send('mascot:drag-end'),
    setConfig: (cfg: unknown) => ipcRenderer.send('mascot:interaction-config', cfg),
    wanderNow: () => ipcRenderer.send('mascot:wander-now'),
    /** 大小：读取 / 设置 / 步进（±1）/ 滚轮（累计 deltaY）/ 重置 */
    scaleGet: () => ipcRenderer.invoke('mascot:scale-get'),
    scaleSet: (scale: number) => ipcRenderer.invoke('mascot:scale-set', scale),
    scaleStep: (dir: 1 | -1) => ipcRenderer.invoke('mascot:scale-step', dir),
    scaleWheel: (deltaY: number, deltaMode?: number) =>
      ipcRenderer.invoke('mascot:scale-wheel', deltaY, deltaMode),
    scaleReset: () => ipcRenderer.invoke('mascot:scale-reset'),
    onScale: (cb: (s: unknown) => void) => {
      const l = (_: unknown, s: unknown) => cb(s);
      ipcRenderer.on('mascot:scale-changed', l);
      return () => {
        ipcRenderer.removeListener('mascot:scale-changed', l);
      };
    },
    snapshot: () => ipcRenderer.invoke('mascot:debug-snapshot'),
    onCursor: (cb: (p: unknown) => void) => {
      const l = (_: unknown, p: unknown) => cb(p);
      ipcRenderer.on('mascot:cursor', l);
      return () => {
        ipcRenderer.removeListener('mascot:cursor', l);
      };
    },
    onBody: (cb: (p: unknown) => void) => {
      const l = (_: unknown, p: unknown) => cb(p);
      ipcRenderer.on('mascot:body', l);
      return () => {
        ipcRenderer.removeListener('mascot:body', l);
      };
    },
    onPhysicsEvent: (cb: (p: unknown) => void) => {
      const l = (_: unknown, p: unknown) => cb(p);
      ipcRenderer.on('mascot:physics-event', l);
      return () => {
        ipcRenderer.removeListener('mascot:physics-event', l);
      };
    },
  },
  /** 模型注册表 / 商店 / 用户导入 */
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    storeState: (refresh?: boolean) => ipcRenderer.invoke('models:store-state', refresh),
    install: (id: string) => ipcRenderer.invoke('models:install', id),
    cancel: (id: string) => ipcRenderer.invoke('models:cancel', id),
    remove: (id: string) => ipcRenderer.invoke('models:remove', id),
    importVrm: (filePath?: string, config?: unknown) =>
      ipcRenderer.invoke('models:import-vrm', filePath, config),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    replaceVrm: (id: string, filePath?: string) =>
      ipcRenderer.invoke('models:replace-vrm', id, filePath),
    updateConfig: (id: string, config: unknown) =>
      ipcRenderer.invoke('models:update-config', id, config),
    exportConfig: (id: string) => ipcRenderer.invoke('models:export-config', id),
    importConfig: (id: string, json?: string) =>
      ipcRenderer.invoke('models:import-config', id, json),
    onProgress: (cb: (p: unknown) => void) => {
      const l = (_: unknown, p: unknown) => cb(p);
      ipcRenderer.on('models:progress', l);
      return () => {
        ipcRenderer.removeListener('models:progress', l);
      };
    },
    onChanged: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on('models:changed', l);
      return () => {
        ipcRenderer.removeListener('models:changed', l);
      };
    },
  },
  /** Auto-update (GitHub Releases via electron-updater) */
  updates: {
    get: () => ipcRenderer.invoke('updates:get'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    setAutoCheck: (on: boolean) => ipcRenderer.invoke('updates:set-auto-check', on),
    onChanged: (cb: (s: unknown) => void) => {
      const l = (_: unknown, s: unknown) => cb(s);
      ipcRenderer.on('updates:changed', l);
      return () => {
        ipcRenderer.removeListener('updates:changed', l);
      };
    },
  },
  /** 主进程 → 看板娘指令（AI 工具 / 托盘：播放动作、切换表情）。返回取消订阅函数。 */
  onMascotCommand: (callback: (cmd: unknown) => void) => {
    const listener = (_: unknown, cmd: unknown) => callback(cmd);
    ipcRenderer.on('mascot:command', listener);
    return () => {
      ipcRenderer.removeListener('mascot:command', listener);
    };
  },
  onWindowMouseEnter: (callback: () => void) => {
    ipcRenderer.on('window-mouse-enter', callback);
  },
  onWindowMouseLeave: (callback: () => void) => {
    ipcRenderer.on('window-mouse-leave', callback);
  },
  // 移除窗口鼠标事件监听
  removeWindowMouseListeners: () => {
    ipcRenderer.removeAllListeners('window-mouse-enter');
    ipcRenderer.removeAllListeners('window-mouse-leave');
  },

  // 语音相关API - 简化后只保留必要的
  getVoiceSettings: async () => {
    return await ipcRenderer.invoke('get-voice-settings');
  },
  saveVoiceSettings: (settings: any) => {
    ipcRenderer.send('save-voice-settings', settings);
  },

  // AI对话相关API
  openAiChat: async () => {
    return await ipcRenderer.invoke('open-ai-chat');
  },

  // TTS配置相关API
  openTTSConfig: async () => {
    return await ipcRenderer.invoke('open-tts-config');
  },
  getTTSConfig: async () => {
    return await ipcRenderer.invoke('getTTSConfig');
  },
  saveTTSConfig: async (config: any) => {
    return await ipcRenderer.invoke('saveTTSConfig', config);
  },
  testTTSConnection: async (config: any) => {
    return await ipcRenderer.invoke('testTTSConnection', config);
  },
  resetTTSConfig: async () => {
    return await ipcRenderer.invoke('resetTTSConfig');
  },
  ttsSpeak: async (req: { text: string; referenceId?: string; volume?: number }) => {
    return await ipcRenderer.invoke('tts:speak', req);
  },
  ttsHealth: async (config?: unknown) => {
    return await ipcRenderer.invoke('tts:health', config);
  },
  ttsSherpaStatus: async () => {
    return await ipcRenderer.invoke('tts:sherpa:status');
  },
} as IpcApi);
