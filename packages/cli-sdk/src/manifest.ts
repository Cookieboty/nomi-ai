/**
 * CLI 插件清单（docs/design/cli-plugin-architecture.md §5.2）：纯数据，主进程加载时校验，
 * 校验失败的插件不注册（宿主写诊断日志）。
 */
import type { HarnessPermissionMode } from './events';

export type Transport = 'acp' | 'stream-json' | 'app-server' | 'exec';
export type Ingress = 'messages' | 'responses' | 'chat' | 'gemini';

export interface InstallSpec {
  /** npm 包名（`npm i -g <pkg>`） */
  npm?: string;
  /** 官方安装脚本（展示给用户，宿主不自动执行） */
  script?: string;
  /** 官方安装说明链接 */
  url?: string;
}

/** 权限模式：Nomi 的档位 → CLI 的参数 / ACP mode id */
export interface PermissionModeSpec {
  mode: HarnessPermissionMode;
  /** 启动参数（重启才生效的 CLI） */
  args?: string[];
  /** ACP session/set_mode 的 mode id、Claude set_permission_mode 的值等 */
  modeId?: string;
}

export interface CliCapabilities {
  officialAccount?: boolean;
  thirdParty?: boolean;
  images?: 'native' | 'path' | 'none';
  permissionModes?: PermissionModeSpec[];
  subagents?: boolean;
  slashCommands?: boolean;
  resume?: boolean;
  fork?: boolean;
  usageQuota?: boolean;
  progressMonitor?: boolean;
  terminalCommand?: boolean;
}

/**
 * 网关侧客户端规格（纯数据，§5.5）。具体字段由网关的客户端规格（P6）定义，
 * 清单只负责携带；这里不约束形状，避免 cli-sdk 依赖网关。
 */
export type ClientSpecData = Record<string, unknown>;

export interface CliManifest {
  /** 稳定 id，也是会话键、存储目录、网关客户端 id 的来源；只用 [a-z0-9-] */
  id: string;
  /** 插件契约版本：宿主据此判断兼容性 */
  apiVersion: 1;
  displayName: string;
  /** 图标资源（随插件打包；界面按 id 取） */
  icon: string;
  binary: {
    names: string[];
    versionArgs: string[];
    /** 正则，第一个捕获组是版本号 */
    versionPattern: string;
    minVersion?: string;
    install?: InstallSpec;
  };
  /** 与 Nomi 的会话协议：决定用哪个共享驱动（§5.4） */
  transport: Transport;
  /** 驱动起不来时的退路（如 Codex app-server → exec） */
  fallbackTransport?: 'exec';
  /** 第三方模式下 CLI 打到网关的入口协议 */
  ingress: Ingress;
  capabilities: CliCapabilities;
  /** 模型切换方式的上限（§6.7） */
  modelSwitch: 'gateway' | 'inplace' | 'restart';
  maxTestedVersion?: string;
  /** 按版本开关的能力（semver 范围 → 能力位覆盖） */
  versionGates?: Array<{ range: string; capabilities: Partial<CliCapabilities> }>;
  clientSpec: ClientSpecData;
}

export const CLI_API_VERSION = 1;

const TRANSPORTS: readonly string[] = ['acp', 'stream-json', 'app-server', 'exec'];
const INGRESSES: readonly string[] = ['messages', 'responses', 'chat', 'gemini'];
const SWITCHES: readonly string[] = ['gateway', 'inplace', 'restart'];
const MODES: readonly string[] = ['plan', 'manual', 'acceptEdits', 'auto', 'bypass'];
const IMAGES: readonly string[] = ['native', 'path', 'none'];
const BOOL_CAPS = [
  'officialAccount',
  'thirdParty',
  'subagents',
  'slashCommands',
  'resume',
  'fork',
  'usageQuota',
  'progressMonitor',
  'terminalCommand',
] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function checkCaps(c: unknown, where: string, errors: string[]): void {
  if (!isObj(c)) {
    errors.push(`${where} must be an object`);
    return;
  }
  for (const k of BOOL_CAPS)
    if (c[k] !== undefined && typeof c[k] !== 'boolean')
      errors.push(`${where}.${k} must be boolean`);
  if (c.images !== undefined && !IMAGES.includes(String(c.images)))
    errors.push(`${where}.images must be one of ${IMAGES.join(', ')}`);
  if (c.permissionModes !== undefined) {
    if (!Array.isArray(c.permissionModes)) errors.push(`${where}.permissionModes must be an array`);
    else
      (c.permissionModes as unknown[]).forEach((m, i) => {
        if (!isObj(m) || !MODES.includes(String(m.mode)))
          errors.push(`${where}.permissionModes[${i}].mode is invalid`);
        else {
          if (m.args !== undefined && !isStrArr(m.args))
            errors.push(`${where}.permissionModes[${i}].args must be string[]`);
          if (m.modeId !== undefined && typeof m.modeId !== 'string')
            errors.push(`${where}.permissionModes[${i}].modeId must be a string`);
        }
      });
  }
}

/** 手写校验（不引入 schema 库）：返回错误列表，空 = 通过 */
export function validateManifest(m: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(m)) return ['manifest must be an object'];
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(m.id))
    errors.push('id must match [a-z0-9-] (1–41 chars, not starting with -)');
  if (m.apiVersion !== CLI_API_VERSION) errors.push(`apiVersion must be ${CLI_API_VERSION}`);
  if (typeof m.displayName !== 'string' || !m.displayName.trim())
    errors.push('displayName is required');
  if (typeof m.icon !== 'string') errors.push('icon must be a string');
  const b = m.binary;
  if (!isObj(b)) errors.push('binary must be an object');
  else {
    if (!isStrArr(b.names) || !b.names.length)
      errors.push('binary.names must be a non-empty string[]');
    if (!isStrArr(b.versionArgs)) errors.push('binary.versionArgs must be string[]');
    if (typeof b.versionPattern !== 'string') errors.push('binary.versionPattern must be a string');
    else
      try {
        new RegExp(b.versionPattern);
      } catch {
        errors.push('binary.versionPattern is not a valid regular expression');
      }
    if (b.minVersion !== undefined && typeof b.minVersion !== 'string')
      errors.push('binary.minVersion must be a string');
  }
  if (!TRANSPORTS.includes(String(m.transport)))
    errors.push(`transport must be one of ${TRANSPORTS.join(', ')}`);
  if (m.fallbackTransport !== undefined && m.fallbackTransport !== 'exec')
    errors.push('fallbackTransport must be exec');
  if (!INGRESSES.includes(String(m.ingress)))
    errors.push(`ingress must be one of ${INGRESSES.join(', ')}`);
  checkCaps(m.capabilities, 'capabilities', errors);
  if (!SWITCHES.includes(String(m.modelSwitch)))
    errors.push(`modelSwitch must be one of ${SWITCHES.join(', ')}`);
  if (m.versionGates !== undefined) {
    if (!Array.isArray(m.versionGates)) errors.push('versionGates must be an array');
    else
      (m.versionGates as unknown[]).forEach((g, i) => {
        if (!isObj(g) || typeof g.range !== 'string')
          errors.push(`versionGates[${i}].range is required`);
        else checkCaps(g.capabilities, `versionGates[${i}].capabilities`, errors);
      });
  }
  if (!isObj(m.clientSpec)) errors.push('clientSpec must be an object');
  return errors;
}

/**
 * 有效能力 = 清单声明 ∩ 版本开关（按检测到的版本）∩ 握手协商（§5.2，审查意见 I9）。
 * `inRange` 由宿主给（semver 比较不放进契约包）。握手只能关掉能力，不能打开清单没声明的。
 */
export function effectiveCapabilities(
  m: CliManifest,
  o: {
    version?: string | null;
    inRange?: (version: string, range: string) => boolean;
    handshake?: Partial<Record<keyof CliCapabilities, unknown>>;
  } = {},
): CliCapabilities {
  let caps: CliCapabilities = { ...m.capabilities };
  if (o.version && o.inRange)
    for (const g of m.versionGates ?? [])
      if (o.inRange(o.version, g.range)) caps = { ...caps, ...g.capabilities };
  for (const [k, v] of Object.entries(o.handshake ?? {})) {
    const key = k as keyof CliCapabilities;
    if (v === false && caps[key] !== undefined)
      caps = { ...caps, [key]: key === 'images' ? 'none' : false };
  }
  return caps;
}
