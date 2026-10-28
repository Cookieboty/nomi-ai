/**
 * 功能服务（memory / knowledge / schedule / extensions / local / chat / diagnostics）测试用的
 * 宿主端口与事件总线假实现（设计稿 §7.1「实施约定」第 4 条：测试不 mock 平台能力）。
 *
 * 对话框按队列返回预设答案（队列空时视为取消），shell 只记录调用；`calls` 里能读到每次调用的参数。
 */
import type {
  HostPorts,
  PickDirectoryOptions,
  PickFilesOptions,
  SaveFileOptions,
} from '@nomi-ai/host-ports';

import { createRecordingAppEvents, type RecordingAppEvents } from '../../../src/core/appEvents';

export interface FeatureHostOptions {
  pickFiles?: string[][];
  pickDirectory?: (string | null)[];
  saveFile?: (string | null)[];
  /** shell.openPath 的返回值（空串 = 成功） */
  openPathResult?: string;
  idleSeconds?: number;
  packaged?: boolean;
  version?: string;
}

export interface FeatureHostCalls {
  pickFiles: PickFilesOptions[];
  pickDirectory: PickDirectoryOptions[];
  saveFile: SaveFileOptions[];
  openPath: string[];
  showItemInFolder: string[];
}

export type FeaturePorts = Pick<HostPorts, 'dialogs' | 'shell' | 'power' | 'app'>;

export interface FeatureHost {
  ports: FeaturePorts;
  events: RecordingAppEvents;
  calls: FeatureHostCalls;
  /** 追加对话框答案 */
  answers: Required<Pick<FeatureHostOptions, 'pickFiles' | 'pickDirectory' | 'saveFile'>>;
}

export function featureHost(o: FeatureHostOptions = {}): FeatureHost {
  const answers = {
    pickFiles: [...(o.pickFiles ?? [])],
    pickDirectory: [...(o.pickDirectory ?? [])],
    saveFile: [...(o.saveFile ?? [])],
  };
  const calls: FeatureHostCalls = {
    pickFiles: [],
    pickDirectory: [],
    saveFile: [],
    openPath: [],
    showItemInFolder: [],
  };
  const ports: FeaturePorts = {
    dialogs: {
      pickFiles: async (opts = {}) => {
        calls.pickFiles.push(opts);
        return answers.pickFiles.shift() ?? [];
      },
      pickDirectory: async (opts = {}) => {
        calls.pickDirectory.push(opts);
        return answers.pickDirectory.shift() ?? null;
      },
      saveFile: async (opts = {}) => {
        calls.saveFile.push(opts);
        return answers.saveFile.shift() ?? null;
      },
      showError: () => undefined,
    },
    shell: {
      openExternal: async () => undefined,
      openPath: async (target) => {
        calls.openPath.push(target);
        return o.openPathResult ?? '';
      },
      showItemInFolder: (target) => {
        calls.showItemInFolder.push(target);
      },
    },
    power: {
      idleSeconds: () => o.idleSeconds ?? 0,
      onSuspend: () => () => undefined,
      onResume: () => () => undefined,
    },
    app: {
      name: () => 'Nomi',
      version: () => o.version ?? '0.0.0-test',
      locale: () => 'zh-CN',
      preferredLanguages: () => ['zh-CN'],
      isPackaged: () => o.packaged ?? true,
      platform: () => process.platform,
    },
  };
  return { ports, events: createRecordingAppEvents(), calls, answers };
}

/** 只要 `{ ports, events }`、不关心调用记录时用（展开进服务的 deps） */
export function featureDeps(o: FeatureHostOptions = {}): Pick<FeatureHost, 'ports' | 'events'> {
  const { ports, events } = featureHost(o);
  return { ports, events };
}
