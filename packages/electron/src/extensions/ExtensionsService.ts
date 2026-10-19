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
      description:
        '用户要写周报 / 工作总结时使用：按固定结构整理本周完成、进行中、问题和下周计划。',
      version: '1.0',
      license: 'MIT',
      author: 'Nomi',
    },
    body: `# 周报助手

1. 先问清楚（或从对话 / 提醒里找）本周做了哪些事；信息不够时最多追问两个问题。
2. 按下面的结构输出，每条一句话，动词开头，尽量量化：
   - **本周完成**
   - **进行中**（附预计完成时间）
   - **问题与风险**（没有就写“无”）
   - **下周计划**
3. 总长度控制在 300 字以内；语气平实，不要夸张。
4. 最后问一句是否需要改成英文或更正式的版本。`,
  },
  {
    meta: {
      name: 'meeting-notes',
      description:
        '用户粘贴会议记录 / 语音转写并想要纪要时使用：提炼结论、待办（负责人 + 截止时间）和未决问题。',
      version: '1.0',
      license: 'MIT',
      author: 'Nomi',
    },
    body: `# 会议纪要

- 输出三部分：**结论**、**待办**（表格：事项 / 负责人 / 截止时间）、**未决问题**。
- 只根据原文整理，不要编造；原文没有负责人或时间的写“待定”。
- 如果用户同意，可以用 reminder_create 为带截止时间的待办创建提醒（先列出来让用户确认）。
- 详细格式示例见同目录的 template.md（需要时用 skill_read_file 读取）。`,
  },
];
const BUILTIN_FILES: Record<string, Record<string, string>> = {
  'meeting-notes': {
    'template.md': `## 结论\n- …\n\n## 待办\n| 事项 | 负责人 | 截止时间 |\n| --- | --- | --- |\n| … | … | … |\n\n## 未决问题\n- …\n`,
  },
};

export class ExtensionsService {
  private servers: McpServerEntry[] = [];
  private live = new Map<string, Live>();
  private disabledSkills = new Set<string>();
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
        t('系统安全存储不可用，无法安全保存 MCP 的密钥 / 令牌；请在系统钥匙串可用后重试'),
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
      fs.writeFileSync(path.join(dir, 'SKILL.md'), buildSkillMd(s.meta, s.body));
      for (const [f, c] of Object.entries(BUILTIN_FILES[s.meta.name] ?? {}))
        fs.writeFileSync(path.join(dir, f), c);
    }
    this.saveSkillState();
  }

  private broadcast(ch: string, payload: unknown) {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }
  private changed() {
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
    if (!s) throw new McpConfigError(t('服务器不存在'));
    const svc = this.mcp?.();
    if (!svc || !this.registry) throw new McpConfigError(t('AI 服务还没准备好，稍后再试'));
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
        if (needsConfirm(trust, def.readOnly === true)) {
          decision = await broker.authorize({
            tool: def.name,
            // 信任级别已判定需要确认 → 至少按「写」处理，避免只读工具被默认策略放行
            danger: def.dangerous ? 'destructive' : 'write',
            summary: t('扩展工具 {0}（{1}）', def.name.replace(`${serverId}__`, ''), serverName),
            args: input,
            preview: t('参数：\n{0}', JSON.stringify(input ?? {}, null, 2).slice(0, 1200)),
            signal: ctx.signal,
            ...(def.dangerous
              ? { force: { dialog: true } }
              : trust === 'ask'
                ? { force: { dialog: false } }
                : {}),
          });
          if (decision !== 'auto' && decision !== 'allowed') {
            this.audit(def.name, { server: serverId }, decision, 'denied', 'mcp');
            return {
              ok: false,
              error: { code: 'user_denied', message: t('用户没有允许这次调用') },
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
    const out: SkillInfo[] = [];
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(this.d.skillsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.')) // .import-* 是导入中的临时目录
        .map((e) => e.name);
    } catch {
      /* none */
    }
    for (const dirName of names.sort()) {
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
    return out;
  }
  private skillDir(name: string) {
    const s = this.listSkills().find((x) => x.name === name && !x.error);
    if (!s) throw new SkillError(t('没有名为 {0} 的技能', name));
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
    if (!validSkillName(meta.name)) throw new SkillError(t('名称只能用小写字母、数字和连字符'));
    if (!meta.description) throw new SkillError(t('请写一句话描述：什么时候该用这个技能'));
    if (!p.body.trim()) throw new SkillError(t('技能说明不能为空'));
    const existing = this.listSkills();
    if (meta.name !== p.originalName && existing.some((s) => s.name === meta.name))
      throw new SkillError(t('已经有同名技能'));
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
    if (!fs.existsSync(md)) throw new SkillError(t('这个文件夹里没有 SKILL.md'));
    const { meta } = parseSkillMd(fs.readFileSync(md, 'utf8'));
    if (this.listSkills().some((s) => s.name === meta.name))
      throw new SkillError(t('已经有名为 {0} 的技能', meta.name));
    let total = 0;
    for (const f of listFiles(src)) total += fs.statSync(path.join(src, f)).size;
    if (total > MAX_SKILL_BYTES) throw new SkillError(t('技能包太大（上限 5 MB）'));
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
      title: t('选择技能文件夹（包含 SKILL.md）'),
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return this.importSkillDir(r.filePaths[0]);
  }
  skillsContext(): string {
    return skillsContext(this.listSkills().filter((s) => s.enabled && !s.error));
  }

  tools(): ToolDefinition[] {
    const load = z.object({ name: z.string().min(1).max(64).describe(t('技能名称')) }).strict();
    const read = z
      .object({
        name: z.string().min(1).max(64),
        path: z.string().min(1).max(200).describe(t('技能文件夹内的相对路径')),
      })
      .strict();
    const enabled = (name: string) => {
      const s = this.listSkills().find((x) => x.name === name);
      if (!s || s.error) throw new SkillError(t('没有名为 {0} 的技能', name));
      if (!s.enabled) throw new SkillError(t('技能 {0} 已被用户停用', name));
    };
    return [
      {
        name: 'skill_load',
        description: t(
          '读取一个已启用技能的完整说明（SKILL.md 正文和附带文件列表）。只在用户请求符合该技能描述时调用。',
        ),
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
        description: t('读取技能文件夹里的参考文件（纯文本，最多 64 KB）。'),
        input: read,
        readOnly: true,
        execute: async (raw: unknown) => {
          try {
            const { name, path: rel } = read.parse(raw);
            enabled(name);
            const abs = safeJoin(this.skillDir(name), rel);
            const st = fs.lstatSync(abs);
            if (!st.isFile()) throw new SkillError(t('不是文件'));
            const buf = fs.readFileSync(abs).subarray(0, MAX_READ);
            if (buf.includes(0)) throw new SkillError(t('只能读取文本文件'));
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
            ? [t('启动参数里似乎有令牌：参数会原样保存（不加密），建议改成环境变量')]
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
    if (!c.server) throw new McpConfigError(t('配置格式不正确'));
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
    if (real !== c.dir) throw new SkillError(t('技能文件夹在扫描后发生了变化，请重新扫描'));
    let total = 0;
    const files = ['SKILL.md', ...c.files];
    for (const f of files) {
      const abs = safeJoin(real, f);
      const st = fs.lstatSync(abs);
      if (!st.isFile()) throw new SkillError(t('技能文件夹在扫描后发生了变化，请重新扫描'));
      total += st.size;
    }
    if (total > MIGRATE_MAX_SKILL_BYTES) throw new SkillError(t('技能包太大（上限 5 MB）'));
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
            throw new SkillError(t('技能文件夹在扫描后发生了变化，请重新扫描'));
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
        if (fs.existsSync(dest)) throw new SkillError(t('已经有名为 {0} 的技能', name));
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
    title: t('选择项目文件夹（读取其中的 .mcp.json、.claude/skills、.agents/skills）'),
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

function argsHaveSecret(e: McpServerEntry): boolean {
  if (!e.args?.length) return false;
  const r = redactServerForExport(e, '\u0000');
  return (r.args ?? []).some((a, i) => a !== e.args![i]);
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
    return t(
      '启动失败：找不到命令（{0}）。请确认已安装 Node.js / uv，或填写完整路径',
      m.slice(0, 120),
    );
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(m))
    return t('连不上服务器：{0}', m.slice(0, 120));
  if (/401|403|unauthori[sz]ed/i.test(m)) return t('服务器拒绝访问：请检查令牌 / Authorization 头');
  if (/timeout|timed out/i.test(m)) return t('连接超时');
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
