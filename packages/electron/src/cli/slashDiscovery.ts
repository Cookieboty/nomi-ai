/**
 * 斜杠命令 / skills / 插件的只读发现与展开（主进程）。
 *
 * 只读文件名与 frontmatter（每个文件最多读前 8 KB），不读凭据 / 配置类文件；
 * 展开时只接受发现结果里存在的 id，由这里按 id 找到路径再读那一个文件的正文——
 * 渲染进程永远不能传路径。命令文件里的 `!`cmd`` 不会被执行（原样保留并报告）。
 * 目录布局依据各 CLI 的公开文档，见 docs/design/chat-slash-commands.md §4.5；布局由内置插件的
 * slash.sources 给出（声明式数据），扫描、拒绝名单与大小上限都在这里（宿主统一执行）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claude, codex, dsh, gemini, grok, type BuiltinCliId } from '@nomi-ai/cli-plugins/main';
import type { SlashDiscoveryCapability } from '@nomi-ai/cli-sdk';

/** 斜杠命令的后端：Nomi 自己 + 内置编程助手（有没有公开布局看插件的 slash.sources） */
export type SlashBackend = 'nomi' | BuiltinCliId;

/** 各内置插件的斜杠命令布局（没有 slash.sources 的 CLI 不做目录发现） */
const PLUGIN_SLASH: Record<BuiltinCliId, SlashDiscoveryCapability | undefined> = {
  claude: claude.slash,
  codex: codex.slash,
  dsh: (dsh as { slash?: SlashDiscoveryCapability }).slash,
  gemini: (gemini as { slash?: SlashDiscoveryCapability }).slash,
  grok: grok.slash,
};

const slashOf = (b: SlashBackend) => (b === 'nomi' ? undefined : PLUGIN_SLASH[b]);
export type SlashEntryKind = 'command' | 'skill' | 'agent' | 'plugin' | 'mcp';
export type SlashEntryScope = 'project' | 'user' | 'plugin' | 'bundled';

export interface SlashEntry {
  /** 稳定 id：`<scope>:<kind>:<plugin?>:<name>`；展开时凭它在主进程里找回路径 */
  id: string;
  /** 输入的命令名（不含 /）；插件内的条目带 `插件名:` 前缀 */
  name: string;
  kind: SlashEntryKind;
  scope: SlashEntryScope;
  description: string;
  argumentHint?: string;
  /** false = frontmatter 声明 user-invocable: false，只在面板里展示，不进 / 菜单 */
  userInvocable: boolean;
  plugin?: string;
  /** 仅用于展示的路径（相对项目 / ~ 开头） */
  where: string;
  /** mcp：传输类型 */
  transport?: 'stdio' | 'http';
}

export interface SlashDiscovery {
  backend: SlashBackend;
  entries: SlashEntry[];
  /** 该端是否有公开文档化的目录可扫描（dsh / nomi 为 false） */
  supported: boolean;
}

const MAX_ENTRIES_PER_DIR = 200;
const MAX_DEPTH = 3;
const HEAD_BYTES = 8 * 1024;
const BODY_BYTES = 64 * 1024;
const MAX_WALK_UP = 12;
const DESC_MAX = 300;

/** 这些文件名一律不读（词法路径与符号链接解析后的真实路径都要过这一关） */
export const DENY =
  /(^|\/)(\.credentials.*|auth\.json|\.env.*|.*\.key|.*\.pem|.*\.(p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.dockercfg|kubeconfig|credentials(\.json)?|settings(\.local)?\.json|config\.toml|\.claude\.json|service[-_]?account.*\.json|.*\.tfvars(\.json)?|secrets?(\.[\w-]+)?\.(json|ya?ml|toml|env|txt)|\.htpasswd|.*\.kdbx|history\.jsonl|\.[\w-]*_history)$/i;

/** 真实路径落在这些目录里一律不读（链接到 ~/.ssh、.git/config 之类） */
export const DENY_DIR =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.docker|\.git|\.password-store|Keychains)(\/|$)|(^|\/)\.config\/(gcloud|gh|git)(\/|$)/i;

/** 用户级 agent 目录里会被发现的内容子目录：项目条目的符号链接只能指到这些地方 */
const USER_CONTENT_DIRS = [
  '.claude/skills',
  '.claude/commands',
  '.claude/agents',
  '.agents/skills',
  '.grok/skills',
  '.grok/commands',
  '.grok/plugins',
  '.grok/workflows',
  '.grok/bundled',
];

interface Internal {
  entry: SlashEntry;
  file: string;
  /** skill 目录（SKILL.md 所在） */
  dir?: string;
}

/** 额外的访问策略：真实路径是否在允许的根之内（项目内的符号链接不能指到项目与用户 agent 目录之外） */
export interface ReadPolicy {
  allow(realFile: string): boolean;
}

const norm = (p: string) => p.replace(/\\/g, '/');

function isWithin(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 读文件开头。凭据拒读规则同时作用于传入路径（别名）与解析符号链接后的真实路径，
 * 并按真实路径打开、打开后再校验仍是同一个文件，避免「检查别名、读取目标」或检查后被替换。
 */
function readHead(file: string, bytes: number, policy?: ReadPolicy): string | null {
  if (DENY.test(norm(file))) return null;
  let fd: number | null = null;
  try {
    const real = fs.realpathSync(file);
    const n = norm(real);
    if (DENY.test(n) || DENY_DIR.test(n)) return null;
    // 链接不能改变文件类型：SKILL.md 只能指向 .md，plugin.json 只能指向 .json（#16：防止链到会话记录等）
    if (path.extname(real).toLowerCase() !== path.extname(file).toLowerCase()) return null;
    if (policy && !policy.allow(real)) return null;
    fd = fs.openSync(real, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    // 打开后路径必须仍解析到同一个文件（防止 realpath 与 open 之间被换成别的链接）
    const again = fs.statSync(real);
    if (again.ino !== st.ino || again.dev !== st.dev || fs.realpathSync(real) !== real) return null;
    const buf = Buffer.alloc(Math.min(bytes, st.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
  }
}

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/** 极简 frontmatter 解析：只认文件第一行 `---` 开头；`key: value`，支持 `>` / `|` 块标量与 `- a` 列表 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const t = text.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(t)) return { meta: {}, body: t };
  const lines = t.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) return { meta: {}, body: t };
  const meta: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let val = m[2]!;
    if (/^[>|][+-]?$/.test(val.trim()) || val.trim() === '') {
      const parts: string[] = [];
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1]!)) {
        i++;
        parts.push(lines[i]!.trim().replace(/^-\s+/, ''));
      }
      val = parts.join(val.trim().startsWith('|') ? '\n' : ' ');
    }
    meta[key] = unquote(val);
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

const isFalse = (v: string | undefined) => v !== undefined && /^(false|no|off|0)$/i.test(v.trim());

function firstLine(body: string): string {
  for (const l of body.split(/\r?\n/)) {
    const s = l.replace(/^#+\s*/, '').trim();
    if (s) return s;
  }
  return '';
}

const clip = (s: string, n = DESC_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 与输入框命令名规则一致，保证发现出来的名字打得出来 */
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/** 工作流文件开头的 name / description。只认文本，不执行。 */
function workflowMeta(text: string): { name?: string; description?: string } {
  const field = (key: string) => {
    const m = new RegExp(
      `(?:^|\\n)\\s*(?:\\*\\s*)?${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n]+))`,
    ).exec(text);
    const v = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim().replace(/,\s*$/, '');
    return v || undefined;
  };
  return { name: field('name'), description: field('description') };
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES_PER_DIR);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** cwd 向上到含 `.git` 的目录（含）；没有 .git 就只取 cwd 自己 */
export function projectChain(cwd: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(cwd);
  let root: string | null = null;
  for (let i = 0, p = cur; i < MAX_WALK_UP; i++) {
    if (fs.existsSync(path.join(p, '.git'))) {
      root = p;
      break;
    }
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  if (!root) return [cur];
  for (let i = 0; i < MAX_WALK_UP; i++) {
    out.push(cur);
    if (cur === root) break;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

class Collector {
  readonly items: Internal[] = [];
  private readonly seen = new Set<string>();
  /** 项目目录链（词法 / 真实路径）与用户 agent 目录（词法 / 真实路径） */
  private readonly projectLexical: string[];
  private readonly projectReal: string[];
  private readonly userLexical: string[];
  private readonly userReal: string[];
  constructor(
    private readonly cwd: string,
    private readonly home: string,
  ) {
    const chain = projectChain(cwd);
    this.projectLexical = chain.map((d) => path.resolve(d));
    this.projectReal = chain.map(realOrSelf);
    // 项目条目可以链接到用户级 agent 目录里「会被发现的」内容子目录（共享 skill / 命令），
    // 不能链接到整个 ~/.claude 等（里面有会话记录、历史等，#16）
    const user = USER_CONTENT_DIRS.map((d) => path.join(home, d));
    this.userLexical = user.map((d) => path.resolve(d));
    this.userReal = user.map(realOrSelf);
  }

  /**
   * 受策略约束地读取：
   * - 来自项目目录的条目（仓库内容不可信）：符号链接的真实目标必须仍在项目树或用户 agent 目录内；
   * - 来自用户目录的条目是用户自己建的，允许链接到别处（共享 skills），只受凭据拒读规则约束。
   */
  read(file: string, bytes: number): string | null {
    const lex = path.resolve(file);
    const inUser = this.userLexical.some((r) => isWithin(r, lex));
    const inProject = !inUser && this.projectLexical.some((r) => isWithin(r, lex));
    const policy: ReadPolicy | undefined = inProject
      ? {
          allow: (real) => [...this.projectReal, ...this.userReal].some((r) => isWithin(r, real)),
        }
      : undefined;
    return readHead(file, bytes, policy);
  }

  where(file: string): string {
    const rel = path.relative(this.cwd, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
    const h = path.relative(this.home, file);
    if (h && !h.startsWith('..') && !path.isAbsolute(h)) return `~/${h.replace(/\\/g, '/')}`;
    return path.basename(file);
  }

  add(i: Internal) {
    if (this.seen.has(i.entry.id)) return;
    this.seen.add(i.entry.id);
    this.items.push(i);
  }

  /** commands/**\/*.md：子目录用 `:` 连接 */
  commands(dir: string, scope: SlashEntryScope, plugin?: string, depth = 0, prefix = '') {
    for (const d of listDir(dir)) {
      const full = path.join(dir, d.name);
      if (d.name.startsWith('.')) continue;
      if (d.isDirectory() || (d.isSymbolicLink() && isDir(full))) {
        if (depth < MAX_DEPTH) this.commands(full, scope, plugin, depth + 1, `${prefix}${d.name}:`);
        continue;
      }
      if (!d.name.toLowerCase().endsWith('.md')) continue;
      const head = this.read(full, HEAD_BYTES);
      if (head === null) continue;
      const { meta, body } = parseFrontmatter(head);
      const base = `${prefix}${d.name.slice(0, -3)}`;
      const name = plugin ? `${plugin}:${base}` : base;
      this.add({
        file: full,
        entry: {
          id: `${scope}:command:${plugin ?? ''}:${base}`,
          name,
          kind: 'command',
          scope,
          description: clip(meta.description || firstLine(body)),
          ...(meta['argument-hint'] ? { argumentHint: clip(meta['argument-hint'], 80) } : {}),
          userInvocable: !isFalse(meta['user-invocable']) && !isFalse(meta['user_invocable']),
          ...(plugin ? { plugin } : {}),
          where: this.where(full),
        },
      });
    }
  }

  /** skills/<name>/SKILL.md */
  skills(
    dir: string,
    scope: SlashEntryScope,
    plugin?: string,
    opts: { strictInvocable?: boolean } = {},
  ) {
    for (const d of listDir(dir)) {
      const sub = path.join(dir, d.name);
      if (d.name.startsWith('.') || !(d.isDirectory() || (d.isSymbolicLink() && isDir(sub))))
        continue;
      const file = path.join(sub, 'SKILL.md');
      const head = this.read(file, HEAD_BYTES);
      if (head === null) continue;
      const { meta, body } = parseFrontmatter(head);
      const base = meta.name?.trim() || d.name;
      const name = plugin ? `${plugin}:${base}` : base;
      this.add({
        file,
        dir: sub,
        entry: {
          id: `${scope}:skill:${plugin ?? ''}:${base}`,
          name,
          kind: 'skill',
          scope,
          description: clip(
            [meta.description, meta.when_to_use ?? meta['when-to-use']].filter(Boolean).join(' ') ||
              firstLine(body),
          ),
          ...(meta['argument-hint'] ? { argumentHint: clip(meta['argument-hint'], 80) } : {}),
          // Grok：只有字面量 true 才算可调用；Claude：user-invocable: false 才隐藏
          userInvocable: opts.strictInvocable
            ? meta['user-invocable'] === undefined || meta['user-invocable'] === 'true'
            : !isFalse(meta['user-invocable']),
          ...(plugin ? { plugin } : {}),
          where: this.where(sub),
        },
      });
    }
  }

  agents(dir: string, scope: SlashEntryScope) {
    for (const d of listDir(dir)) {
      if (d.name.startsWith('.') || !d.name.toLowerCase().endsWith('.md')) continue;
      const full = path.join(dir, d.name);
      const head = this.read(full, HEAD_BYTES);
      if (head === null) continue;
      const { meta, body } = parseFrontmatter(head);
      const name = meta.name?.trim() || d.name.slice(0, -3);
      this.add({
        file: full,
        entry: {
          id: `${scope}:agent::${name}`,
          name,
          kind: 'agent',
          scope,
          description: clip(meta.description || firstLine(body)),
          userInvocable: false,
          where: this.where(full),
        },
      });
    }
  }

  /** `.mcp.json`：只取 mcpServers 的键名与传输类型，不读 env / headers / args / command */
  mcp(file: string, scope: SlashEntryScope, plugin?: string) {
    const raw = this.read(file, 256 * 1024);
    if (raw === null) return;
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      return;
    }
    const servers = (j as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
    if (!servers || typeof servers !== 'object') return;
    for (const [key, v] of Object.entries(servers).slice(0, MAX_ENTRIES_PER_DIR)) {
      const o = (v && typeof v === 'object' ? v : {}) as { type?: unknown; url?: unknown };
      const http = typeof o.url === 'string' || o.type === 'http' || o.type === 'sse';
      this.add({
        file,
        entry: {
          id: `${scope}:mcp:${plugin ?? ''}:${key}`,
          name: key,
          kind: 'mcp',
          scope,
          description: '',
          userInvocable: false,
          ...(plugin ? { plugin } : {}),
          where: this.where(file),
          transport: http ? 'http' : 'stdio',
        },
      });
    }
  }

  /**
   * Grok 工作流：`workflows/*.(rhai|js)`。Grok 用 `/<name>` 启动。
   * 只读开头的 name / description，不执行文件。id 用 workflow 段，避免和同名命令文件撞车。
   */
  workflows(dir: string, scope: SlashEntryScope) {
    for (const d of listDir(dir)) {
      if (d.name.startsWith('.') || d.isDirectory()) continue;
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink() && isDir(full)) continue;
      const lower = d.name.toLowerCase();
      if (!lower.endsWith('.rhai') && !lower.endsWith('.js')) continue;
      const head = this.read(full, HEAD_BYTES);
      if (head === null) continue;
      const meta = workflowMeta(head);
      const stem = d.name.replace(/\.(rhai|js)$/i, '');
      const raw = meta.name?.trim() || stem;
      const base = SAFE_NAME.test(raw) ? raw : SAFE_NAME.test(stem) ? stem : '';
      if (!base) continue;
      this.add({
        file: full,
        entry: {
          id: `${scope}:workflow::${base}`,
          name: base,
          kind: 'command',
          scope,
          description: clip(meta.description ?? ''),
          userInvocable: true,
          where: this.where(full),
        },
      });
    }
  }

  /** Grok 插件：`plugins/<name>/`，可选 plugin.json（只取 name / description） */
  plugins(dir: string, scope: SlashEntryScope) {
    for (const d of listDir(dir)) {
      const sub = path.join(dir, d.name);
      if (d.name.startsWith('.') || d.name === 'marketplaces' || !isDir(sub)) continue;
      let name = d.name;
      let description = '';
      const mf = this.read(path.join(sub, 'plugin.json'), HEAD_BYTES);
      if (mf) {
        try {
          const j = JSON.parse(mf) as { name?: unknown; description?: unknown };
          if (typeof j.name === 'string' && j.name.trim()) name = j.name.trim();
          if (typeof j.description === 'string') description = clip(j.description);
        } catch {
          /* ignore */
        }
      }
      this.add({
        file: sub,
        entry: {
          id: `${scope}:plugin::${name}`,
          name,
          kind: 'plugin',
          scope,
          description,
          userInvocable: false,
          plugin: name,
          where: this.where(sub),
        },
      });
      this.skills(path.join(sub, 'skills'), 'plugin', name, { strictInvocable: true });
      this.commands(path.join(sub, 'commands'), 'plugin', name);
      this.agents(path.join(sub, 'agents'), 'plugin');
      this.mcp(path.join(sub, '.mcp.json'), 'plugin', name);
    }
  }
}

function collect(backend: SlashBackend, cwd: string, home: string): Collector {
  const c = new Collector(cwd, home);
  const sources = slashOf(backend)?.sources?.({ projectChain: projectChain(cwd), home }) ?? [];
  for (const src of sources) {
    if (src.kind === 'skills')
      c.skills(src.path, src.scope, undefined, { strictInvocable: src.strictInvocable });
    else if (src.kind === 'commands') c.commands(src.path, src.scope);
    else if (src.kind === 'agents') c.agents(src.path, src.scope);
    else if (src.kind === 'mcp') c.mcp(src.path, src.scope);
    else if (src.kind === 'plugins') c.plugins(src.path, src.scope);
    else c.workflows(src.path, src.scope);
  }
  return c;
}

export const hasPublicLayout = (b: SlashBackend) => Boolean(slashOf(b)?.sources);

export function discoverSlash(
  backend: SlashBackend,
  cwd: string,
  home: string = os.homedir(),
): SlashDiscovery {
  if (!hasPublicLayout(backend)) return { backend, entries: [], supported: false };
  return {
    backend,
    entries: collect(backend, cwd, home).items.map((i) => i.entry),
    supported: true,
  };
}

/** 参数拆分：shell 风格引号，`"hello world" b` → ['hello world','b'] */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * 占位符展开（依据 Claude Code skills 文档的语法，Grok / Codex 展开沿用）：
 * `$ARGUMENTS`、`$ARGUMENTS[N]`、`$N`（0 起）、`arguments:` 声明的命名参数 `$name`；
 * `\$` 转义；没有任何占位符接收参数时在末尾追加 `ARGUMENTS: <args>`。
 */
export function expandTemplate(
  body: string,
  args: string,
  named: string[] = [],
): { text: string; consumed: boolean } {
  const list = splitArgs(args);
  let consumed = false;
  const names = named.filter((n) => /^[A-Za-z_]\w*$/.test(n));
  const re = /\\\$|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)|\$([A-Za-z_]\w*)/g;
  const text = body.replace(re, (m, idx1?: string, idx2?: string, nm?: string) => {
    if (m === '\\$') return '$';
    if (m === '$ARGUMENTS') {
      consumed = true;
      return args;
    }
    const idx = idx1 ?? idx2;
    if (idx !== undefined) {
      const v = list[Number(idx)];
      if (v === undefined) return m;
      consumed = true;
      return v;
    }
    if (nm !== undefined) {
      const k = names.indexOf(nm);
      if (k < 0) return m;
      consumed = true;
      return list[k] ?? '';
    }
    return m;
  });
  return { text, consumed };
}

export interface SlashExpansion {
  text: string;
  /** 正文里有 `!`cmd`` 动态注入：Nomi 不执行，原样保留 */
  shellInjection: boolean;
}

/** 按 id 展开一个命令 / skill 为提示词；id 不在发现结果里（或类型不可展开）返回 null */
export function expandSlash(
  backend: SlashBackend,
  cwd: string,
  id: string,
  args: string,
  home: string = os.homedir(),
): SlashExpansion | null {
  if (!hasPublicLayout(backend)) return null;
  const collector = collect(backend, cwd, home);
  const hit = collector.items.find((i) => i.entry.id === id);
  if (!hit || (hit.entry.kind !== 'command' && hit.entry.kind !== 'skill')) return null;
  // 工作流是脚本，展开会把源码当提示词发出去。Grok 自己执行 `/name`。
  if (hit.entry.id.split(':')[1] === 'workflow') return null;
  const raw = collector.read(hit.file, BODY_BYTES);
  if (raw === null) return null;
  const { meta, body } = parseFrontmatter(raw);
  const named = (meta.arguments ?? '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^\[|\]$/g, ''))
    .filter(Boolean);
  const { text, consumed } = expandTemplate(body.trim(), args.trim(), named);
  const shellInjection = /(^|\s)!`[^`]+`|^```!/m.test(body);
  const header =
    hit.entry.kind === 'skill' && hit.dir ? `[Skill: ${hit.entry.name} — ${hit.dir}]\n\n` : '';
  const tail = !consumed && args.trim() ? `\n\nARGUMENTS: ${args.trim()}` : '';
  return { text: `${header}${text}${tail}`.trim(), shellInjection };
}

export interface GitDiffResult {
  ok: boolean;
  status: string;
  stat: string;
  diff: string;
  /** 暂存区相对 HEAD（`git diff --cached`）；右栏「已暂存」分组用 */
  staged?: string;
  /** 工作区相对暂存区（`git diff`）；右栏「未暂存」分组用 */
  unstaged?: string;
  truncated: boolean;
  /**
   * 每个文件的增删行数（`git diff --numstat`，不受 diff 文本上限影响）：head = 相对 HEAD，
   * staged / unstaged 同上面两份 diff。二进制文件不在里面。
   */
  numstat?: { head: NumstatMap; staged: NumstatMap; unstaged: NumstatMap };
  error?: string;
}

export type NumstatMap = Record<string, { added: number; removed: number }>;

/**
 * 解析 `git diff --numstat -z`：普通文件「增\t删\t路径\0」；改名「增\t删\t\0旧路径\0新路径\0」（取新路径）；
 * 二进制的增删是 "-"，跳过。
 */
export function parseNumstat(raw: string): NumstatMap {
  const out: NumstatMap = {};
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]!.replace(/^\n/, ''));
    if (!m) continue;
    let file = m[3]!;
    if (!file) {
      // 改名：后面两段是旧路径 / 新路径
      file = parts[i + 2] ?? '';
      i += 2;
    }
    if (!file || m[1] === '-' || m[2] === '-') continue;
    out[file] = { added: Number(m[1]), removed: Number(m[2]) };
  }
  return out;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', '-c', 'core.quotepath=false', ...args],
      {
        cwd,
        timeout: 8000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: (() => {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
            NO_COLOR: '1',
          };
          for (const k of [
            'GIT_DIR',
            'GIT_WORK_TREE',
            'GIT_COMMON_DIR',
            'GIT_PREFIX',
            'GIT_INDEX_FILE',
            'GIT_OBJECT_DIRECTORY',
            'GIT_ALTERNATE_OBJECT_DIRECTORIES',
          ] as const) {
            delete env[k];
          }
          return env;
        })(),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        // 用 git 自己的原因（stderr 第一行，如「fatal: not a git repository」）当错误信息：
        // Node 的 message 第一行只是「Command failed: git …」，界面据此认不出「不是 git 仓库」（会把命令原样显示出来）
        const reason = String(stderr ?? '')
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean);
        reject(reason ? new Error(reason) : err);
      },
    );
  });
}

/** 每份 diff 文本的上限：多语言 json / 生成文件改得多时一轮就能有几百 KB；行数另由 numstat 给全 */
const DIFF_MAX = 4 * 1024 * 1024;

export interface GitBranchResult {
  /** 当前分支名；游离 HEAD 时为 null */
  branch: string | null;
  /** 游离 HEAD 时的短提交号 */
  detached?: string;
}

/** 对话顶栏的分支提示（只读）：不是 git 仓库 / git 不可用时返回 null */
export async function gitBranch(cwd: string): Promise<GitBranchResult | null> {
  const branch = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (branch) return { branch };
  const sha = (await git(cwd, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim();
  return sha ? { branch: null, detached: sha } : null;
}

/** `/diff`：只读的 git status / diff（不跑外部 diff 驱动与 textconv） */
export async function gitDiff(cwd: string): Promise<GitDiffResult> {
  try {
    const flags = ['--no-ext-diff', '--no-textconv', '--no-color'];
    const status = (await git(cwd, ['status', '--short', '--untracked-files=normal'])).trim();
    const stat = (await git(cwd, ['diff', ...flags, '--stat', 'HEAD']).catch(() => '')).trim();
    const [full, cached, work, nsHead, nsStaged, nsWork] = await Promise.all([
      git(cwd, ['diff', ...flags, 'HEAD']).catch(() => ''),
      git(cwd, ['diff', ...flags, '--cached']).catch(() => ''),
      git(cwd, ['diff', ...flags]).catch(() => ''),
      git(cwd, ['diff', ...flags, '--numstat', '-z', 'HEAD']).catch(() => ''),
      git(cwd, ['diff', ...flags, '--numstat', '-z', '--cached']).catch(() => ''),
      git(cwd, ['diff', ...flags, '--numstat', '-z']).catch(() => ''),
    ]);
    const truncated = [full, cached, work].some((d) => d.length > DIFF_MAX);
    const cap = (d: string) => (d.length > DIFF_MAX ? d.slice(0, DIFF_MAX) : d);
    return {
      ok: true,
      status,
      stat,
      diff: cap(full),
      staged: cap(cached),
      unstaged: cap(work),
      truncated,
      numstat: {
        head: parseNumstat(nsHead),
        staged: parseNumstat(nsStaged),
        unstaged: parseNumstat(nsWork),
      },
    };
  } catch (e) {
    return {
      ok: false,
      status: '',
      stat: '',
      diff: '',
      truncated: false,
      error: e instanceof Error ? e.message.split('\n')[0] : String(e),
    };
  }
}
