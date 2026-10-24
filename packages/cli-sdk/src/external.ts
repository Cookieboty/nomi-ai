/**
 * L1 声明式外部插件（docs/design/cli-plugin-architecture.md §5.9）：用户在「设置 → 编程助手 → 添加 CLI」里
 * 填一份 JSON 清单，接入任意说 ACP 的 CLI，不写代码、不加载任何第三方 JS。
 *
 * 信任模型：
 * - 只有 ACP 一种会话协议；命令不经 shell，参数模板只做占位符替换（argv 形式天然无注入）；
 * - 清单里只能写环境变量的名字（启动前检查是否存在），从不保存变量的值；
 * - 外部插件没有官方账号、没有第三方模型（不接网关）、没有用量 / 进度监视：这些能力需要代码，只给内置插件；
 * - 权限只有「逐项确认」：每次工具调用都走 ACP 的 session/request_permission，由用户在 Nomi 里批准。
 */
import { CLI_API_VERSION, type CliManifest } from './manifest';

export const EXTERNAL_SPEC_VERSION = 1;

export interface ExternalCliSpec {
  version: 1;
  /** 稳定 id：只用 [a-z0-9-]，不能与内置插件重名 */
  id: string;
  displayName: string;
  /** 可执行文件：绝对路径或 PATH 里的名字 */
  command: string;
  /** 参数模板：可用占位符见 EXTERNAL_PLACEHOLDERS */
  args: string[];
  /** 需要的环境变量名（只写名字，值从你的 shell 环境继承，Nomi 不保存） */
  env?: string[];
}

/** 参数模板里允许的占位符 */
export const EXTERNAL_PLACEHOLDERS = ['cwd', 'home'] as const;
export type ExternalPlaceholder = (typeof EXTERNAL_PLACEHOLDERS)[number];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const MAX_ARGS = 32;
const MAX_ARG_LEN = 512;
const MAX_ENV = 16;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** 控制字符（含换行、NUL）：命令和参数里一律不允许 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 校验外部插件清单。`reserved` 是不能占用的 id（内置插件）。返回错误列表，空 = 通过。
 * 错误是英文短句（写日志 / 测试用），界面按字段给中文提示。
 */
export function validateExternalSpec(raw: unknown, reserved: readonly string[] = []): string[] {
  const errors: string[] = [];
  if (!isObj(raw)) return ['spec must be an object'];
  if (raw.version !== EXTERNAL_SPEC_VERSION)
    errors.push(`version must be ${EXTERNAL_SPEC_VERSION}`);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id))
    errors.push('id must match [a-z0-9][a-z0-9-]{0,39}');
  else if (reserved.includes(raw.id)) errors.push(`id ${raw.id} is reserved by a built-in plugin`);
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim())
    errors.push('displayName is required');
  else if (raw.displayName.length > 60 || CONTROL_RE.test(raw.displayName))
    errors.push('displayName must be at most 60 printable characters');
  if (typeof raw.command !== 'string' || !raw.command.trim()) errors.push('command is required');
  else if (raw.command.length > 1024 || CONTROL_RE.test(raw.command))
    errors.push('command must not contain control characters');
  else if (PLACEHOLDER_RE.test(raw.command)) errors.push('command must not contain placeholders');
  PLACEHOLDER_RE.lastIndex = 0;
  if (!Array.isArray(raw.args)) errors.push('args must be an array');
  else {
    if (raw.args.length > MAX_ARGS) errors.push(`at most ${MAX_ARGS} args`);
    raw.args.forEach((a, i) => {
      if (typeof a !== 'string') return errors.push(`args[${i}] must be a string`);
      if (a.length > MAX_ARG_LEN || CONTROL_RE.test(a))
        return errors.push(`args[${i}] must be at most ${MAX_ARG_LEN} printable characters`);
      for (const m of a.matchAll(PLACEHOLDER_RE))
        if (!(EXTERNAL_PLACEHOLDERS as readonly string[]).includes(m[1]!))
          errors.push(`args[${i}] uses unknown placeholder {${m[1]}}`);
    });
  }
  if (raw.env !== undefined) {
    if (!Array.isArray(raw.env)) errors.push('env must be an array of names');
    else {
      if (raw.env.length > MAX_ENV) errors.push(`at most ${MAX_ENV} env names`);
      raw.env.forEach((n, i) => {
        if (typeof n !== 'string' || !ENV_RE.test(n))
          errors.push(`env[${i}] must be an environment variable name (no values)`);
      });
    }
  }
  const known = new Set(['version', 'id', 'displayName', 'command', 'args', 'env']);
  for (const k of Object.keys(raw)) if (!known.has(k)) errors.push(`unknown field ${k}`);
  return errors;
}

/** 只留已知字段并去掉首尾空白（存盘与比较都用它） */
export function normalizeExternalSpec(s: ExternalCliSpec): ExternalCliSpec {
  return {
    version: 1,
    id: s.id.trim(),
    displayName: s.displayName.trim(),
    command: s.command.trim(),
    args: [...s.args],
    ...(s.env?.length ? { env: [...new Set(s.env.map((n) => n.trim()))] } : {}),
  };
}

/**
 * 参数模板 → argv：只替换占位符，结果直接作为 argv 元素交给 spawn（不经 shell）。
 * 替换后的值不再二次展开（`{cwd}` 里出现 `{home}` 字样不会被替换）。
 */
export function renderExternalArgs(
  args: readonly string[],
  vars: Record<ExternalPlaceholder, string>,
): string[] {
  return args.map((a) =>
    a.replace(PLACEHOLDER_RE, (m, name: string) =>
      (EXTERNAL_PLACEHOLDERS as readonly string[]).includes(name)
        ? vars[name as ExternalPlaceholder]
        : m,
    ),
  );
}

/** 清单里要求、但当前环境没有的变量名 */
export function missingExternalEnv(spec: ExternalCliSpec, env: NodeJS.ProcessEnv): string[] {
  return (spec.env ?? []).filter((n) => !env[n]);
}

/**
 * 外部插件的插件清单：ACP、无官方账号、无第三方、只有「逐项确认」、换模型靠重启。
 * 能力位之后由握手（initialize 的 agentCapabilities）再收窄。
 */
export function externalManifest(s: ExternalCliSpec): CliManifest {
  return {
    id: s.id,
    apiVersion: CLI_API_VERSION,
    displayName: s.displayName,
    icon: '',
    binary: {
      names: [s.command],
      versionArgs: ['--version'],
      versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    },
    transport: 'acp',
    // 外部插件不接网关；入口协议只是清单必填项，不会被使用
    ingress: 'chat',
    capabilities: {
      officialAccount: false,
      thirdParty: false,
      images: 'native',
      permissionModes: [{ mode: 'manual' }],
      subagents: false,
      slashCommands: true,
      resume: true,
      fork: false,
      usageQuota: false,
      progressMonitor: false,
      terminalCommand: false,
    },
    modelSwitch: 'restart',
    clientSpec: {},
  };
}
