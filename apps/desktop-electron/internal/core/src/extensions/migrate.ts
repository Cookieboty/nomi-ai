/**
 * 从其他工具导入 MCP 服务器与技能（#58）：只读发现 + 转换，不写任何东西。
 *
 * 来源（依据官方文档，路径不确定处宽松处理）：
 * - Claude Code：`~/.claude.json` 的 `mcpServers`（user 作用域）与 `projects[<路径>].mcpServers`
 *   （local 作用域）；项目根 `.mcp.json`（project 作用域）；技能 `~/.claude/skills/<名>/SKILL.md`、
 *   项目 `.claude/skills`。设置了 `CLAUDE_CONFIG_DIR` 时也看那里。
 * - Codex：`$CODEX_HOME/config.toml`（默认 `~/.codex`）的 `[mcp_servers.<名>]`、项目 `.codex/config.toml`；
 *   技能 `~/.agents/skills`（官方位置）、`$CODEX_HOME/skills`（旧位置）、项目 `.agents/skills`。
 *
 * 安全（#16）：
 * - 只读上面这几个固定文件名；符号链接解析后的真实文件名必须不变、不能落在 ~/.ssh 等凭据目录、
 *   必须仍在用户目录（或项目目录）里；按真实路径打开并在打开后校验仍是同一个文件。
 * - `~/.claude.json` 里还有会话 / 账号信息：解析后只取 `mcpServers`，其余立即丢弃，不返回、不记录。
 * - 技能是**复制**（快照）而不是引用：不跟随技能目录里的符号链接、跳过凭据类文件名与隐藏文件、
 *   总大小 ≤ 5 MB；项目里的技能目录如果链接到项目 / 用户技能目录之外则拒绝。
 * 渲染进程拿到的只有脱敏后的预览和一个 key，路径永远在主进程里。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { DENY, DENY_DIR, parseFrontmatter } from '../cli/slashDiscovery';
import { t } from '../i18n';

import { McpConfigError, sanitizeServer, type McpServerEntry } from './mcpConfig';
import { validSkillName } from './skillPack';

export type MigrateTool = 'claude' | 'codex';
export type MigrateScope = 'user' | 'local' | 'project';

export interface McpCandidate {
  key: string;
  kind: 'mcp';
  tool: MigrateTool;
  scope: MigrateScope;
  name: string;
  /** 仅展示用（~ 开头或项目相对） */
  where: string;
  server?: McpServerEntry;
  warnings: string[];
  error?: string;
}

export interface SkillCandidate {
  key: string;
  kind: 'skill';
  tool: MigrateTool;
  scope: MigrateScope;
  name: string;
  description: string;
  where: string;
  /** 真实目录（主进程内部用，不发给渲染进程） */
  dir: string;
  files: string[];
  bytes: number;
  /** 原 SKILL.md 的头部 Nomi 读不了（多行描述等），复制时需要规范化 */
  normalize: boolean;
  body: string;
  warnings: string[];
  error?: string;
}

export interface MigrateSource {
  tool: MigrateTool;
  where: string;
  found: boolean;
  error?: string;
}

export interface MigrateScan {
  mcp: McpCandidate[];
  skills: SkillCandidate[];
  sources: MigrateSource[];
}

export interface MigrateEnv {
  home: string;
  env?: Record<string, string | undefined>;
  /** 用户在界面里选的项目文件夹（可选） */
  projectDir?: string | null;
}

const MAX_CLAUDE_JSON = 32 * 1024 * 1024; // ~/.claude.json 带历史记录，可能很大
const MAX_CONFIG = 1024 * 1024;
const MAX_SKILL_MD = 256 * 1024;
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_ENTRIES = 200;

const norm = (p: string) => p.replace(/\\/g, '/');

function isWithin(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

type ReadResult = { text: string } | { missing: true } | { error: string };

/**
 * 读一个固定名字的配置文件：真实路径必须在 allowRoots 之内、文件名不变、不在凭据目录里，
 * 按真实路径打开、打开后再校验仍是同一个文件（防止检查后被替换成别的链接）。
 */
export function readConfigFile(file: string, maxBytes: number, allowRoots: string[]): ReadResult {
  let fd: number | null = null;
  try {
    try {
      fs.lstatSync(file);
    } catch {
      return { missing: true };
    }
    const real = fs.realpathSync(file);
    if (path.basename(real) !== path.basename(file) || DENY_DIR.test(norm(real)))
      return { error: t('electron.common.skipped-a-symbolic-link-points-somewhere-that-may') };
    const roots = allowRoots.map(realOrNull).filter((r): r is string => !!r);
    if (!roots.some((r) => isWithin(r, real)))
      return { error: t('electron.common.skipped-a-symbolic-link-points-somewhere-that-may') };
    fd = fs.openSync(real, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: t('electron.common.skipped-not-a-regular-file') };
    if (st.size > maxBytes) return { error: t('electron.common.skipped-file-too-large') };
    const again = fs.statSync(real);
    if (again.ino !== st.ino || again.dev !== st.dev || fs.realpathSync(real) !== real)
      return { error: t('electron.common.skipped-the-file-changed-while-being-read') };
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString('utf8') };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 200) };
  } finally {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
  }
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/;

function strings(o: unknown, out: string[] = []): string[] {
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) for (const x of o) strings(x, out);
  else if (o && typeof o === 'object') for (const x of Object.values(o)) strings(x, out);
  return out;
}

function varWarnings(raw: Record<string, unknown>): string[] {
  const vars = new Set<string>();
  for (const s of strings([raw.command, raw.args, raw.url, raw.env, raw.headers])) {
    const re = new RegExp(VAR_REF.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) vars.add(m[1]!);
  }
  return vars.size
    ? [
        t(
          'electron.common.contains-environment-variable-references-nomi-does-not-expand',
          [...vars].map((v) => `\${${v}}`).join('、'),
        ),
      ]
    : [];
}

/** Claude Code 的一条 mcpServers 配置 → sanitizeServer 的输入 + 提示 */
export function fromClaudeEntry(
  name: string,
  v: unknown,
): { raw?: Record<string, unknown>; warnings: string[]; error?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return { warnings: [], error: t('electron.common.invalid-configuration') };
  const o = v as Record<string, unknown>;
  const warnings: string[] = [];
  const type = typeof o.type === 'string' ? o.type.toLowerCase() : undefined;
  let transport: 'stdio' | 'http' | 'sse';
  if (type === 'ws' || type === 'sdk')
    return { warnings, error: t('electron.common.nomi-doesn-t-support-mcp-servers-yet', type) };
  if (type === 'sse') transport = 'sse';
  else if (type === 'http' || type === 'streamable-http') transport = 'http';
  else if (type === 'stdio') transport = 'stdio';
  else if (type) return { warnings, error: t('electron.common.unknown-type', type) };
  else if (typeof o.url === 'string') {
    transport = 'http';
    warnings.push(t('electron.common.no-type-given-imported-as-remote-http'));
  } else transport = 'stdio';
  if (o.headersHelper)
    warnings.push(t('electron.common.headershelper-dynamic-headers-is-not-imported-fill-in'));
  if (o.oauth) warnings.push(t('electron.common.the-original-config-signs-in-with-oauth-nomi'));
  const raw: Record<string, unknown> =
    transport === 'stdio'
      ? { name, transport, command: o.command, args: o.args, env: o.env }
      : { name, transport, url: o.url, headers: o.headers };
  warnings.push(...varWarnings(raw));
  return { raw, warnings };
}

/** Codex 的一条 [mcp_servers.<名>] → sanitizeServer 的输入 + 提示 */
export function fromCodexEntry(
  name: string,
  v: unknown,
): { raw?: Record<string, unknown>; warnings: string[]; error?: string; disabled?: boolean } {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return { warnings: [], error: t('electron.common.invalid-configuration') };
  const o = v as Record<string, unknown>;
  const warnings: string[] = [];
  const http = typeof o.url === 'string';
  if (http) {
    if (typeof o.bearer_token_env_var === 'string')
      warnings.push(
        t(
          'electron.common.the-token-comes-from-the-environment-variable-which',
          o.bearer_token_env_var,
        ),
      );
    if (o.env_http_headers && typeof o.env_http_headers === 'object')
      warnings.push(
        t(
          'electron.common.these-header-values-come-from-environment-variables-and',
          Object.keys(o.env_http_headers).join('、'),
        ),
      );
    if (o.http_headers_helper)
      warnings.push(t('electron.common.http-headers-helper-dynamic-headers-is-not-imported'));
  } else {
    if (Array.isArray(o.env_vars) && o.env_vars.length)
      warnings.push(
        t(
          'electron.common.the-original-config-forwards-these-environment-variables-nomi',
          o.env_vars
            .map((x) => (typeof x === 'string' ? x : String((x as { name?: unknown })?.name ?? '')))
            .filter(Boolean)
            .join('、'),
        ),
      );
    if (typeof o.cwd === 'string')
      warnings.push(t('electron.common.nomi-doesn-t-support-a-working-directory-cwd'));
  }
  if (o.oauth || o.auth === 'oauth')
    warnings.push(t('electron.common.the-original-config-signs-in-with-oauth-nomi'));
  const raw: Record<string, unknown> = http
    ? {
        name,
        transport: /\/sse\/?$/.test(String(o.url)) ? 'sse' : 'http',
        url: o.url,
        headers: o.http_headers,
      }
    : { name, transport: 'stdio', command: o.command, args: o.args, env: o.env };
  return { raw, warnings, disabled: o.enabled === false };
}

/**
 * 来源文件的稳定身份：规范化路径的短哈希（key 里不出现路径本身，重扫不变）。
 * 自定义 CLAUDE_CONFIG_DIR 与 ~/.claude.json 里的同名条目靠它区分，预览与导入一一对应（#74）。
 */
function sourceId(file: string): string {
  return createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 10);
}

/** 兜底：key 必须唯一（缓存按 key 取），万一撞了给后来者加序号，不能让后者覆盖前者 */
function uniqueKeys(list: Array<{ key: string }>): void {
  const seen = new Set<string>();
  for (const c of list) {
    let k = c.key;
    for (let i = 2; seen.has(k); i++) k = `${c.key}#${i}`;
    c.key = k;
    seen.add(k);
  }
}

function toCandidate(
  tool: MigrateTool,
  scope: MigrateScope,
  where: string,
  name: string,
  conv: { raw?: Record<string, unknown>; warnings: string[]; error?: string; disabled?: boolean },
  src: string,
  keySuffix = '',
): McpCandidate {
  const key = `${tool}:${scope}:mcp:${src}:${keySuffix}${name}`;
  const base = { key, kind: 'mcp' as const, tool, scope, name, where, warnings: conv.warnings };
  if (conv.error || !conv.raw)
    return { ...base, error: conv.error ?? t('electron.common.invalid-configuration') };
  try {
    const server = sanitizeServer({ ...conv.raw, origin: 'user', trust: 'ask' });
    if (conv.disabled) base.warnings.push(t('electron.common.disabled-in-the-original-config'));
    return { ...base, server };
  } catch (e) {
    return { ...base, error: e instanceof McpConfigError ? e.message : String(e) };
  }
}

function claudeServers(
  j: unknown,
  tool: MigrateTool,
  scope: MigrateScope,
  where: string,
  src: string,
  keySuffix = '',
): McpCandidate[] {
  const servers = (j as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>)
    .slice(0, MAX_ENTRIES)
    .map(([name, v]) =>
      toCandidate(tool, scope, where, name, fromClaudeEntry(name, v), src, keySuffix),
    );
}

function display(home: string, p: string, project?: string | null): string {
  if (project) {
    const r = path.relative(project, p);
    if (r && !r.startsWith('..') && !path.isAbsolute(r))
      return `${path.basename(project)}/${norm(r)}`;
  }
  const h = path.relative(home, p);
  if (h && !h.startsWith('..') && !path.isAbsolute(h)) return `~/${norm(h)}`;
  return norm(p);
}

// ───────────── 技能 ─────────────

/** 技能目录内的文件（不跟随符号链接、跳过隐藏文件；返回被跳过的凭据类文件） */
function walk(root: string): {
  files: string[];
  denied: string[];
  links: number;
  truncated: boolean;
} {
  const files: string[] = [];
  const denied: string[] = [];
  let links = 0;
  let truncated = false;
  const rec = (rel: string, depth: number) => {
    if (depth > 4) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        links++;
        continue;
      }
      if (e.isDirectory()) rec(r, depth + 1);
      else if (e.isFile()) {
        if (DENY.test(r) || DENY.test(e.name)) denied.push(r);
        else files.push(r);
      }
    }
  };
  rec('', 0);
  return { files, denied, links, truncated };
}

/** 把别家的技能名变成 Nomi 允许的名字（小写字母 / 数字 / 连字符） */
export function nomiSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function firstLine(body: string): string {
  for (const l of body.split(/\r?\n/)) {
    const s = l.replace(/^#+\s*/, '').trim();
    if (s) return s;
  }
  return '';
}

/** Nomi 的 SKILL.md 解析器只认单行 `key: value`；判断原头部是否可以原样使用 */
function nomiReadable(text: string, name: string): boolean {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return false;
  const kv: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const x = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (x) kv[x[1]!.toLowerCase()] = x[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const d = kv.description ?? '';
  return kv.name === name && !!d && !/^[>|][+-]?$/.test(d);
}

function skillCandidate(
  tool: MigrateTool,
  scope: MigrateScope,
  sub: string,
  dirName: string,
  where: string,
  allow: (real: string) => boolean,
): SkillCandidate | null {
  const key = `${tool}:${scope}:skill:${where}`;
  const base = {
    key,
    kind: 'skill' as const,
    tool,
    scope,
    name: dirName,
    description: '',
    where,
    dir: sub,
    files: [] as string[],
    bytes: 0,
    normalize: false,
    body: '',
    warnings: [] as string[],
  };
  const real = realOrNull(sub);
  if (!real) return null;
  try {
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  if (DENY_DIR.test(norm(real)) || !allow(real))
    return {
      ...base,
      error: t('electron.common.skipped-a-symbolic-link-points-somewhere-that-may'),
    };
  const md = path.join(real, 'SKILL.md');
  let text: string;
  try {
    const st = fs.lstatSync(md);
    if (!st.isFile())
      return {
        ...base,
        dir: real,
        error: t('electron.common.skill-md-must-be-a-regular-file-not'),
      };
    if (st.size > MAX_SKILL_MD)
      return { ...base, dir: real, error: t('electron.common.skill-md-is-too-large') };
    text = fs.readFileSync(md, 'utf8');
  } catch {
    return null; // 不是技能目录
  }
  const { meta, body } = parseFrontmatter(text);
  const rawName = (meta.name ?? '').trim() || dirName;
  const name = nomiSkillName(rawName);
  const warnings: string[] = [];
  if (!validSkillName(name))
    return { ...base, dir: real, error: t('electron.common.invalid-skill-name', rawName) };
  if (name !== rawName)
    warnings.push(t('electron.common.name-adjusted-to-a-format-nomi-supports', name));
  let description = (meta.description ?? '').replace(/\s+/g, ' ').trim();
  const when = (meta.when_to_use ?? meta['when-to-use'] ?? '').trim();
  if (when) description = [description, when].filter(Boolean).join(' ');
  if (!description) {
    description = firstLine(body);
    if (description) warnings.push(t('electron.common.no-description-using-the-first-line-of-the'));
  }
  if (!description)
    return { ...base, name, dir: real, error: t('electron.common.missing-description') };
  const w = walk(real);
  if (w.denied.length)
    warnings.push(
      t(
        'electron.common.these-files-look-like-credentials-or-keys-and',
        w.denied.slice(0, 5).join('、'),
      ),
    );
  if (w.links)
    warnings.push(t('electron.common.symbolic-links-in-the-skill-folder-won-t', w.links));
  if (w.truncated)
    warnings.push(t('electron.common.too-many-files-only-the-first-are-copied', MAX_FILES));
  if (w.files.some((f) => /\.(sh|py|js|ts|mjs|cjs|ps1|bat|rb)$/i.test(f)))
    warnings.push(t('electron.common.bundled-scripts-are-copied-as-reference-files-only'));
  if (meta['allowed-tools'] || meta['allowed_tools'])
    warnings.push(t('electron.common.claude-code-specific-fields-such-as-allowed-tools'));
  let bytes = 0;
  for (const f of w.files) {
    try {
      bytes += fs.lstatSync(path.join(real, f)).size;
    } catch {
      /* ignore */
    }
  }
  const out: SkillCandidate = {
    ...base,
    name,
    description: description.slice(0, 1024),
    dir: real,
    files: w.files.filter((f) => f !== 'SKILL.md'),
    bytes,
    normalize: !nomiReadable(text, name),
    body: body.trim(),
    warnings,
  };
  if (bytes > MAX_SKILL_BYTES) out.error = t('electron.common.skill-pack-too-large-max-5-mb');
  return out;
}

function skillsIn(
  tool: MigrateTool,
  scope: MigrateScope,
  dir: string,
  home: string,
  project: string | null | undefined,
  allow: (real: string) => boolean,
): SkillCandidate[] {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillCandidate[] = [];
  for (const d of ents.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ENTRIES)) {
    if (d.name.startsWith('.')) continue;
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const sub = path.join(dir, d.name);
    const c = skillCandidate(tool, scope, sub, d.name, display(home, sub, project), allow);
    if (c) out.push(c);
  }
  return out;
}

// ───────────── 入口 ─────────────

export function discoverMigrations(e: MigrateEnv): MigrateScan {
  const home = path.resolve(e.home);
  const env = e.env ?? {};
  const project = e.projectDir ? path.resolve(e.projectDir) : null;
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : null;
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  const userRoots = [home, ...(claudeDir ? [claudeDir] : []), codexHome];
  const projectRoots = project ? [project] : [];
  const scan: MigrateScan = { mcp: [], skills: [], sources: [] };
  const seenFile = new Set<string>();

  const readJson = (
    tool: MigrateTool,
    file: string,
    max: number,
    roots: string[],
  ): unknown | undefined => {
    const where = display(home, file, project);
    const r = readConfigFile(file, max, roots);
    if ('missing' in r) {
      scan.sources.push({ tool, where, found: false });
      return undefined;
    }
    if ('error' in r) {
      scan.sources.push({ tool, where, found: true, error: r.error });
      return undefined;
    }
    try {
      const j = JSON.parse(r.text) as unknown;
      scan.sources.push({ tool, where, found: true });
      return j;
    } catch {
      scan.sources.push({ tool, where, found: true, error: t('electron.common.not-valid-json') });
      return undefined;
    }
  };

  // Claude Code：~/.claude.json（以及 CLAUDE_CONFIG_DIR/.claude.json）
  for (const f of [
    ...(claudeDir ? [path.join(claudeDir, '.claude.json')] : []),
    path.join(home, '.claude.json'),
  ]) {
    if (seenFile.has(f)) continue;
    seenFile.add(f);
    const j = readJson('claude', f, MAX_CLAUDE_JSON, userRoots) as
      Record<string, unknown> | undefined;
    if (!j || typeof j !== 'object') continue;
    const where = display(home, f, project);
    const src = sourceId(f);
    // 只取 mcpServers；文件里其它内容（账号、历史、项目状态）立即丢弃
    scan.mcp.push(...claudeServers({ mcpServers: j.mcpServers }, 'claude', 'user', where, src));
    const projects = j.projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [p, v] of Object.entries(projects as Record<string, unknown>).slice(
        0,
        MAX_ENTRIES,
      )) {
        const servers = (v as { mcpServers?: unknown } | null)?.mcpServers;
        if (!servers) continue;
        scan.mcp.push(
          ...claudeServers(
            { mcpServers: servers },
            'claude',
            'local',
            `${where} · ${p}`,
            src,
            `${p}:`,
          ),
        );
      }
    }
  }
  // Claude Code：项目 .mcp.json
  if (project) {
    const file = path.join(project, '.mcp.json');
    const j = readJson('claude', file, MAX_CONFIG, projectRoots);
    if (j)
      scan.mcp.push(
        ...claudeServers(j, 'claude', 'project', display(home, file, project), sourceId(file)),
      );
  }

  // Codex：config.toml（用户 + 项目）
  const codexFiles: Array<{ file: string; scope: MigrateScope; roots: string[] }> = [
    { file: path.join(codexHome, 'config.toml'), scope: 'user', roots: userRoots },
    ...(project
      ? [
          {
            file: path.join(project, '.codex', 'config.toml'),
            scope: 'project' as const,
            roots: projectRoots,
          },
        ]
      : []),
  ];
  for (const { file, scope, roots } of codexFiles) {
    const where = display(home, file, project);
    const r = readConfigFile(file, MAX_CONFIG, roots);
    if ('missing' in r) {
      scan.sources.push({ tool: 'codex', where, found: false });
      continue;
    }
    if ('error' in r) {
      scan.sources.push({ tool: 'codex', where, found: true, error: r.error });
      continue;
    }
    let tbl: Record<string, unknown>;
    try {
      tbl = parseToml(r.text) as Record<string, unknown>;
    } catch {
      scan.sources.push({
        tool: 'codex',
        where,
        found: true,
        error: t('electron.common.invalid-toml-couldn-t-parse-it'),
      });
      continue;
    }
    scan.sources.push({ tool: 'codex', where, found: true });
    const servers = tbl.mcp_servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, v] of Object.entries(servers as Record<string, unknown>).slice(
      0,
      MAX_ENTRIES,
    ))
      scan.mcp.push(
        toCandidate('codex', scope, where, name, fromCodexEntry(name, v), sourceId(file)),
      );
  }

  // 技能。用户目录里的技能允许链接到别处（用户自己建的共享技能），只受凭据目录规则约束；
  // 项目里的技能目录只能链接到项目内或用户技能目录内（仓库内容不可信）。
  const userSkillDirs = [
    ...(claudeDir ? [{ tool: 'claude' as const, dir: path.join(claudeDir, 'skills') }] : []),
    { tool: 'claude' as const, dir: path.join(home, '.claude', 'skills') },
    { tool: 'codex' as const, dir: path.join(home, '.agents', 'skills') },
    { tool: 'codex' as const, dir: path.join(codexHome, 'skills') },
  ];
  const userSkillReal = userSkillDirs.map((d) => realOrNull(d.dir)).filter((x): x is string => !!x);
  const seenDir = new Set<string>();
  const push = (list: SkillCandidate[]) => {
    for (const c of list) {
      const id = c.error ? c.key : c.dir;
      if (seenDir.has(id)) continue;
      seenDir.add(id);
      scan.skills.push(c);
    }
  };
  for (const { tool, dir } of userSkillDirs)
    push(skillsIn(tool, 'user', dir, home, project, () => true));
  if (project) {
    const projReal = realOrNull(project);
    const allow = (real: string) =>
      (!!projReal && isWithin(projReal, real)) || userSkillReal.some((r) => isWithin(r, real));
    push(
      skillsIn('claude', 'project', path.join(project, '.claude', 'skills'), home, project, allow),
    );
    push(
      skillsIn('codex', 'project', path.join(project, '.agents', 'skills'), home, project, allow),
    );
  }
  uniqueKeys([...scan.mcp, ...scan.skills]);
  return scan;
}
