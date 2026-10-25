/**
 * 扩展管理：MCP 服务器（图形界面增删改、连接、工具一览、调用确认）+ SKILL.md 技能包。
 *
 * - MCP 配置存 userData/extensions/mcp.json；env / headers 里的敏感值用 safeStorage 加密。
 *   连接后把该服务器的每个工具包一层：按信任级别弹出 PermissionBroker 确认，并写审计日志。
 *   环境变量 MCP_SERVERS 里的服务器照常工作，界面里只读展示。
 * - 技能放在 userData/skills/<name>/SKILL.md；模型先只看到名称 + 描述，需要时 skill_load。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  McpKey,
  type McpServerConfig,
  type McpService,
  type ToolDefinition,
  type ToolRegistry,
} from '@nomi-ai/bundle-ig-base';
import { BrowserWindow, dialog, shell } from 'electron';
import { z } from 'zod';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import type { DesktopService } from '../desktop/DesktopService';
import { t } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { canEncryptSecrets, decryptSecret, encryptSecret } from '../security/secretStorage';
import { writePrivateFileAtomic } from '../utils/privateFile';

import {
  MCP_PRESETS,
  McpConfigError,
  isSecretKey,
  isSecretValue,
  maskServer,
  mergeSecrets,
  needsConfirm,
  parseImport,
  redactServerForExport,
  sanitizeServer,
  slugId,
  type McpServerEntry,
  type Trust,
} from './mcpConfig';
import {
  MAX_SKILL_BYTES as MIGRATE_MAX_SKILL_BYTES,
  discoverMigrations,
  type McpCandidate,
  type MigrateScan,
  type SkillCandidate,
} from './migrate';
import {
  SkillError,
  buildSkillMd,
  parseSkillMd,
  safeJoin,
  skillsContext,
  validSkillName,
  type SkillMeta,
} from './skillPack';

interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
}

export interface ExtDeps {
  root: string;
  skillsRoot: string;
  logger: Logger;
  desktop: DesktopService;
  /** 从其他工具导入（#58）时扫描的用户目录；默认 os.homedir()，测试可注入 */
  home?: () => string;
  env?: () => Record<string, string | undefined>;
  /** 选择项目文件夹（默认系统对话框），测试可注入 */
  pickDir?: () => Promise<string | null>;
}

export type MigrateAction = 'skip' | 'rename' | 'overwrite';
export interface MigrateChoice {
  key: string;
  action?: MigrateAction;
}
export interface MigrateResult {
  imported: Array<{ key: string; kind: 'mcp' | 'skill'; name: string }>;
  skipped: Array<{ key: string; name: string }>;
  failed: Array<{ key: string; name: string; error: string }>;
}
const TOOL_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

type Status = 'off' | 'connecting' | 'connected' | 'error';
interface Live {
  status: Status;
  error?: string;
  tools: Array<{ name: string; description: string; readOnly: boolean; dangerous: boolean }>;
  at?: number;
}

export interface SkillInfo extends SkillMeta {
  enabled: boolean;
  builtin: boolean;
  files: string[];
  error?: string;
  dir: string;
}

const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_READ = 64 * 1024;

const BUILTIN_SKILLS: Array<{ meta: SkillMeta; body: string }> = [
  {
    meta: {
      name: 'weekly-report',
      description: 'electron.common.use-when-the-user-wants-a-weekly-report',
      version: '1.0',
      license: 'MIT',
      author: 'Nomi',
    },
    body: 'electron.common.weekly-report-helper-1-first-find-out-or',
  },
  {
    meta: {
      name: 'meeting-notes',
      description: 'electron.common.use-when-the-user-pastes-meeting-notes-a',
      version: '1.0',
      license: 'MIT',
      author: 'Nomi',
    },
    body: 'electron.common.meeting-minutes-output-three-parts-decisions-action-items',
  },
];
const BUILTIN_FILES: Record<string, Record<string, string>> = {
  'meeting-notes': {
    'template.md': 'electron.common.decisions-action-items-item-owner-due-date-open',
  },
};

export class ExtensionsService {
  private servers: McpServerEntry[] = [];
  private live = new Map<string, Live>();
  private disabledSkills = new Set<string>();
  /**
   * listSkills 的缓存：每条消息发送前都会取技能上下文（skills-context），原来每次都同步递归读遍
   * 技能目录、逐个解析 SKILL.md，卡主进程。签名 = 每个技能文件夹与 SKILL.md 的 mtime / 大小，
   * 用户在外部改了 SKILL.md 或增删技能文件夹时签名变化、重新扫描；应用内的改动走 changed() 直接作废。
   */
  private skillsCache: { sig: string; list: SkillInfo[] } | null = null;
  private mcp: (() => McpService | undefined) | null = null;
  private registry: ToolRegistry | null = null;
  private ipcDone = false;
  /** 最近一次「从其他工具导入」扫描结果（含明文密钥，只在主进程内存里） */
  private migrateCache = new Map<string, McpCandidate | SkillCandidate>();
  /** 用户在导入对话框里选的项目文件夹（渲染进程永远不传路径） */
  private migrateProject: string | null = null;

  constructor(private readonly d: ExtDeps) {
    fs.mkdirSync(d.root, { recursive: true });
    fs.mkdirSync(d.skillsRoot, { recursive: true });
    this.servers = this.loadServers();
    const st = this.readJson(path.join(d.skillsRoot, '.state.json')) as {
      disabled?: string[];
      seeded?: boolean;
    } | null;
    this.disabledSkills = new Set(st?.disabled ?? []);
    if (!st?.seeded) this.seedSkills();
  }

  // ───────────── 持久化 ─────────────
  private readJson(p: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }
  private writeJson(p: string, v: unknown) {
    // mcp.json 含 env / headers 敏感值（safeStorage 加密串），收紧为 0600
    writePrivateFileAtomic(p, JSON.stringify(v, null, 2));
  }
  /**
   * 写盘前加密。安全存储不可用时不再静默写明文：新增 / 修改的密钥在 upsert / import 入口就被
   * assertCanStoreSecrets 拒绝；这里只会遇到「旧版本已是明文」的存量值（例如只切换启用开关），
   * 为不丢数据原样保留，等安全存储恢复后下一次保存即被加密。
   */
  private enc(v: string): string {
    if (!v || v.startsWith('enc:')) return v;
    try {
      return encryptSecret(v, '');
    } catch {
      return v;
    }
  }
  private dec(v: string): string {
    return decryptSecret(v);
  }
  /** 新写入 / 修改的 env、headers 密钥必须能加密，否则整次保存失败关闭 */
  private assertCanStoreSecrets(next: McpServerEntry[], prev?: McpServerEntry): void {
    const differs = (
      m: Record<string, string> | undefined,
      old: Record<string, string> | undefined,
      all: boolean,
    ) =>
      Object.entries(m ?? {}).some(
        ([k, v]) => (all || isSecretKey(k) || isSecretValue(v)) && !!v && old?.[k] !== v,
      );
    const changed = next.some(
      (e) => differs(e.env, prev?.env, false) || differs(e.headers, prev?.headers, true),
    );
    if (changed && !canEncryptSecrets())
      throw new McpConfigError(
        t('electron.common.system-secure-storage-is-unavailable-so-mcp-secrets'),
      );
  }
  /** env 按字段名判断密钥；headers 的取值一律按密钥处理（鉴权头名称不固定，如 X-Gateway-Auth） */
  private mapSecrets(
    m: Record<string, string> | undefined,
    f: (v: string) => string,
    allValues = false,
  ) {
    return (
      m &&
      Object.fromEntries(
        Object.entries(m).map(([k, v]) => [
          k,
          allValues || isSecretKey(k) || isSecretValue(v) ? f(v) : v,
        ]),
      )
    );
  }
  private loadServers(): McpServerEntry[] {
    const raw = this.readJson(path.join(this.d.root, 'mcp.json'));
    if (!Array.isArray(raw)) return [];
    const out: McpServerEntry[] = [];
    for (const r of raw) {
      try {
        const e = sanitizeServer(r);
        // 解密不看字段名：凡是 enc: 都解（取值型密钥的字段名可能很普通，#58）；明文原样返回
        e.env = this.mapSecrets(e.env, (v) => this.dec(v), true);
        e.headers = this.mapSecrets(e.headers, (v) => this.dec(v), true);
        out.push(e);
      } catch {
        /* skip broken */
      }
    }
    return out;
  }
  private saveServers() {
    this.writeJson(
      path.join(this.d.root, 'mcp.json'),
      this.servers.map((e) => ({
        ...e,
        env: this.mapSecrets(e.env, (v) => this.enc(v)),
        headers: this.mapSecrets(e.headers, (v) => this.enc(v), true),
      })),
    );
  }
  private saveSkillState() {
    this.writeJson(path.join(this.d.skillsRoot, '.state.json'), {
      disabled: [...this.disabledSkills],
      seeded: true,
    });
  }
  private seedSkills() {
    for (const s of BUILTIN_SKILLS) {
      const dir = path.join(this.d.skillsRoot, s.meta.name);
      if (fs.existsSync(dir)) continue;
      fs.mkdirSync(dir, { recursive: true });
      // 写入磁盘的内容会进模型上下文，按当前界面语言落地成正文而不是 key
      const meta = { ...s.meta, description: t(s.meta.description) };
      fs.writeFileSync(path.join(dir, 'SKILL.md'), buildSkillMd(meta, t(s.body)));
      for (const [f, c] of Object.entries(BUILTIN_FILES[s.meta.name] ?? {}))
        fs.writeFileSync(path.join(dir, f), t(c));
    }
    this.saveSkillState();
  }

  private broadcast(ch: string, payload: unknown) {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }
  private changed() {
    this.skillsCache = null;
    this.broadcast('ai:ext:changed', null);
  }
  private audit(
    tool: string,
    args: Record<string, unknown>,
    decision: string,
    result: string,
    source: 'mcp' | 'skill' | 'settings',
    ms = 0,
  ) {
    this.d.desktop.audit.append({ tool, args, decision, result, ms, source } as never);
  }

  // ───────────── MCP ─────────────
  /** 由 ig 插件在 runtime 装载时注入 */
  attach(mcp: () => McpService | undefined, registry: ToolRegistry) {
    this.mcp = mcp;
    this.registry = registry;
  }

  /** runtime 就绪后：自动连接已启用的服务器 */
  async start() {
    for (const s of this.servers.filter((x) => x.enabled))
      void this.connect(s.id).catch(() => undefined);
  }

  listMcp() {
    const svc = this.mcp?.();
    const envServers = (svc?.listServers() ?? []).filter(
      (i) => !this.servers.some((s) => s.id === i.id),
    );
    return {
      servers: this.servers.map((s) => ({
        ...maskServer(s),
        ...(this.live.get(s.id) ?? { status: 'off' as Status, tools: [] }),
      })),
      env: envServers.map((i) => ({
        id: i.id,
        name: (i as { name?: string }).name ?? i.id,
        origin: 'env' as const,
        status: 'connected' as Status,
        tools: ((i as { toolNames?: string[] }).toolNames ?? []).map((n) => {
          const def = this.registry?.get?.(n);
          return {
            name: n,
            description: def?.description ?? '',
            readOnly: def?.readOnly === true,
            dangerous: def?.dangerous === true,
          };
        }),
      })),
      presets: MCP_PRESETS,
      ready: !!svc,
    };
  }

  upsert(raw: Partial<McpServerEntry> & { id?: string }): McpServerEntry {
    const prev = raw.id ? this.servers.find((s) => s.id === raw.id) : undefined;
    const taken = new Set(this.servers.filter((s) => s !== prev).map((s) => s.id));
    const e = sanitizeServer({ ...prev, ...raw, id: prev?.id ?? raw.id, origin: 'user' }, taken);
    e.env = mergeSecrets(e.env, prev?.env);
    e.headers = mergeSecrets(e.headers, prev?.headers);
    this.assertCanStoreSecrets([e], prev);
    if (prev) this.servers = this.servers.map((s) => (s === prev ? e : s));
    else this.servers.push(e);
    this.saveServers();
    this.audit(
      'mcp_server_save',
      { id: e.id, transport: e.transport, trust: e.trust },
      'user',
      'ok',
      'settings',
    );
    this.changed();
    if (prev && this.live.get(e.id)?.status === 'connected')
      void this.connect(e.id).catch(() => undefined);
    return maskServer(e);
  }

  async remove(id: string): Promise<boolean> {
    await this.disconnect(id).catch(() => undefined);
    const n = this.servers.length;
    this.servers = this.servers.filter((s) => s.id !== id);
    this.live.delete(id);
    this.saveServers();
    this.audit('mcp_server_remove', { id }, 'user', 'ok', 'settings');
    this.changed();
    return this.servers.length < n;
  }

  async toggle(id: string, enabled: boolean) {
    const s = this.servers.find((x) => x.id === id);
    if (!s) return false;
    s.enabled = enabled;
    this.saveServers();
    if (enabled) await this.connect(id).catch(() => undefined);
    else await this.disconnect(id);
    return true;
  }

  importJson(text: string): McpServerEntry[] {
    const list = parseImport(
      text,
      this.servers.map((s) => s.id),
    );
    this.assertCanStoreSecrets(list);
    for (const e of list) e.enabled = false; // 导入后默认不连，先让用户检查
    this.servers.push(...list);
    this.saveServers();
    this.audit('mcp_server_import', { n: list.length }, 'user', 'ok', 'settings');
    this.changed();
    return list.map(maskServer);
  }

  async connect(id: string): Promise<Live> {
    const s = this.servers.find((x) => x.id === id);
    if (!s) throw new McpConfigError(t('electron.common.server-not-found'));
    const svc = this.mcp?.();
    if (!svc || !this.registry)
      throw new McpConfigError(t('electron.common.the-ai-service-isn-t-ready-yet-try'));
    this.live.set(id, { status: 'connecting', tools: [] });
    this.changed();
    const t0 = Date.now();
    try {
      await svc.connect({
        id: s.id,
        name: s.name,
        transport: s.transport,
        command: s.command,
        args: s.args,
        url: s.url,
        env: s.env,
        headers: s.headers,
      });
      const info = svc.listServers().find((x) => x.id === id) as
        { toolNames?: string[] } | undefined;
      const tools: Live['tools'] = [];
      for (const name of info?.toolNames ?? []) {
        const def = this.registry.get(name);
        if (!def) continue;
        tools.push({
          name,
          description: def.description,
          readOnly: def.readOnly === true,
          dangerous: def.dangerous === true,
        });
        this.registry.unregister?.(name);
        this.registry.register(this.guard(s.id, def));
      }
      const live: Live = { status: 'connected', tools, at: Date.now() };
      this.live.set(id, live);
      this.audit('mcp_connect', { id, tools: tools.length }, 'user', 'ok', 'mcp', Date.now() - t0);
      broadcastMascotCommand({ type: 'motion', name: 'nod' });
      this.changed();
      return live;
    } catch (err) {
      const msg = friendlyError(err);
      const live: Live = { status: 'error', error: msg, tools: [] };
      this.live.set(id, live);
      this.audit('mcp_connect', { id }, 'user', 'error', 'mcp', Date.now() - t0);
      this.changed();
      throw new McpConfigError(msg);
    }
  }

  async disconnect(id: string) {
    await this.mcp?.()
      ?.disconnect(id)
      .catch(() => undefined);
    this.live.set(id, { status: 'off', tools: [] });
    this.changed();
  }

  /** 包装 MCP 工具：按信任级别确认 + 审计 */
  private guard(serverId: string, def: ToolDefinition): ToolDefinition {
    const s = this.servers.find((x) => x.id === serverId);
    return this.withConfirm(def, {
      serverId,
      serverName: s?.name ?? serverId,
      trust: s?.trust ?? 'ask',
    });
  }

  /**
   * 环境变量 MCP_SERVERS 来的工具没有用户配置的信任级别：
   * 按最保守策略处理——每次调用都确认，危险工具强制弹窗。
   * GUI 管理的服务器不在此包装（connect() 会按用户配置的信任级别自行包装）。
   */
  guardEnvTool(server: McpServerConfig, def: ToolDefinition): ToolDefinition {
    if (this.servers.some((s) => s.id === server.id)) return def;
    return this.withConfirm(def, {
      serverId: server.id,
      serverName: server.name || server.id,
      trust: 'ask',
    });
  }

  private withConfirm(
    def: ToolDefinition,
    opts: { serverId: string; serverName: string; trust: Trust },
  ): ToolDefinition {
    const broker = this.d.desktop.broker;
    const { serverId, serverName, trust } = opts;
    return {
      ...def,
      execute: async (input, ctx) => {
        const t0 = Date.now();
        let decision: string = 'auto';
        // 权限模式：「计划」拦下非只读工具，「逐项确认」让非只读工具每次都问（即使服务器已信任）
        const mode = broker.permissionMode();
        const strict = def.readOnly !== true && (mode === 'plan' || mode === 'manual');
        if (strict || needsConfirm(trust, def.readOnly === true)) {
          decision = await broker.authorize({
            tool: def.name,
            // 只读工具走到这里一定是「每次询问」（下面 force 确认），按「读」处理，「计划」档不拦；
            // 其它至少按「写」处理，避免被默认策略放行
            danger: def.dangerous ? 'destructive' : def.readOnly === true ? 'read' : 'write',
            summary: t(
              'electron.common.extension-tool',
              def.name.replace(`${serverId}__`, ''),
              serverName,
            ),
            args: input,
            preview: t(
              'electron.common.arguments',
              JSON.stringify(input ?? {}, null, 2).slice(0, 1200),
            ),
            signal: ctx.signal,
            ...(def.dangerous
              ? { force: { dialog: true } }
              : trust === 'ask' || strict
                ? { force: { dialog: false } }
                : {}),
          });
          if (decision !== 'auto' && decision !== 'allowed') {
            this.audit(def.name, { server: serverId }, decision, 'denied', 'mcp');
            return {
              ok: false,
              error:
                decision === 'blocked'
                  ? {
                      code: 'mode_blocked',
                      message: t('electron.common.the-permission-mode-is-plan-read-only-so'),
                    }
                  : {
                      code: 'user_denied',
                      message: t('electron.common.the-user-didn-t-allow-this-call'),
                    },
            } as never;
          }
        }
        try {
          const out = await def.execute(input, ctx);
          this.audit(def.name, { server: serverId }, decision, 'ok', 'mcp', Date.now() - t0);
          return out;
        } catch (err) {
          this.audit(def.name, { server: serverId }, decision, 'error', 'mcp', Date.now() - t0);
          throw err;
        }
      },
    };
  }

  // ───────────── 技能 ─────────────
  listSkills(): SkillInfo[] {
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(this.d.skillsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.')) // .import-* 是导入中的临时目录
        .map((e) => e.name)
        .sort();
    } catch {
      /* none */
    }
    const sig = names
      .map((n) => {
        const dir = path.join(this.d.skillsRoot, n);
        return `${n}:${statSig(dir)}:${statSig(path.join(dir, 'SKILL.md'))}`;
      })
      .join('|');
    if (this.skillsCache?.sig === sig) return this.skillsCache.list;
    const out: SkillInfo[] = [];
    for (const dirName of names) {
      const dir = path.join(this.d.skillsRoot, dirName);
      const files = listFiles(dir).filter((f) => f !== 'SKILL.md');
      try {
        const { meta } = parseSkillMd(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
        out.push({
          ...meta,
          enabled: !this.disabledSkills.has(meta.name),
          builtin: BUILTIN_SKILLS.some((b) => b.meta.name === meta.name),
          files,
          dir: dirName,
        });
      } catch (e) {
        out.push({
          name: dirName,
          description: '',
          enabled: false,
          builtin: false,
          files,
          dir: dirName,
          error: (e as Error).message,
        });
      }
    }
    this.skillsCache = { sig, list: out };
    return out;
  }
  private skillDir(name: string) {
    const s = this.listSkills().find((x) => x.name === name && !x.error);
    if (!s) throw new SkillError(t('electron.common.no-skill-named', name));
    return path.join(this.d.skillsRoot, s.dir);
  }
  getSkill(name: string) {
    const dir = this.skillDir(name);
    const { meta, body } = parseSkillMd(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    return { meta, body, files: listFiles(dir).filter((f) => f !== 'SKILL.md') };
  }
  saveSkill(p: { meta: SkillMeta; body: string; originalName?: string }) {
    const meta = {
      ...p.meta,
      name: String(p.meta.name ?? '').trim(),
      description: String(p.meta.description ?? '').trim(),
    };
    if (!validSkillName(meta.name))
      throw new SkillError(t('electron.common.names-may-only-use-lowercase-letters-digits-and'));
    if (!meta.description)
      throw new SkillError(
        t('electron.common.write-one-sentence-describing-when-this-skill-should'),
      );
    if (!p.body.trim())
      throw new SkillError(t('electron.common.skill-instructions-can-t-be-empty'));
    const existing = this.listSkills();
    if (meta.name !== p.originalName && existing.some((s) => s.name === meta.name))
      throw new SkillError(t('electron.common.a-skill-with-that-name-already-exists'));
    let dir = path.join(this.d.skillsRoot, meta.name);
    if (p.originalName && p.originalName !== meta.name) {
      const old = this.skillDir(p.originalName);
      fs.renameSync(old, dir);
    } else if (p.originalName) dir = this.skillDir(p.originalName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), buildSkillMd(meta, p.body));
    this.audit('skill_save', { name: meta.name }, 'user', 'ok', 'settings');
    this.changed();
    return meta;
  }
  removeSkill(name: string) {
    const dir = this.skillDir(name);
    fs.rmSync(dir, { recursive: true, force: true });
    this.disabledSkills.delete(name);
    this.saveSkillState();
    this.audit('skill_remove', { name }, 'user', 'ok', 'settings');
    this.changed();
    return true;
  }
  toggleSkill(name: string, enabled: boolean) {
    if (enabled) this.disabledSkills.delete(name);
    else this.disabledSkills.add(name);
    this.saveSkillState();
    this.changed();
    return true;
  }
  /** 从文件夹导入（复制进 skills 目录；不跟随符号链接，总大小 ≤ 5 MB） */
  importSkillDir(src: string) {
    const md = path.join(src, 'SKILL.md');
    if (!fs.existsSync(md)) throw new SkillError(t('electron.common.this-folder-has-no-skill-md'));
    const { meta } = parseSkillMd(fs.readFileSync(md, 'utf8'));
    if (this.listSkills().some((s) => s.name === meta.name))
      throw new SkillError(t('electron.common.a-skill-named-already-exists', meta.name));
    let total = 0;
    for (const f of listFiles(src)) total += fs.statSync(path.join(src, f)).size;
    if (total > MAX_SKILL_BYTES)
      throw new SkillError(t('electron.common.skill-pack-too-large-max-5-mb'));
    const dest = path.join(this.d.skillsRoot, meta.name);
    for (const f of listFiles(src)) {
      const to = path.join(dest, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(src, f), to);
    }
    this.audit('skill_import', { name: meta.name }, 'user', 'ok', 'settings');
    broadcastMascotCommand({ type: 'motion', name: 'clap' });
    this.changed();
    return meta;
  }
  async importSkillDialog() {
    const r = await dialog.showOpenDialog({
      title: t('electron.common.choose-a-skill-folder-containing-skill-md'),
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return this.importSkillDir(r.filePaths[0]);
  }
  skillsContext(): string {
    return skillsContext(this.listSkills().filter((s) => s.enabled && !s.error));
  }

  tools(): ToolDefinition[] {
    const load = z
      .object({ name: z.string().min(1).max(64).describe(t('electron.common.skill-name')) })
      .strict();
    const read = z
      .object({
        name: z.string().min(1).max(64),
        path: z
          .string()
          .min(1)
          .max(200)
          .describe(t('electron.common.relative-path-inside-the-skill-folder')),
      })
      .strict();
    const enabled = (name: string) => {
      const s = this.listSkills().find((x) => x.name === name);
      if (!s || s.error) throw new SkillError(t('electron.common.no-skill-named', name));
      if (!s.enabled)
        throw new SkillError(t('electron.common.skill-was-disabled-by-the-user', name));
    };
    return [
      {
        name: 'skill_load',
        description: t('electron.common.read-the-full-instructions-of-an-enabled-skill'),
        input: load,
        readOnly: true,
        execute: async (raw: unknown) => {
          try {
            const { name } = load.parse(raw);
            enabled(name);
            const s = this.getSkill(name);
            this.audit('skill_load', { name }, 'auto', 'ok', 'skill');
            broadcastMascotCommand({ type: 'motion', name: 'think' });
            return { ok: true, data: { name, instructions: s.body, files: s.files } };
          } catch (e) {
            return { ok: false, error: { code: 'skill', message: (e as Error).message } };
          }
        },
      } as unknown as ToolDefinition,
      {
        name: 'skill_read_file',
        description: t('electron.common.read-a-reference-file-in-a-skill-folder'),
        input: read,
        readOnly: true,
        execute: async (raw: unknown) => {
          try {
            const { name, path: rel } = read.parse(raw);
            enabled(name);
            const abs = safeJoin(this.skillDir(name), rel);
            const st = fs.lstatSync(abs);
            if (!st.isFile()) throw new SkillError(t('electron.common.not-a-file'));
            const buf = fs.readFileSync(abs).subarray(0, MAX_READ);
            if (buf.includes(0))
              throw new SkillError(t('electron.common.only-text-files-can-be-read'));
            this.audit('skill_read_file', { name, path: rel }, 'auto', 'ok', 'skill');
            return { ok: true, data: { content: buf.toString('utf8') } };
          } catch (e) {
            return { ok: false, error: { code: 'skill', message: (e as Error).message } };
          }
        },
      } as unknown as ToolDefinition,
    ];
  }

  // ───────────── 从其他工具导入（#58） ─────────────
  private mcpConflict(name: string): McpServerEntry | undefined {
    const n = name.trim().toLowerCase();
    const id = slugId(name, new Set());
    return this.servers.find((s) => s.name.trim().toLowerCase() === n || s.id === id);
  }

  /** 扫描 Claude Code / Codex 的配置；返回给界面的只有脱敏预览 */
  async migrateScan(opts: { pickProject?: boolean; clearProject?: boolean } = {}) {
    if (opts.clearProject) this.migrateProject = null;
    if (opts.pickProject) {
      const dir = await (this.d.pickDir ?? pickDirDialog)();
      if (dir) this.migrateProject = dir;
    }
    const scan: MigrateScan = discoverMigrations({
      home: (this.d.home ?? os.homedir)(),
      env: (this.d.env ?? (() => process.env))(),
      projectDir: this.migrateProject,
    });
    this.migrateCache = new Map([...scan.mcp, ...scan.skills].map((c) => [c.key, c]));
    const skillNames = new Set(this.listSkills().map((s) => s.name));
    const placeholder = '••••••';
    return {
      project: this.migrateProject ? path.basename(this.migrateProject) : null,
      sources: scan.sources,
      mcp: scan.mcp.map((c) => ({
        key: c.key,
        kind: c.kind,
        tool: c.tool,
        scope: c.scope,
        name: c.name,
        where: c.where,
        warnings: [
          ...c.warnings,
          ...(c.server && argsHaveSecret(c.server)
            ? [t('electron.common.the-launch-arguments-seem-to-contain-a-token')]
            : []),
        ],
        ...(c.error ? { error: c.error } : {}),
        conflict: !!this.mcpConflict(c.name),
        ...(c.server
          ? {
              preview: (() => {
                const m = maskServer(c.server);
                const r = redactServerForExport(c.server, placeholder);
                return {
                  transport: c.server.transport,
                  command: c.server.command,
                  args: r.args,
                  url: r.url,
                  env: m.env,
                  headers: m.headers,
                };
              })(),
            }
          : {}),
      })),
      skills: scan.skills.map((c) => ({
        key: c.key,
        kind: c.kind,
        tool: c.tool,
        scope: c.scope,
        name: c.name,
        where: c.where,
        warnings: c.warnings,
        ...(c.error ? { error: c.error } : {}),
        conflict: skillNames.has(c.name),
        preview: { description: c.description, files: c.files, bytes: c.bytes },
      })),
    };
  }

  /** 按用户勾选导入；同名冲突按 skip / rename / overwrite 处理 */
  async migrateImport(choices: MigrateChoice[]): Promise<MigrateResult> {
    const res: MigrateResult = { imported: [], skipped: [], failed: [] };
    const list = Array.isArray(choices) ? choices.slice(0, 500) : [];
    for (const ch of list) {
      const c = this.migrateCache.get(String(ch?.key ?? ''));
      if (!c) continue;
      const action: MigrateAction =
        ch.action === 'rename' || ch.action === 'overwrite' ? ch.action : 'skip';
      try {
        if (c.error) throw new McpConfigError(c.error);
        const name =
          c.kind === 'mcp'
            ? await this.importMcpCandidate(c, action)
            : this.importSkillCandidate(c, action);
        if (name === null) res.skipped.push({ key: c.key, name: c.name });
        else res.imported.push({ key: c.key, kind: c.kind, name });
      } catch (e) {
        res.failed.push({ key: c.key, name: c.name, error: (e as Error).message });
      }
    }
    this.audit(
      'ext_migrate_import',
      { imported: res.imported.length, skipped: res.skipped.length, failed: res.failed.length },
      'user',
      res.failed.length ? 'partial' : 'ok',
      'settings',
    );
    if (res.imported.length) {
      this.changed();
      broadcastMascotCommand({ type: 'motion', name: 'clap' });
    }
    return res;
  }

  private async importMcpCandidate(c: McpCandidate, action: MigrateAction): Promise<string | null> {
    if (!c.server) throw new McpConfigError(t('electron.common.invalid-configuration'));
    const prev = this.mcpConflict(c.server.name);
    if (prev && action === 'skip') return null;
    const taken = new Set(
      this.servers
        .filter((s) => s !== (action === 'overwrite' ? prev : undefined))
        .map((s) => s.id),
    );
    let name = c.server.name;
    if (prev && action === 'rename') {
      const base = `${c.server.name} (${TOOL_LABEL[c.tool]})`;
      name = base;
      for (let i = 2; this.mcpConflict(name); i++) name = `${base} ${i}`;
    }
    const keepId = prev && action === 'overwrite' ? prev.id : undefined;
    const e = sanitizeServer(
      { ...c.server, name, id: keepId, origin: 'user', trust: 'ask', enabled: false },
      taken,
    );
    e.enabled = false; // 导入后默认不连，先让用户检查
    // 导入的 env / headers 走 safeStorage；不可用时拒绝（#35）
    this.assertCanStoreSecrets([e]);
    if (prev && action === 'overwrite') {
      await this.disconnect(prev.id).catch(() => undefined);
      this.servers = this.servers.map((s) => (s === prev ? e : s));
    } else this.servers.push(e);
    this.saveServers();
    return e.name;
  }

  private importSkillCandidate(c: SkillCandidate, action: MigrateAction): string | null {
    const existing = this.listSkills();
    const prev = existing.find((s) => s.name === c.name);
    if (prev && action === 'skip') return null;
    let name = c.name;
    if (prev && action === 'rename') {
      const base = `${c.name}-${c.tool}`.slice(0, 60);
      name = base;
      for (
        let i = 2;
        existing.some((s) => s.name === name) || fs.existsSync(path.join(this.d.skillsRoot, name));
        i++
      )
        name = `${base}-${i}`;
    }
    // 复制前再校验一次源目录（扫描之后可能被改动）：真实路径不变、文件仍是普通文件
    const real = fs.realpathSync(c.dir);
    if (real !== c.dir)
      throw new SkillError(t('electron.common.the-skill-folder-changed-after-the-scan-please'));
    let total = 0;
    const files = ['SKILL.md', ...c.files];
    for (const f of files) {
      const abs = safeJoin(real, f);
      const st = fs.lstatSync(abs);
      if (!st.isFile())
        throw new SkillError(t('electron.common.the-skill-folder-changed-after-the-scan-please'));
      total += st.size;
    }
    if (total > MIGRATE_MAX_SKILL_BYTES)
      throw new SkillError(t('electron.common.skill-pack-too-large-max-5-mb'));
    const tmp = path.join(this.d.skillsRoot, `.import-${randomBytes(6).toString('hex')}`);
    try {
      for (const f of c.files) {
        const to = safeJoin(tmp, f);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        // 不跟随符号链接打开（扫描后被换成链接时直接失败），写入用独占创建
        const fd = fs.openSync(
          safeJoin(real, f),
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        try {
          if (!fs.fstatSync(fd).isFile())
            throw new SkillError(
              t('electron.common.the-skill-folder-changed-after-the-scan-please'),
            );
          fs.writeFileSync(to, fs.readFileSync(fd), { flag: 'wx' });
        } finally {
          fs.closeSync(fd);
        }
      }
      fs.mkdirSync(tmp, { recursive: true });
      const md = fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8');
      // 改名或原头部 Nomi 读不了（多行描述等）时重写头部；正文保持不变
      fs.writeFileSync(
        path.join(tmp, 'SKILL.md'),
        name !== c.name || c.normalize
          ? buildSkillMd({ name, description: c.description }, c.body || md)
          : md,
      );
      parseSkillMd(fs.readFileSync(path.join(tmp, 'SKILL.md'), 'utf8')); // 落盘前确认 Nomi 读得了
      const dest = path.join(this.d.skillsRoot, name);
      // 覆盖：先把旧的挪到备份名，新目录就位后再删；中途失败则还原
      const backup = prev && action === 'overwrite' ? `${tmp}.old` : null;
      if (backup) fs.renameSync(path.join(this.d.skillsRoot, prev!.dir), backup);
      try {
        if (fs.existsSync(dest))
          throw new SkillError(t('electron.common.a-skill-named-already-exists', name));
        fs.renameSync(tmp, dest);
      } catch (e) {
        if (backup) fs.renameSync(backup, path.join(this.d.skillsRoot, prev!.dir));
        throw e;
      }
      if (backup) fs.rmSync(backup, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    this.disabledSkills.delete(name);
    this.saveSkillState();
    return name;
  }

  registerIpc(): void {
    if (this.ipcDone) return;
    this.ipcDone = true;
    const h = (ch: string, fn: (...a: never[]) => unknown) =>
      guardedHandle(
        `ai:ext:${ch}`,
        async (...a: unknown[]) => {
          try {
            return await fn(...(a as never[]));
          } catch (err) {
            return { __error: { code: 'ext', message: (err as Error).message } };
          }
        },
        { owner: 'ExtensionsService', wrapErrors: false },
      );
    h('mcp-list', () => this.listMcp());
    h('mcp-upsert', (p: never) => this.upsert(p));
    h('mcp-remove', (id: string) => this.remove(id));
    h('mcp-toggle', (id: string, v: boolean) => this.toggle(id, !!v));
    h('mcp-connect', (id: string) => this.connect(id));
    h('mcp-disconnect', (id: string) => this.disconnect(id));
    h('mcp-import', (text: string) => this.importJson(String(text ?? '')));
    h('skills-list', () => this.listSkills());
    h('skill-get', (n: string) => this.getSkill(n));
    h('skill-save', (p: never) => this.saveSkill(p));
    h('skill-remove', (n: string) => this.removeSkill(n));
    h('skill-toggle', (n: string, v: boolean) => this.toggleSkill(n, !!v));
    h('skill-import', () => this.importSkillDialog());
    h('skill-open', (n?: string) => shell.openPath(n ? this.skillDir(n) : this.d.skillsRoot));
    h('skills-context', () => this.skillsContext());
    h('migrate-scan', (o?: { pickProject?: boolean; clearProject?: boolean }) =>
      this.migrateScan({ pickProject: !!o?.pickProject, clearProject: !!o?.clearProject }),
    );
    h('migrate-import', (items: MigrateChoice[]) => this.migrateImport(items));
  }
}

async function pickDirDialog(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    title: t('electron.common.choose-a-project-folder-reads-its-mcp-json'),
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

function argsHaveSecret(e: McpServerEntry): boolean {
  if (!e.args?.length) return false;
  const r = redactServerForExport(e, '\u0000');
  return (r.args ?? []).some((a, i) => a !== e.args![i]);
}

/** 文件的 mtime + 大小（不存在返回 '-'），用作技能缓存签名 */
function statSig(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function listFiles(root: string, rel = '', out: string[] = [], depth = 0): string[] {
  if (depth > 4 || out.length > 200) return out;
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) listFiles(root, r, out, depth + 1);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export function friendlyError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found|spawn/i.test(m))
    return t('electron.common.failed-to-start-command-not-found-make-sure', m.slice(0, 120));
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(m))
    return t('electron.common.can-t-reach-the-server', m.slice(0, 120));
  if (/401|403|unauthori[sz]ed/i.test(m))
    return t('electron.common.the-server-refused-access-check-the-token-authorization');
  if (/timeout|timed out/i.test(m)) return t('electron.common.connection-timed-out');
  return m.slice(0, 200);
}

let inst: ExtensionsService | null = null;
export function initExtensionsService(d: ExtDeps): ExtensionsService {
  inst = new ExtensionsService(d);
  return inst;
}
export function getExtensionsService(): ExtensionsService | null {
  return inst;
}
export { McpKey };
