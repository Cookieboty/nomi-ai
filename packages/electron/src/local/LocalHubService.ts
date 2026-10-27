/**
 * 本地数据导出：一键把 userData 下的对话、记忆、日程、技能与设置打成 zip。
 * 日历、剪贴板历史已在 v2.0.4 移除；启动时清掉旧版本留下的剪贴板历史（含图片，属敏感数据）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { dialog } from 'electron';
import { zipSync, strToU8 } from 'fflate';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import type { DesktopService } from '../desktop/DesktopService';
import { redactServerForExport } from '../extensions/mcpConfig';
import { t as tr } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';

interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
}

export interface HubDeps {
  root: string;
  userData: string;
  logger: Logger;
  desktop: DesktopService;
}

export class LocalHubService {
  private ipcDone = false;
  /** 启动时清理旧数据的异步任务（测试可 await） */
  readonly legacyPurged: Promise<void>;

  constructor(private readonly d: HubDeps) {
    this.legacyPurged = this.purgeLegacyClipboard();
  }

  /** 旧版本的剪贴板历史（clipboard.json + clips/ 图片）：功能已移除，不再留在磁盘上 */
  // 异步删除：clips/ 可能有大量图片，不在主进程启动路径上做同步 IO
  private purgeLegacyClipboard(): Promise<void> {
    return Promise.all([
      fs.promises.rm(path.join(this.d.root, 'clipboard.json'), { force: true }),
      fs.promises.rm(path.join(this.d.root, 'clips'), { recursive: true, force: true }),
    ]).then(
      () => undefined,
      (err) => this.d.logger.warn('清理旧剪贴板历史失败', String(err)),
    );
  }

  private audit(tool: string, args: Record<string, unknown>, result = 'ok', source = 'settings') {
    this.d.desktop.audit.append({ tool, args, decision: 'user', result, ms: 0, source } as never);
  }

  // ───────────── 导出 ─────────────
  /** 打包 userData 下的本地数据（不含模型、索引、缓存；密钥类文件只导出脱敏版本） */
  async exportAll(opts: { conversations?: unknown; include?: string[] } = {}) {
    const r = await dialog.showSaveDialog({
      title: tr('electron.common.export-all-local-data'),
      defaultPath: `nomi-export-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return this.exportTo(r.filePath, opts);
  }
  exportTo(file: string, opts: { conversations?: unknown; include?: string[] } = {}) {
    const files: Record<string, Uint8Array> = {};
    const ud = this.d.userData;
    const add = (rel: string, data: Uint8Array | string) =>
      (files[rel] = typeof data === 'string' ? strToU8(data) : data);
    const addFile = (rel: string, abs: string) => {
      try {
        if (fs.statSync(abs).isFile() && fs.statSync(abs).size < 50 * 2 ** 20)
          add(rel, fs.readFileSync(abs));
      } catch {
        /* missing */
      }
    };
    const addDir = (
      rel: string,
      abs: string,
      filter: (n: string) => boolean = () => true,
      depth = 0,
    ) => {
      if (depth > 4) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;
        const r2 = `${rel}/${e.name}`;
        if (e.isDirectory()) addDir(r2, path.join(abs, e.name), filter, depth + 1);
        else if (filter(e.name)) addFile(r2, path.join(abs, e.name));
      }
    };
    const want = new Set(
      opts.include ?? ['conversations', 'memory', 'schedule', 'skills', 'settings'],
    );
    if (want.has('conversations') && opts.conversations)
      add('conversations.json', JSON.stringify(opts.conversations, null, 2));
    if (want.has('memory')) addDir('memory', path.join(ud, 'memory'));
    if (want.has('schedule')) addDir('schedule', path.join(ud, 'schedule'));
    if (want.has('skills')) addDir('skills', path.join(ud, 'skills'));
    if (want.has('settings')) {
      for (const f of [
        'desktop/settings.json',
        'desktop/reminders.json',
        'knowledge/settings.json',
        'voice/settings.json',
        'local/settings.json',
      ])
        addFile(`settings/${f}`, path.join(ud, f));
      // MCP 配置：只导出结构。密钥是否导出由字段语义决定（env / headers 取值、URL 凭据、
      // 命令行里的 token 一律移除），与它在磁盘上是否以 `enc:` 加密无关
      try {
        const mcp = JSON.parse(
          fs.readFileSync(path.join(ud, 'extensions', 'mcp.json'), 'utf8'),
        ) as Array<Record<string, unknown>>;
        add(
          'settings/mcp.json',
          JSON.stringify(
            mcp.map((s) => redactServerForExport(s, tr('electron.common.removed'))),
            null,
            2,
          ),
        );
      } catch {
        /* none */
      }
    }
    add(
      'README.txt',
      tr('electron.common.nomi-data-export', new Date().toLocaleString('zh-CN')) +
        tr('electron.common.includes-chats-long-term-memory-schedules-reminders-skills') +
        tr('electron.common.excludes-api-keys-and-other-secrets-removed-downloaded'),
    );
    const zip = zipSync(files, { level: 6 });
    fs.writeFileSync(file, zip);
    this.audit('data_export', { files: Object.keys(files).length, bytes: zip.length });
    broadcastMascotCommand({ type: 'motion', name: 'nod' });
    return { file, files: Object.keys(files).length, bytes: zip.length };
  }

  registerIpc() {
    if (this.ipcDone) return;
    this.ipcDone = true;
    guardedHandle(
      'ai:hub:export',
      async (o: unknown) => {
        try {
          return await this.exportAll(o as never);
        } catch (err) {
          return { __error: { code: 'hub', message: (err as Error).message } };
        }
      },
      { owner: 'LocalHubService', wrapErrors: false },
    );
  }
}

let inst: LocalHubService | null = null;
export function initLocalHubService(d: HubDeps) {
  inst = new LocalHubService(d);
  return inst;
}
export function getLocalHubService() {
  return inst;
}
