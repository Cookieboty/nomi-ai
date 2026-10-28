/**
 * 单元测试用的宿主端口假实现（设计稿 §7.1「实施约定」第 4 条：测试不 mock 平台能力）。
 *
 * 只覆盖迁移到端口的服务用到的部分：paths / app / dialogs / shell / clipboard，其余字段按需在
 * 调用处用 `{ ...fakeHostPorts(), xxx }` 补。调用记录放在返回值的 `calls` 上。
 */
import type {
  HostPlatform,
  HostPorts,
  PickDirectoryOptions,
  SaveFileOptions,
} from '@nomi-ai/host-ports';

export interface FakeHostPortsOptions {
  userData?: string;
  home?: string;
  resources?: string;
  appPath?: string;
  version?: string;
  name?: string;
  packaged?: boolean;
  platform?: HostPlatform;
  /** pickDirectory 的答案（缺省为 null = 取消） */
  pickDirectory?: string | null;
}

export interface FakeHostPortsCalls {
  pickDirectory: PickDirectoryOptions[];
  saveFile: SaveFileOptions[];
  showError: Array<{ title: string; message: string }>;
  openExternal: string[];
  openPath: string[];
  clipboard: string[];
  quit: number;
}

export type FakeHostPorts = Pick<HostPorts, 'paths' | 'app' | 'dialogs' | 'shell' | 'clipboard'> & {
  lifecycle: Pick<HostPorts['lifecycle'], 'quit'>;
  calls: FakeHostPortsCalls;
};

export function fakeHostPorts(o: FakeHostPortsOptions = {}): FakeHostPorts {
  const userData = o.userData ?? '/tmp/test-userData';
  const calls: FakeHostPortsCalls = {
    pickDirectory: [],
    saveFile: [],
    showError: [],
    openExternal: [],
    openPath: [],
    clipboard: [],
    quit: 0,
  };
  let clip = '';
  return {
    calls,
    paths: {
      userData: () => userData,
      logs: () => `${userData}/logs`,
      temp: () => '/tmp',
      resources: () => o.resources ?? '/tmp/test-resources',
      appPath: () => o.appPath ?? '/tmp/test-app',
      home: () => o.home ?? '/tmp/test-home',
      documents: () => `${o.home ?? '/tmp/test-home'}/Documents`,
    },
    app: {
      name: () => o.name ?? 'Test App',
      version: () => o.version ?? '1.0.0',
      locale: () => 'zh-CN',
      preferredLanguages: () => ['zh-CN'],
      isPackaged: () => o.packaged ?? false,
      platform: () => o.platform ?? 'linux',
    },
    dialogs: {
      pickFiles: async () => [],
      pickDirectory: async (opts = {}) => {
        calls.pickDirectory.push(opts);
        return o.pickDirectory ?? null;
      },
      saveFile: async (opts = {}) => {
        calls.saveFile.push(opts);
        return null;
      },
      showError: (title, message) => {
        calls.showError.push({ title, message });
      },
    },
    shell: {
      openExternal: async (url) => {
        calls.openExternal.push(url);
      },
      openPath: async (target) => {
        calls.openPath.push(target);
        return '';
      },
      showItemInFolder: () => undefined,
    },
    clipboard: {
      readText: async () => clip,
      writeText: async (text) => {
        clip = text;
        calls.clipboard.push(text);
      },
      readImage: async () => null,
    },
    lifecycle: {
      quit: () => {
        calls.quit++;
      },
    },
  };
}
