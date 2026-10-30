/**
 * 编排层测试入口：与 `src/cli/CliHarnessService` 导出相同，只是 `CliHarnessService` 的 `ports`
 * 可省略，缺省为 {@link testHarnessPorts}（选择器按「取消」、应用不在前台）。
 * 生产代码（Application.ts）必须显式传入宿主端口。
 */
import type { DialogsPort, WindowsPort } from '@nomi-ai/host-ports';

import { HarnessOrchestrator, type HarnessPorts } from '../../../src/cli/CliHarnessService';

export * from '../../../src/cli/CliHarnessService';

export interface TestHarnessPortsOptions {
  /** `windows.anyFocused()` 的返回值，默认 false（与没有窗口时一致） */
  focused?: boolean | (() => boolean);
  /** `dialogs.pickDirectory()` 的答案，默认 null（取消） */
  pickDirectory?: string | null;
}

export function testHarnessPorts(o: TestHarnessPortsOptions = {}): HarnessPorts {
  const focused = o.focused ?? false;
  return {
    dialogs: {
      pickDirectory: async () => o.pickDirectory ?? null,
    } as Partial<DialogsPort> as DialogsPort,
    windows: {
      anyFocused: () => (typeof focused === 'function' ? focused() : focused),
    } as Partial<WindowsPort> as WindowsPort,
  };
}

type HarnessDeps = ConstructorParameters<typeof HarnessOrchestrator>[0];
export type TestHarnessDeps = Omit<HarnessDeps, 'ports'> & { ports?: HarnessPorts };

export class CliHarnessService extends HarnessOrchestrator {
  constructor(d: TestHarnessDeps) {
    super({ ...d, ports: d.ports ?? testHarnessPorts() });
  }
}
