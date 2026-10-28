/**
 * @nomi-ai/host-node —— 无界面宿主，用于测试与开发（docs/design/core-host-decoupling.md §6.3）。
 *
 * - `paths` 指向一个临时目录（或调用方给的目录）；
 * - `secrets` 用内存里的可逆编码（**不是加密**，仅测试）；
 * - `dialogs` 按队列返回预设答案，队列空时视为用户取消；
 * - `shell` / `windows` / `lifecycle` 只记录调用；
 * - `capabilities` 全部为 false / `none`。
 *
 * 返回值除了 `HostPorts` 本身，还带一个 `control` 句柄，测试用它预设答案、触发事件、读记录。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CaptureOptions,
  CaptureResult,
  ClipboardImage,
  DisplayInfo,
  HostCapabilities,
  HostPlatform,
  HostPorts,
  PathsPort,
  PickDirectoryOptions,
  PickFilesOptions,
  SaveFileOptions,
  Surface,
  Unsubscribe,
  WindowIntent,
} from '@nomi-ai/host-ports';

export type PathKey = keyof PathsPort;

export type DialogKind = 'pickFiles' | 'pickDirectory' | 'saveFile';

export interface DialogAnswers {
  pickFiles?: string[][];
  pickDirectory?: (string | null)[];
  saveFile?: (string | null)[];
}

export type DialogCall =
  | { kind: 'pickFiles'; opts: PickFilesOptions; answer: string[] }
  | { kind: 'pickDirectory'; opts: PickDirectoryOptions; answer: string | null }
  | { kind: 'saveFile'; opts: SaveFileOptions; answer: string | null }
  | { kind: 'showError'; title: string; message: string };

export type ShellCall =
  | { method: 'openExternal'; target: string }
  | { method: 'openPath'; target: string }
  | { method: 'showItemInFolder'; target: string };

export type WindowCall =
  | { method: 'open'; surface: Surface; intent?: WindowIntent }
  | { method: 'focus'; surface: Surface }
  | { method: 'hide'; surface: Surface };

export interface NodeHostPortsOptions {
  /** 所有目录的根；缺省时在系统临时目录下新建，`dispose()` 时删除 */
  root?: string;
  /** 单独覆盖某个目录 */
  paths?: Partial<Record<PathKey, string>>;
  app?: {
    name?: string;
    version?: string;
    locale?: string;
    isPackaged?: boolean;
    platform?: HostPlatform;
  };
  /** 安全存储是否可用，默认 true；false 时 encrypt 抛错 */
  secretsAvailable?: boolean;
  /** 安全存储后端名，默认 `memory` */
  secretsBackend?: string | null;
  /** 预设的对话框答案（按调用顺序消费） */
  dialogs?: DialogAnswers;
  /** `shell.openPath` 的返回值（空串 = 成功），默认 '' */
  openPathResult?: string | ((target: string) => string);
  /** 初始剪贴板 */
  clipboard?: { text?: string; image?: ClipboardImage | null };
  /** 截屏：显示器列表与结果；缺省时 capture 抛错（无界面宿主没有屏幕） */
  screen?: {
    displays?: DisplayInfo[];
    capture?: (opts: CaptureOptions) => CaptureResult | Promise<CaptureResult>;
  };
  /** 用户空闲秒数，默认 0 */
  idleSeconds?: number;
  /** 覆盖能力声明（默认全部关闭） */
  capabilities?: Partial<HostCapabilities>;
}

export interface NodeHostControl {
  /** 实际使用的根目录 */
  readonly root: string;
  /** 追加对话框答案 */
  queueDialog(kind: 'pickFiles', answer: string[]): void;
  queueDialog(kind: 'pickDirectory' | 'saveFile', answer: string | null): void;
  readonly dialogCalls: readonly DialogCall[];
  readonly shellCalls: readonly ShellCall[];
  readonly windowCalls: readonly WindowCall[];
  /** 当前可见的界面 */
  visibleSurfaces(): Surface[];
  setIdleSeconds(seconds: number): void;
  setSecretsAvailable(available: boolean): void;
  setClipboardImage(image: ClipboardImage | null): void;
  /** 触发电源事件 */
  emitSuspend(): void;
  emitResume(): void;
  emitActivate(): void;
  /** 依次执行 before-quit 回调并等待全部完成（回调抛错不影响其余） */
  runBeforeQuit(): Promise<void>;
  /** `lifecycle.quit()` 被调用的次数 */
  readonly quitCount: number;
  /** `lifecycle.exit()` 的退出码；未调用时为 null */
  readonly exitCode: number | null;
  /** 删除自动创建的临时根目录（调用方传入 root 时不删） */
  dispose(): void;
}

export interface NodeHostPorts {
  ports: HostPorts;
  control: NodeHostControl;
}

/** 无界面宿主不具备任何宿主特有能力 */
export const NODE_HOST_CAPABILITIES: Readonly<HostCapabilities> = Object.freeze({
  transparentWindow: false,
  clickThrough: false,
  tray: false,
  island: false,
  nativeTitleBar: 'none',
});

/** 内存「密文」的标记，仅用来让 decrypt 拒绝不是自己产出的数据 */
const SECRET_MAGIC = 'nomi-host-node:';

function listeners<A extends unknown[] = []>() {
  const set = new Set<(...args: A) => void>();
  return {
    add(fn: (...args: A) => void): Unsubscribe {
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    emit(...args: A) {
      for (const fn of [...set]) fn(...args);
    },
  };
}

export function createNodeHostPorts(options: NodeHostPortsOptions = {}): NodeHostPorts {
  const ownsRoot = !options.root;
  const root = options.root ?? mkdtempSync(path.join(tmpdir(), 'nomi-host-node-'));
  const userData = options.paths?.userData ?? path.join(root, 'userData');
  const home = options.paths?.home ?? path.join(root, 'home');
  const dirs: Record<PathKey, string> = {
    userData,
    logs: options.paths?.logs ?? path.join(userData, 'logs'),
    temp: options.paths?.temp ?? path.join(root, 'temp'),
    resources: options.paths?.resources ?? path.join(root, 'resources'),
    appPath: options.paths?.appPath ?? path.join(root, 'app'),
    home,
    documents: options.paths?.documents ?? path.join(home, 'Documents'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  const answers = {
    pickFiles: [...(options.dialogs?.pickFiles ?? [])],
    pickDirectory: [...(options.dialogs?.pickDirectory ?? [])],
    saveFile: [...(options.dialogs?.saveFile ?? [])],
  };
  const dialogCalls: DialogCall[] = [];
  const shellCalls: ShellCall[] = [];
  const windowCalls: WindowCall[] = [];
  const visible = new Set<Surface>();

  let secretsAvailable = options.secretsAvailable ?? true;
  let idleSeconds = options.idleSeconds ?? 0;
  let clipboardText = options.clipboard?.text ?? '';
  let clipboardImage = options.clipboard?.image ?? null;
  let quitCount = 0;
  let exitCode: number | null = null;

  const suspend = listeners();
  const resume = listeners();
  const activate = listeners();
  const beforeQuit = new Set<() => void | Promise<void>>();

  const runBeforeQuit = async () => {
    for (const fn of [...beforeQuit]) {
      try {
        await fn();
      } catch {
        /* 与 Electron 宿主一致：一个回调失败不影响其余 */
      }
    }
  };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const app = options.app ?? {};
  const ports: HostPorts = {
    paths: {
      userData: () => dirs.userData,
      logs: () => dirs.logs,
      temp: () => dirs.temp,
      resources: () => dirs.resources,
      appPath: () => dirs.appPath,
      home: () => dirs.home,
      documents: () => dirs.documents,
    },
    app: {
      name: () => app.name ?? 'nomi-ai',
      version: () => app.version ?? '0.0.0',
      locale: () => app.locale ?? 'zh-CN',
      isPackaged: () => app.isPackaged ?? false,
      platform: () => app.platform ?? process.platform,
    },
    secrets: {
      available: () => secretsAvailable,
      backend: () => (options.secretsBackend === undefined ? 'memory' : options.secretsBackend),
      encrypt(plain) {
        if (!secretsAvailable) throw new Error('secrets unavailable');
        return encoder.encode(SECRET_MAGIC + plain);
      },
      decrypt(cipher) {
        if (!secretsAvailable) throw new Error('secrets unavailable');
        const text = decoder.decode(cipher);
        if (!text.startsWith(SECRET_MAGIC)) throw new Error('invalid ciphertext');
        return text.slice(SECRET_MAGIC.length);
      },
    },
    dialogs: {
      async pickFiles(opts = {}) {
        const answer = answers.pickFiles.shift() ?? [];
        dialogCalls.push({ kind: 'pickFiles', opts, answer });
        return answer;
      },
      async pickDirectory(opts = {}) {
        const next = answers.pickDirectory.shift();
        const answer = next === undefined ? null : next;
        dialogCalls.push({ kind: 'pickDirectory', opts, answer });
        return answer;
      },
      async saveFile(opts = {}) {
        const next = answers.saveFile.shift();
        const answer = next === undefined ? null : next;
        dialogCalls.push({ kind: 'saveFile', opts, answer });
        return answer;
      },
      showError(title, message) {
        dialogCalls.push({ kind: 'showError', title, message });
      },
    },
    shell: {
      async openExternal(url) {
        shellCalls.push({ method: 'openExternal', target: url });
      },
      async openPath(target) {
        shellCalls.push({ method: 'openPath', target });
        const r = options.openPathResult;
        return typeof r === 'function' ? r(target) : (r ?? '');
      },
      showItemInFolder(target) {
        shellCalls.push({ method: 'showItemInFolder', target });
      },
    },
    clipboard: {
      readText: async () => clipboardText,
      async writeText(text) {
        clipboardText = text;
      },
      readImage: async () => clipboardImage,
    },
    screenCapture: {
      listDisplays: async () => options.screen?.displays ?? [],
      async capture(opts = {}) {
        if (!options.screen?.capture) throw new Error('screen capture is not available');
        return options.screen.capture(opts);
      },
    },
    power: {
      idleSeconds: () => idleSeconds,
      onSuspend: (fn) => suspend.add(fn),
      onResume: (fn) => resume.add(fn),
    },
    lifecycle: {
      whenReady: () => Promise.resolve(),
      onBeforeQuit(fn) {
        beforeQuit.add(fn);
        return () => {
          beforeQuit.delete(fn);
        };
      },
      onActivate: (fn) => activate.add(fn),
      quit() {
        quitCount += 1;
      },
      exit(code = 0) {
        exitCode = code;
      },
    },
    windows: {
      async open(surface, intent) {
        windowCalls.push(
          intent ? { method: 'open', surface, intent } : { method: 'open', surface },
        );
        visible.add(surface);
      },
      focus(surface) {
        windowCalls.push({ method: 'focus', surface });
      },
      isVisible: (surface) => visible.has(surface),
      hide(surface) {
        windowCalls.push({ method: 'hide', surface });
        visible.delete(surface);
      },
    },
    capabilities: Object.freeze({ ...NODE_HOST_CAPABILITIES, ...options.capabilities }),
  };

  const control: NodeHostControl = {
    root,
    queueDialog(kind: DialogKind, answer: string[] | string | null) {
      if (kind === 'pickFiles') answers.pickFiles.push(answer as string[]);
      else answers[kind].push(answer as string | null);
    },
    dialogCalls,
    shellCalls,
    windowCalls,
    visibleSurfaces: () => [...visible],
    setIdleSeconds(seconds) {
      idleSeconds = seconds;
    },
    setSecretsAvailable(available) {
      secretsAvailable = available;
    },
    setClipboardImage(image) {
      clipboardImage = image;
    },
    emitSuspend: () => suspend.emit(),
    emitResume: () => resume.emit(),
    emitActivate: () => activate.emit(),
    runBeforeQuit,
    get quitCount() {
      return quitCount;
    },
    get exitCode() {
      return exitCode;
    },
    dispose() {
      if (ownsRoot) rmSync(root, { recursive: true, force: true });
    },
  };

  return { ports, control };
}
