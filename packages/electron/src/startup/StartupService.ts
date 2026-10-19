/**
 * 启动后默认界面（设置 → 通用 → 启动 Nomi 后默认显示；首次引导里也能选）。
 * 持久化到 userData/startup.json：`{ "defaultView": "mascot" | "main" }`。
 * 文件缺失 / 内容损坏 → 默认看板娘，所以老用户升级后行为不变，无需迁移。
 */
import fs from 'node:fs';
import path from 'node:path';

import { guardedHandle } from '../security/guardedIpc';
import { writePrivateFileAtomic } from '../utils/privateFile';

import {
  DEFAULT_STARTUP_VIEW,
  STARTUP_VIEWS,
  normalizeStartupView,
  type StartupView,
} from './startupPlan';

export interface StartupState {
  defaultView: StartupView;
}

export class StartupService {
  private state: StartupState = { defaultView: DEFAULT_STARTUP_VIEW };

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { defaultView?: unknown };
      this.state = { defaultView: normalizeStartupView(raw?.defaultView) };
    } catch {
      /* 首次运行 / 文件损坏：用默认 */
    }
  }

  get(): StartupState {
    return { ...this.state };
  }

  set(patch: unknown): StartupState {
    const v = (patch as { defaultView?: unknown } | null)?.defaultView;
    if (!(STARTUP_VIEWS as readonly unknown[]).includes(v)) {
      throw new Error(`unknown startup view: ${String(v)}`);
    }
    this.state = { defaultView: v as StartupView };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivateFileAtomic(this.file, JSON.stringify(this.state, null, 2));
    return this.get();
  }

  registerIpc(): void {
    const opts = { owner: 'StartupService', wrapErrors: false };
    guardedHandle('ai:startup:get', () => this.get(), opts);
    guardedHandle('ai:startup:set', (patch) => this.set(patch), opts);
  }
}
