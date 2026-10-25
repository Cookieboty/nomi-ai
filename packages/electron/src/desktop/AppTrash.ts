import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { t } from '../i18n';

/**
 * 应用回收站：桌面工具从不硬删除，一律把文件移到 userData/desktop/trash/<日期>/<id>/ 下并写 manifest，
 * 以便「撤销」能原样恢复（系统回收站无法可靠地以编程方式恢复）。30 天后自动清理。
 */
export interface TrashRecord {
  id: string;
  original: string;
  stored: string;
  trashedAt: number;
}

async function move(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fs.promises.rm(from, { recursive: true, force: true });
  }
}

export async function moveNoOverwrite(from: string, to: string): Promise<void> {
  if (fs.existsSync(to))
    throw Object.assign(new Error(t('electron.common.target-already-exists', to)), {
      code: 'conflict',
    });
  await move(from, to);
}

export class AppTrash {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  async trash(target: string): Promise<TrashRecord> {
    const id = randomUUID();
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const dir = path.join(this.root, day, id);
    const stored = path.join(dir, path.basename(target));
    await move(target, stored);
    const rec: TrashRecord = { id, original: target, stored, trashedAt: this.now() };
    await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(rec, null, 2));
    return rec;
  }

  async restore(rec: Pick<TrashRecord, 'stored' | 'original'>): Promise<void> {
    if (!fs.existsSync(rec.stored))
      throw Object.assign(new Error(t('electron.common.the-file-in-the-trash-no-longer-exists')), {
        code: 'gone',
      });
    await moveNoOverwrite(rec.stored, rec.original);
    await fs.promises.rm(path.dirname(rec.stored), { recursive: true, force: true });
  }

  /** 清理 maxAgeDays 天前的日期目录 */
  purge(maxAgeDays = 30): number {
    if (!fs.existsSync(this.root)) return 0;
    const cutoff = new Date(this.now() - maxAgeDays * 86400_000).toISOString().slice(0, 10);
    let n = 0;
    for (const d of fs.readdirSync(this.root)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) {
        fs.rmSync(path.join(this.root, d), { recursive: true, force: true });
        n += 1;
      }
    }
    return n;
  }
}
