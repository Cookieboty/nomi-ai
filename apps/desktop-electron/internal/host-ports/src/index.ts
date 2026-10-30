/**
 * @nomi-ai/host-ports —— 内核与宿主之间的端口定义（纯类型，无运行时代码）。
 *
 * 内核（@nomi-ai/core）只经这些端口使用平台能力；Electron、无界面 Node、以后的
 * Tauri sidecar 等宿主各自实现一份。设计见 docs/design/core-host-decoupling.md §6、§9。
 *
 * 方法集按 `apps/desktop-electron/src` 现有调用逐一对应（附录 A），下一步迁移可以 1:1 替换：
 * - 平台本来就同步的（`app.getPath`、`safeStorage`、`powerMonitor.getSystemIdleTime`）保持同步，
 *   否则调用链要整体改成 async；
 * - 平台本来就异步的（文件选择器、剪贴板、截屏、`shell.openPath`）是 Promise；
 * - 参数与返回值只用可序列化的值（string / number / boolean / Uint8Array / 普通对象），
 *   不出现 BrowserWindow、Buffer、NativeImage 这类宿主对象。
 */

// ───────────────────────── 界面 ─────────────────────────

/**
 * 宿主上的界面。`settings` 目前是对话窗口里的设置面板，由宿主决定落在哪个窗口。
 */
export type Surface = 'chat' | 'mascot' | 'settings';

// ───────────────────────── paths ─────────────────────────

/**
 * 目录位置。全部是同步取值（对应 `app.getPath` / `process.resourcesPath`），
 * 宿主在启动时确定，运行期不变。
 */
export interface PathsPort {
  /** 应用数据目录（`app.getPath('userData')`），开发态包名迁移由宿主处理 */
  userData(): string;
  /** 日志目录（现为 `<userData>/logs`） */
  logs(): string;
  /** 系统临时目录（`app.getPath('temp')`） */
  temp(): string;
  /** 打包后的资源目录（`process.resourcesPath`）；开发态可能指向运行时自带目录，调用方先看 `app.isPackaged()` */
  resources(): string;
  /** 应用代码根目录（`app.getAppPath()`；开发态是 apps/desktop-electron） */
  appPath(): string;
  /** 用户主目录（`app.getPath('home')`） */
  home(): string;
  /** 「文稿」目录（`app.getPath('documents')`，编程助手默认工作目录） */
  documents(): string;
}

// ───────────────────────── app ─────────────────────────

/** 应用本身的元信息（`app.getVersion` / `getName` / `getLocale` / `getPreferredSystemLanguages` / `isPackaged`） */
export interface AppInfoPort {
  name(): string;
  version(): string;
  /** 系统界面语言（BCP 47，如 `zh-CN`）；宿主就绪前可能为空串 */
  locale(): string;
  /**
   * 系统首选语言列表（按用户偏好排序，Electron：`app.getPreferredSystemLanguages()`）；
   * 宿主拿不到时返回空数组，调用方退回 `locale()`
   */
  preferredLanguages(): readonly string[];
  /** 是否为正式打包产物（关闭开发特性、日志降噪等） */
  isPackaged(): boolean;
  /** 运行平台（同 `process.platform`） */
  platform(): HostPlatform;
}

export type HostPlatform = 'darwin' | 'win32' | 'linux' | (string & {});

// ───────────────────────── secrets ─────────────────────────

/**
 * 系统安全存储（Electron 下是 `safeStorage`：Keychain / DPAPI / libsecret）。
 *
 * 只负责「字节级加解密」；`enc:` 前缀、明文降级、失败关闭、迁移这些策略留在内核
 * （`security/secretStorage.ts`、`createSafeStorageCipher`）。
 *
 * 与设计稿 §6.1 的差异：encrypt / decrypt 是同步的。现有 9 处调用全部是同步链路
 * （配置读写、`SecretCipher.encrypt/decrypt`），`safeStorage` 本身也是同步 API。
 */
export interface SecretsPort {
  /** 是否能加密（`safeStorage.isEncryptionAvailable()`，不含真实探测） */
  available(): boolean;
  /**
   * 实际选中的后端（Linux：`basic_text` / `gnome_libsecret` / `kwallet*` / `unknown`）；
   * 平台不提供时为 null。`basic_text` 等同明文，由内核判定为不可用。
   */
  backend(): string | null;
  /** 加密；不可用或失败时抛错 */
  encrypt(plain: string): Uint8Array;
  /** 解密；密文无效 / 钥匙串变了时抛错 */
  decrypt(cipher: Uint8Array): string;
}

// ───────────────────────── dialogs ─────────────────────────

/**
 * 文件对话框挂在哪个窗口上：
 * - `focused`：当前获得焦点的窗口（现在多数导出 / 选择用的就是它）；
 * - `none`：不挂父窗口（独立弹出）；
 * - 具体界面：挂到该界面所在窗口（如从对话窗口触发的选择）。
 */
export type DialogParent = Surface | 'focused' | 'none';

export interface FileFilter {
  /** 显示名，如 `Images` */
  name: string;
  /** 不带点的扩展名，`*` 表示全部 */
  extensions: string[];
}

interface DialogCommonOptions {
  title?: string;
  /** 确认按钮文字 */
  buttonLabel?: string;
  /** 初始目录或文件路径；`~` 不展开，调用方先用 `paths.home()` 展开 */
  defaultPath?: string;
  /** 默认 `none` */
  parent?: DialogParent;
}

export interface PickFilesOptions extends DialogCommonOptions {
  filters?: FileFilter[];
  /** 允许多选，默认 false */
  multiple?: boolean;
}

export interface PickDirectoryOptions extends DialogCommonOptions {
  /** 允许在对话框里新建文件夹（macOS 的 `createDirectory`），默认 false */
  createDirectory?: boolean;
}

export interface SaveFileOptions extends DialogCommonOptions {
  filters?: FileFilter[];
}

/**
 * 系统文件选择器。确认 / 输入类弹窗不在这里：视图内用 `confirmDialog` / `promptDialog`。
 */
export interface DialogsPort {
  /** 取消返回空数组 */
  pickFiles(opts?: PickFilesOptions): Promise<string[]>;
  /** 取消返回 null */
  pickDirectory(opts?: PickDirectoryOptions): Promise<string | null>;
  /** 取消返回 null */
  saveFile(opts?: SaveFileOptions): Promise<string | null>;
  /**
   * 致命错误提示（`dialog.showErrorBox`）。只给「界面可能已经起不来」的场景用，
   * 宿主就绪前也能调用；无界面宿主只记录。
   */
  showError(title: string, message: string): void;
}

// ───────────────────────── shell ─────────────────────────

export interface ShellPort {
  /** 用系统默认程序打开外部链接；协议白名单由内核（netGuard）先判定 */
  openExternal(url: string): Promise<void>;
  /** 用系统默认程序打开本地文件 / 目录；成功返回空串，失败返回错误信息（同 `shell.openPath`） */
  openPath(path: string): Promise<string>;
  /** 在文件管理器中定位 */
  showItemInFolder(path: string): void;
  /** 把文件 / 目录移到系统废纸篓（删除历史会话等可恢复的删除） */
  trashItem(path: string): Promise<void>;
}

// ───────────────────────── clipboard ─────────────────────────

export interface ClipboardImage {
  mime: 'image/png';
  data: Uint8Array;
  width: number;
  height: number;
}

/** 系统剪贴板（Electron ≥ 40 的剪贴板本身就是异步 API） */
export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  /** 没有图片时返回 null */
  readImage(): Promise<ClipboardImage | null>;
}

// ───────────────────────── screenCapture ─────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: string;
  name: string;
  primary: boolean;
  bounds: Rect;
  scaleFactor: number;
}

export interface CaptureOptions {
  /** 缺省为主显示器 */
  displayId?: string;
  /** 只截这个区域（相对显示器左上角） */
  area?: Rect;
  /** 默认 `image/png` */
  mime?: 'image/png' | 'image/jpeg';
  maxWidth?: number;
  maxHeight?: number;
}

export interface CaptureResult {
  displayId: string;
  mime: 'image/png' | 'image/jpeg';
  data: Uint8Array;
  width: number;
  height: number;
  /** 毫秒时间戳 */
  capturedAt: number;
}

/** 屏幕截取（结构与 bundle-ig-electron-caps 的 ScreenService 一致） */
export interface ScreenCapturePort {
  listDisplays(): Promise<DisplayInfo[]>;
  /** 宿主不支持或没有权限时抛错 */
  capture(opts?: CaptureOptions): Promise<CaptureResult>;
}

// ───────────────────────── power ─────────────────────────

/** 取消订阅 */
export type Unsubscribe = () => void;

export interface PowerPort {
  /** 用户空闲秒数（`powerMonitor.getSystemIdleTime()`）；宿主取不到时为 0 */
  idleSeconds(): number;
  onSuspend(fn: () => void): Unsubscribe;
  onResume(fn: () => void): Unsubscribe;
}

// ───────────────────────── lifecycle ─────────────────────────

export interface LifecyclePort {
  /** 宿主就绪（Electron：`app.whenReady()`） */
  whenReady(): Promise<void>;
  /**
   * 应用即将退出。宿主不保证等待返回的 Promise 完成——需要可靠收尾的服务注册到内核的
   * 生命周期表，由宿主组合根在退出流程里 `await core.stop()`。
   */
  onBeforeQuit(fn: () => void | Promise<void>): Unsubscribe;
  /** 应用被重新激活（macOS 点 Dock 图标等） */
  onActivate(fn: () => void): Unsubscribe;
  /** 请求正常退出（会走 before-quit 与收尾流程） */
  quit(): void;
  /** 立即退出，不再触发 before-quit；只在收尾完成后使用 */
  exit(code?: number): void;
}

// ───────────────────────── appearance ─────────────────────────

/** 原生窗口外观：跟随系统，或强制深色 / 浅色 */
export type NativeAppearance = 'system' | 'dark' | 'light';

/**
 * 系统深浅色与原生窗口外观（Electron 下是 `nativeTheme`）。
 *
 * 界面主题本身（Graphite / Cream……）是内核的偏好值，不在这里；宿主只报告「系统现在是不是深色」，
 * 并按内核要求设置原生控件（标题栏、红绿灯、滚动条）的外观。
 */
export interface AppearancePort {
  /**
   * 原生控件当前是否按深色绘制（`nativeTheme.shouldUseDarkColors`）：
   * 外观为 `system` 时就是系统设置，强制深色 / 浅色时跟着强制值。
   */
  isDark(): boolean;
  /** 当前原生窗口外观（`nativeTheme.themeSource`） */
  windowAppearance(): NativeAppearance;
  /** 设置原生窗口外观；与当前值相同时不做任何事 */
  setWindowAppearance(mode: NativeAppearance): void;
  /** 系统深浅色或原生外观变化（`nativeTheme` 的 `updated`） */
  onChange(fn: () => void): Unsubscribe;
}

// ───────────────────────── notifications ─────────────────────────

export interface SystemNotification {
  title: string;
  body: string;
  /** 不播放提示音，默认 false */
  silent?: boolean;
}

/**
 * 系统通知（Electron 下是 `Notification`，图标用应用当前图标）。
 *
 * 什么时候弹（免打扰、看板娘在不在、灵动岛优先）是内核的策略，这里只负责「弹出来」。
 */
export interface NotificationsPort {
  /** 当前系统能否显示通知 */
  supported(): boolean;
  /** 显示一条通知；`onClick` 在用户点通知时调用。显示失败时抛错 */
  show(notification: SystemNotification, onClick?: () => void): void;
}

// ───────────────────────── image ─────────────────────────

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageResizeOptions {
  /** 目标宽度；只给宽或高时按比例缩放 */
  width?: number;
  /** 目标高度 */
  height?: number;
  /** 输出编码 */
  format: 'png' | 'jpeg';
  /** JPEG 质量 0–100，默认 85；PNG 忽略 */
  quality?: number;
}

/**
 * 图片解码与缩放（Electron 下是 `nativeImage`）。输入是编码后的图片字节（PNG / JPEG / WebP 等，
 * 支持的格式由宿主决定），输出也是编码后的字节。
 */
export interface ImagePort {
  /** 解码得到尺寸；不是图片或解码失败时返回 null */
  size(data: Uint8Array): Promise<ImageSize | null>;
  /** 解码、按 `width` / `height` 缩放（尽量高质量）后重新编码；解码失败时抛错 */
  resize(data: Uint8Array, opts: ImageResizeOptions): Promise<Uint8Array>;
}

// ───────────────────────── processes ─────────────────────────

export interface UtilityProcessOptions {
  args?: string[];
  /** 子进程的 Node 启动参数，如 `--max-old-space-size=256` */
  execArgv?: string[];
  /** 进程名（任务管理器 / 崩溃报告里显示） */
  serviceName?: string;
  /** 默认 `ignore` */
  stdio?: 'ignore' | 'inherit' | 'pipe';
}

/** 工具子进程句柄（结构同 Electron `UtilityProcess` 用到的部分） */
export interface UtilityProcess {
  /** 发给子进程（子进程经 `process.parentPort` 收）；消息走结构化克隆 */
  postMessage(message: unknown): void;
  on(event: 'message', fn: (message: unknown) => void): void;
  on(event: 'exit', fn: (code: number) => void): void;
  /** 结束子进程；已经退出时返回 false */
  kill(): boolean;
}

/**
 * 隔离的工具子进程（Electron 下是 `utilityProcess`）：文档解析、统一网关这类要和主进程隔开
 * （崩溃、内存上限、超时可杀）的工作。子进程脚本经 `process.parentPort` 收发消息。
 */
export interface ProcessesPort {
  /** 宿主能否拉起工具子进程；不能时调用方退回进程内执行或报不可用 */
  available(): boolean;
  /** 拉起子进程运行 `modulePath`；不可用时抛错 */
  fork(modulePath: string, opts?: UtilityProcessOptions): UtilityProcess;
}

// ───────────────────────── windows（声明式，§6.2） ─────────────────────────

export interface WindowIntent {
  /**
   * 打开后跳到的位置，如 `providers`、`desktop`、`schedule`、`voice`。
   * 未识别的 route 由宿主忽略（只打开界面）。
   */
  route?: string;
  /** 是否抢占焦点，默认 true；false 时只显示 */
  activate?: boolean;
}

/**
 * 内核只表达意图，不操作窗口对象；尺寸、位置、透明、置顶、物理效果都是宿主自己的事。
 */
export interface WindowsPort {
  /** 打开（不存在则创建）界面并按 intent 跳转 */
  open(surface: Surface, intent?: WindowIntent): Promise<void>;
  /** 聚焦已存在的界面；不存在时什么都不做 */
  focus(surface: Surface): void;
  /** 界面所在窗口是否存在且可见 */
  isVisible(surface: Surface): boolean;
  /** 隐藏界面（窗口保留，如看板娘隐藏时仍要承载提醒） */
  hide(surface: Surface): void;
  /** 本应用是否有任一窗口获得焦点（判断「后台完成」：未读、通知） */
  anyFocused(): boolean;
}

// ───────────────────────── capabilities（§9） ─────────────────────────

/**
 * 宿主特有能力只做声明，不做抽象；视图按能力降级。
 */
export interface HostCapabilities {
  /** 透明无边框窗口（桌面看板娘） */
  transparentWindow: boolean;
  /** 窗口点击穿透 */
  clickThrough: boolean;
  /** 系统托盘 / 菜单栏图标 */
  tray: boolean;
  /** 灵动岛浮层 */
  island: boolean;
  /** 原生标题栏控件形态 */
  nativeTitleBar: 'mac-traffic-lights' | 'win-controls' | 'none';
}

// ───────────────────────── 汇总 ─────────────────────────

export interface HostPorts {
  paths: PathsPort;
  app: AppInfoPort;
  secrets: SecretsPort;
  dialogs: DialogsPort;
  shell: ShellPort;
  clipboard: ClipboardPort;
  screenCapture: ScreenCapturePort;
  power: PowerPort;
  lifecycle: LifecyclePort;
  appearance: AppearancePort;
  notifications: NotificationsPort;
  image: ImagePort;
  processes: ProcessesPort;
  windows: WindowsPort;
  /** 静态声明，宿主启动后不变 */
  capabilities: Readonly<HostCapabilities>;
}

export type HostPortName = keyof HostPorts;
