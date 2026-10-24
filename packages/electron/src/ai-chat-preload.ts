import { mkAiPreload } from '@nomi-ai/ai-sdk-client/preload';
import { contextBridge, ipcRenderer } from 'electron';

// 为 AI 对话窗口注入 window.aiIPC（走 ai-sdk-client 的白名单桥）
mkAiPreload({ contextBridge, ipcRenderer });

// 为AI对话窗口提供的API（仅暴露命名白名单通道，业务走 window.aiIPC）
const aiChatAPI = {
  /** 平台：渲染层据此画一体化标题栏（macOS 红绿灯 / Windows·Linux 原生按钮 overlay） */
  platform: process.platform,

  /** 设置 → 应用图标（core/appIcon.ts） */
  appIcon: {
    get: () => ipcRenderer.invoke('app-icon:get'),
    set: (variant: string) => ipcRenderer.invoke('app-icon:set', variant),
  },
  /** 设置 → 灵动岛（island/IslandService.ts） */
  island: {
    get: () => ipcRenderer.invoke('island:get'),
    set: (patch: unknown) => ipcRenderer.invoke('island:set', patch),
    test: () => ipcRenderer.invoke('island:test'),
  },

  /** 设置 → 通用：看板娘大小（mascot/MascotWindowController.ts，mascot:scale-*） */
  mascot: {
    scaleGet: () => ipcRenderer.invoke('mascot:scale-get'),
    scaleSet: (scale: number) => ipcRenderer.invoke('mascot:scale-set', scale),
    scaleReset: () => ipcRenderer.invoke('mascot:scale-reset'),
    onScale: (cb: (s: unknown) => void) => {
      const l = (_: unknown, s: unknown) => cb(s);
      ipcRenderer.on('mascot:scale-changed', l);
      return () => {
        ipcRenderer.removeListener('mascot:scale-changed', l);
      };
    },
  },

  /** 设置 → 语音与屏幕 → 语音：朗读引擎配置（userData/tts-config.json；云 Key 只写不读） */
  tts: {
    get: () => ipcRenderer.invoke('getTTSConfig'),
    save: (cfg: unknown) => ipcRenderer.invoke('saveTTSConfig', cfg),
    test: (cfg: unknown) => ipcRenderer.invoke('testTTSConnection', cfg),
    reset: () => ipcRenderer.invoke('resetTTSConfig'),
  },

  /** 设置 → 通用：聊天主面板背景（chat/ChatBackgroundService.ts） */
  chatBg: {
    get: () => ipcRenderer.invoke('chat-bg:get'),
    set: (patch: unknown) => ipcRenderer.invoke('chat-bg:set', patch),
    reset: () => ipcRenderer.invoke('chat-bg:reset'),
    pickImage: () => ipcRenderer.invoke('chat-bg:pick-image'),
    onChanged: (cb: (s: unknown) => void) => {
      const l = (_: unknown, s: unknown) => cb(s);
      ipcRenderer.on('chat-bg:changed', l);
      return () => {
        ipcRenderer.removeListener('chat-bg:changed', l);
      };
    },
  },
  /** 设置 → 隐私与权限 → 诊断日志（diagnostics/DiagnosticsService.ts） */
  diagnostics: {
    get: () => ipcRenderer.invoke('diagnostics:get'),
    set: (on: boolean) => ipcRenderer.invoke('diagnostics:set', on),
    openFolder: () => ipcRenderer.invoke('diagnostics:open-folder'),
    export: () => ipcRenderer.invoke('diagnostics:export'),
  },
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
};

// 将API暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', aiChatAPI);
