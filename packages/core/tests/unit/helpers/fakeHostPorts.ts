/**
 * 单元测试用的宿主端口假实现（设计稿 §7.1「实施约定」第 4 条：测试不 mock 平台能力）。
 *
 * 只覆盖迁移到端口的服务用到的部分：paths / app / dialogs / shell / clipboard / notifications /
 * image / processes / windows，其余字段按需在
 * 调用处用 `{ ...fakeHostPorts(), xxx }` 补。调用记录放在返回值的 `calls` 上。
 */
import type {
  HostPlatform,
  HostPorts,
  ImagePort,
  PickDirectoryOptions,
  SaveFileOptions,
  Surface,
  SystemNotification,
  WindowIntent,
} from '@nomi-ai/host-ports';

export interface FakeHostPortsOptions {
  userData?: string;
  home?: string;
  resources?: string;
  appPath?: string;
  version?: string;
  name?: string;
  packaged?: boolean;
  platform?: HostPlatform;
  /** pickDirectory 的答案（缺省为 null = 取消） */
  pickDirectory?: string | null;
  /** 系统通知是否可用，默认 true */
  notificationsSupported?: boolean;
  /** 图片端口；缺省时解码不了任何图片 */
  image?: Partial<ImagePort>;
}

export interface FakeHostPortsCalls {
  pickDirectory: PickDirectoryOptions[];
  saveFile: SaveFileOptions[];
  showError: Array<{ title: string; message: string }>;
  openExternal: string[];
  openPath: string[];
  clipboard: string[];
  /** 已显示的系统通知；`click` 模拟用户点击 */
  notifications: Array<SystemNotification & { click?: () => void }>;
  quit: number;
  /** 窗口意图（open / release），按顺序 */
  windows: Array<{ method: 'open' | 'release'; surface: Surface; intent?: WindowIntent }>;
}

/** 假窗口的状态：测试直接改这几张表模拟窗口开着 / 显示 / 被用户关掉、调用方是哪个窗口 */
export interface FakeWindowsState {
  open: Set<Surface>;
  visible: Set<Surface>;
  dismissed: Set<Surface>;
  /** 调用方 id → 它所在的界面 */
  callers: Map<string, Surface>;
  /** 模拟调用方的窗口关闭（触发 onCallerClosed 登记的回调） */
  closeCaller(callerId: string): void;
}

export type FakeHostPorts = Pick<
  HostPorts,
  | 'paths'
  | 'app'
  | 'dialogs'
  | 'shell'
  | 'clipboard'
  | 'notifications'
  | 'image'
  | 'processes'
  | 'windows'
> & {
  lifecycle: Pick<HostPorts['lifecycle'], 'quit'>;
  calls: FakeHostPortsCalls;
  windowState: FakeWindowsState;
};

export function fakeHostPorts(o: FakeHostPortsOptions = {}): FakeHostPorts {
  const userData = o.userData ?? '/tmp/test-userData';
  const calls: FakeHostPortsCalls = {
    pickDirectory: [],
    saveFile: [],
    showError: [],
    openExternal: [],
    openPath: [],
    clipboard: [],
    notifications: [],
    quit: 0,
    windows: [],
  };
  let clip = '';
  const closers = new Map<string, Array<() => void>>();
  const windowState: FakeWindowsState = {
    open: new Set(),
    visible: new Set(),
    dismissed: new Set(),
    callers: new Map(),
    closeCaller(id) {
      const fns = closers.get(id) ?? [];
      closers.delete(id);
      windowState.callers.delete(id);
      for (const fn of fns) fn();
    },
  };
  return {
    calls,
    windowState,
    windows: {
      async open(surface, intent) {
        calls.windows.push(
          intent ? { method: 'open', surface, intent } : { method: 'open', surface },
        );
        windowState.open.add(surface);
        windowState.visible.add(surface);
        if (!intent?.transient) windowState.dismissed.delete(surface);
      },
      focus: () => undefined,
      isVisible: (surface) => windowState.visible.has(surface),
      hide: (surface) => {
        windowState.visible.delete(surface);
      },
      anyFocused: () => false,
      isOpen: (surface) => windowState.open.has(surface),
      dismissed: (surface) => windowState.dismissed.has(surface),
      release(surface) {
        calls.windows.push({ method: 'release', surface });
      },
      ownsCaller: (surface, id) => id !== undefined && windowState.callers.get(id) === surface,
      onCallerClosed(id, fn) {
        if (!windowState.callers.has(id)) return;
        closers.set(id, [...(closers.get(id) ?? []), fn]);
      },
    },
    paths: {
      userData: () => userData,
      logs: () => `${userData}/logs`,
      temp: () => '/tmp',
      resources: () => o.resources ?? '/tmp/test-resources',
      appPath: () => o.appPath ?? '/tmp/test-app',
      home: () => o.home ?? '/tmp/test-home',
      documents: () => `${o.home ?? '/tmp/test-home'}/Documents`,
    },
    app: {
      name: () => o.name ?? 'Test App',
      version: () => o.version ?? '1.0.0',
      locale: () => 'zh-CN',
      preferredLanguages: () => ['zh-CN'],
      isPackaged: () => o.packaged ?? false,
      platform: () => o.platform ?? 'linux',
    },
    dialogs: {
      pickFiles: async () => [],
      pickDirectory: async (opts = {}) => {
        calls.pickDirectory.push(opts);
        return o.pickDirectory ?? null;
      },
      saveFile: async (opts = {}) => {
        calls.saveFile.push(opts);
        return null;
      },
      showError: (title, message) => {
        calls.showError.push({ title, message });
      },
    },
    shell: {
      openExternal: async (url) => {
        calls.openExternal.push(url);
      },
      openPath: async (target) => {
        calls.openPath.push(target);
        return '';
      },
      showItemInFolder: () => undefined,
      trashItem: async () => undefined,
    },
    clipboard: {
      readText: async () => clip,
      writeText: async (text) => {
        clip = text;
        calls.clipboard.push(text);
      },
      readImage: async () => null,
    },
    notifications: {
      supported: () => o.notificationsSupported ?? true,
      show: (n, onClick) => {
        calls.notifications.push({ ...n, ...(onClick ? { click: onClick } : {}) });
      },
    },
    image: {
      size: o.image?.size ?? (async () => null),
      resize:
        o.image?.resize ??
        (async () => {
          throw new Error('image decoding is not available');
        }),
    },
    // 单测里没有工具子进程：调用方退回进程内执行
    processes: {
      available: () => false,
      fork: () => {
        throw new Error('utility processes are not available');
      },
    },
    lifecycle: {
      quit: () => {
        calls.quit++;
      },
    },
  };
}
