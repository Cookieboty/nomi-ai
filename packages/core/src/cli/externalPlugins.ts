/**
 * 外部插件（L1 声明式，docs/design/cli-plugin-architecture.md §5.9）的存储：
 * userData/cli-plugins/external/<id>.json，每个文件一份清单（0600）。只有命令、参数模板和环境变量名，
 * 不含任何变量值或凭据。读不出 / 校验不过的文件不删，交给宿主报告（界面上显示错误、可删除）。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeExternalSpec,
  validateExternalSpec,
  type ExternalCliSpec,
} from '@nomi-ai/cli-sdk';

import { writePrivateFile } from '../utils/privateFile';

export interface StoredExternal {
  /** 文件名里的 id（清单读不出时用它报告） */
  id: string;
  spec: ExternalCliSpec | null;
  errors: string[];
}

export class ExternalPluginStore {
  constructor(
    private readonly dir: string,
    /** 内置插件 id：外部插件不能占用 */
    private readonly reserved: readonly string[],
  ) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  load(): StoredExternal[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    return names.sort().map((n) => {
      const id = n.slice(0, -'.json'.length);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
      } catch (e) {
        return { id, spec: null, errors: [`unreadable: ${(e as Error).message}`] };
      }
      const errors = validateExternalSpec(raw, this.reserved);
      if (!errors.length && (raw as ExternalCliSpec).id !== id)
        errors.push(`file name ${n} does not match id ${(raw as ExternalCliSpec).id}`);
      return errors.length
        ? { id, spec: null, errors }
        : { id, spec: normalizeExternalSpec(raw as ExternalCliSpec), errors: [] };
    });
  }

  /** 校验并保存（同 id 覆盖）；不通过返回错误，不写盘 */
  save(raw: unknown): { spec: ExternalCliSpec } | { errors: string[] } {
    const errors = validateExternalSpec(raw, this.reserved);
    if (errors.length) return { errors };
    const spec = normalizeExternalSpec(raw as ExternalCliSpec);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivateFile(this.file(spec.id), JSON.stringify(spec, null, 2));
    return { spec };
  }

  remove(id: string): boolean {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return false;
    try {
      fs.rmSync(this.file(id));
      return true;
    } catch {
      return false;
    }
  }
}
