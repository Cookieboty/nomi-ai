/**
 * 官方账号目录（docs/design/cli-plugin-architecture.md §5.10.8）：一个官方账号 = 一个 CLI 配置目录。
 * 进程通过凭据目录变量（CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME / GEMINI_CLI_HOME）指向它，
 * 登录、刷新由 CLI 自己在目录里完成；Nomi 只建目录、建软链、生成不含路由与鉴权键的配置副本，
 * 从不读取或写入凭据文件（S7）。
 *
 * 布局（合并了 realiti4/claude-swap 的排除表与 vika2603/ccs 的身份表）：
 * - 私有：凭据、身份、实例记录（sessions / ide 锁）、远程设置缓存等，留在账号目录；
 * - 共享：会话历史、技能、命令等软链回用户自己的 CLI 目录（S9：历史跨账号共享）；
 * - 生成：Claude 的 settings.json（去掉 env 里的路由与鉴权键，S3）与 .claude.json（同步用户级的 MCP、项目信任等，S11）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeConfigDir, codexHomeDir, grokHomeDir } from '../../usage/cliHomes';
import { writePrivateFileAtomic } from '../../utils/privateFile';

import type { AccountKind } from './types';

/** 各 CLI 的凭据目录变量 */
export const HOME_ENV: Record<AccountKind, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
  gemini: 'GEMINI_CLI_HOME',
};

/**
 * 官方会话要剔除的继承变量（S3）：会让 CLI 改走别的地址、改用别的凭据，或指向别的配置目录。
 * 账号目录变量由 Nomi 按标签的账号重新设置。
 */
export const OFFICIAL_STRIP: Record<AccountKind, readonly string[]> = {
  claude: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CONFIG_DIR',
  ],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_HOME'],
  gemini: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_BASE_URL',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GEMINI_CLI_HOME',
    'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
    'GEMINI_FORCE_ENCRYPTED_FILE',
  ],
};

/** Claude settings.json 的 env 里会改变路由或鉴权的键（S3），生成账号目录的副本时去掉 */
const CLAUDE_ROUTING_ENV = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

/** 用户 .claude.json 里与账号无关、要同步进账号目录的字段（S11） */
const CLAUDE_USER_KEYS = [
  'mcpServers',
  'projects',
  'theme',
  'editorMode',
  'hasCompletedOnboarding',
  'autoUpdates',
  'verbose',
  'preferredNotifChannel',
];

export interface HomeLayout {
  /** 软链回用户目录的条目（相对用户目录；不存在的跳过，目录类会先在用户目录里建好再链） */
  shared: Array<{ name: string; dir: boolean; createIfMissing?: boolean }>;
}

export const LAYOUTS: Record<AccountKind, HomeLayout> = {
  claude: {
    shared: [
      { name: 'projects', dir: true, createIfMissing: true },
      { name: 'history.jsonl', dir: false },
      { name: 'CLAUDE.md', dir: false },
      { name: 'keybindings.json', dir: false },
      { name: 'skills', dir: true },
      { name: 'commands', dir: true },
      { name: 'agents', dir: true },
      { name: 'rules', dir: true },
      { name: 'output-styles', dir: true },
      { name: 'todos', dir: true },
    ],
  },
  codex: {
    shared: [
      { name: 'sessions', dir: true, createIfMissing: true },
      { name: 'archived_sessions', dir: true },
      { name: 'config.toml', dir: false },
      { name: 'skills', dir: true },
      { name: 'prompts', dir: true },
      { name: 'AGENTS.md', dir: false },
    ],
  },
  grok: {
    shared: [
      { name: 'sessions', dir: true, createIfMissing: true },
      { name: 'config.toml', dir: false },
      { name: 'installed-plugins', dir: true },
      { name: 'memory-v2', dir: true },
      { name: 'bin', dir: true },
      { name: 'bundled', dir: true },
    ],
  },
  gemini: {
    // GEMINI_CLI_HOME 指向账号目录本身，CLI 在其中建 .gemini/；共享条目相对 .gemini
    shared: [
      { name: '.gemini/tmp', dir: true, createIfMissing: true },
      { name: '.gemini/settings.json', dir: false },
      { name: '.gemini/GEMINI.md', dir: false },
      { name: '.gemini/commands', dir: true },
      { name: '.gemini/extensions', dir: true },
      { name: '.gemini/trustedFolders.json', dir: false },
      { name: '.gemini/projects.json', dir: false },
    ],
  },
};

/** 用户自己的 CLI 配置目录（默认账号）；Gemini 返回 GEMINI_CLI_HOME 意义上的「主目录」 */
export function userCliHome(
  kind: AccountKind,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  switch (kind) {
    case 'claude':
      return claudeConfigDir(home, env);
    case 'codex':
      return codexHomeDir(home, env);
    case 'grok':
      return grokHomeDir(home, env);
    case 'gemini':
      return env.GEMINI_CLI_HOME?.trim() || home;
  }
}

/**
 * 导出给 CLI 的目录路径：绝对、NFC、无结尾分隔符、父目录经过 realpath（不含软链成分）。
 * Claude 在 macOS 上用这个字符串的 sha256 前 8 位区分钥匙串条目；各工具对「原样字符串」和
 * 「规范化路径」取哈希的做法不一致，导出一个本身已经规范化的路径可以让两者一致。
 */
export function canonicalDir(p: string): string {
  const abs = path
    .resolve(p)
    .normalize('NFC')
    .replace(/[\\/]+$/, '');
  // 找到最近一个已存在的上级目录取 realpath（macOS 的 /var → /private/var 等），再接上还不存在的部分
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur).normalize('NFC');
      return path.join(real, ...rest.reverse()).replace(/[\\/]+$/, '');
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export interface HomeProblem {
  entry: string;
  reason: string;
}

function linkOne(
  target: string,
  link: string,
  dir: boolean,
  platform: NodeJS.Platform,
): string | null {
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      if (fs.readlinkSync(link) === target) return null;
      fs.rmSync(link, { force: true });
    } else {
      // 账号目录里已经有同名的真实文件 / 目录（例如 CLI 自己先建了）：保留，不覆盖
      return null;
    }
  } catch {
    /* 不存在：创建 */
  }
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, dir ? (platform === 'win32' ? 'junction' : 'dir') : 'file');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * 建好 / 补齐账号目录：私有目录本身 0700，共享条目软链回用户目录。返回链不上的条目（界面上说明，
 * 不静默复制导致历史分叉）。可以重复调用（每次启动前都调用一次，补上用户后来新建的共享条目）。
 */
export function ensureAccountHome(
  kind: AccountKind,
  accountDir: string,
  userDir: string,
  platform: NodeJS.Platform = process.platform,
): HomeProblem[] {
  fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(accountDir, 0o700);
  } catch {
    /* Windows 上 mode 无效 */
  }
  const problems: HomeProblem[] = [];
  for (const s of LAYOUTS[kind].shared) {
    const target = path.join(userDir, s.name);
    if (!fs.existsSync(target)) {
      if (!s.createIfMissing) continue;
      if (s.dir) fs.mkdirSync(target, { recursive: true });
    }
    const err = linkOne(target, path.join(accountDir, s.name), s.dir, platform);
    if (err) problems.push({ entry: s.name, reason: err });
  }
  if (kind === 'claude') syncClaudeFiles(accountDir, userDir);
  return problems;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 用户的 .claude.json：设了 CLAUDE_CONFIG_DIR 时在目录里，否则在 HOME 下 */
function userClaudeJson(userDir: string): string {
  const inside = path.join(userDir, '.claude.json');
  if (fs.existsSync(inside)) return inside;
  return path.join(path.dirname(userDir), '.claude.json');
}

/**
 * Claude 的生成文件：
 * - settings.json：用户 settings.json 的副本，去掉 env 里的路由与鉴权键和 apiKeyHelper（S3）；
 * - .claude.json：保留账号目录里已有的字段（含 CLI 写入的 oauthAccount 等身份），用户级的 MCP、
 *   项目信任与已允许工具、主题等每次启动前从用户的 .claude.json 同步过来（S11）。
 * 只读写这两个配置文件，凭据文件与钥匙串不碰（S7）。
 */
function syncClaudeFiles(accountDir: string, userDir: string): void {
  const userSettings = readJson(path.join(userDir, 'settings.json')) ?? {};
  const settings: Record<string, unknown> = { ...userSettings };
  delete settings.apiKeyHelper;
  if (settings.env && typeof settings.env === 'object') {
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings.env as Record<string, unknown>))
      if (!CLAUDE_ROUTING_ENV.has(k)) env[k] = v;
    settings.env = env;
  }
  writePrivateFileAtomic(path.join(accountDir, 'settings.json'), JSON.stringify(settings, null, 2));

  const user = readJson(userClaudeJson(userDir)) ?? {};
  const mineFile = path.join(accountDir, '.claude.json');
  const mine = readJson(mineFile) ?? {};
  const next: Record<string, unknown> = { ...mine };
  for (const k of CLAUDE_USER_KEYS) if (user[k] !== undefined) next[k] = user[k];
  writePrivateFileAtomic(mineFile, JSON.stringify(next, null, 2));
}

/** 账号目录相对于用户目录的根（userData/cli-accounts/homes/<kind>/<id>） */
export function accountDirFor(root: string, kind: AccountKind, id: string): string {
  return canonicalDir(path.join(root, 'homes', kind, id.replace(/[^\w-]/g, '_')));
}

/** 官方会话的进程环境：剔除 S3 列出的变量，指定账号时设置凭据目录变量 */
export function officialAccountEnv(
  kind: AccountKind,
  env: NodeJS.ProcessEnv,
  accountDir: string | null,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of OFFICIAL_STRIP[kind]) delete out[k];
  if (accountDir) {
    out[HOME_ENV[kind]] = accountDir;
    // Claude 的 Agent View 后台进程不跟随 CLAUDE_CONFIG_DIR，续接会话时可能用到别的账号（caam #49）
    if (kind === 'claude') out.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1';
  } else if (env[HOME_ENV[kind]]) {
    // 默认账号：保留用户自己设的配置目录变量（那就是用户的「默认账号」所在）
    out[HOME_ENV[kind]] = env[HOME_ENV[kind]];
  }
  return out;
}

/** 账号目录追加的启动参数（Codex 在账号目录里强制文件存储，钥匙串条目按目录区分但不必要） */
export function officialAccountArgs(kind: AccountKind, accountDir: string | null): string[] {
  if (kind === 'codex' && accountDir) return ['-c', 'cli_auth_credentials_store="file"'];
  return [];
}
