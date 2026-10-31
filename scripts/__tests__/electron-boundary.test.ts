/**
 * Electron 边界白名单的 shrink-only 终态基线（docs/design/core-host-decoupling.md §12 P4）。
 *
 * `ELECTRON_IMPORT_ALLOWLIST`（业务模块里的静态 electron import）与 `ELECTRON_DYNAMIC_ALLOWLIST`
 *（非宿主代码动态加载 electron）在 P4 已清空：业务模块的 electron 依赖全部换成宿主端口，宿主工作
 * 收进 `src/host/`。这两个列表只减不增、现已触底，测试钉住「保持为空」——以后要放松边界只能改
 * 宿主端口或把代码放进宿主区域，不能再往白名单里加条目。
 */
import { describe, expect, it } from 'vitest';

import {
  ELECTRON_DYNAMIC_ALLOWLIST,
  ELECTRON_IMPORT_ALLOWLIST,
} from '../eslint/electron-boundary.mjs';

describe('electron 边界白名单（shrink-only，P4 终态）', () => {
  it('ELECTRON_IMPORT_ALLOWLIST 保持为空：业务模块不再静态 import electron', () => {
    expect(ELECTRON_IMPORT_ALLOWLIST).toEqual([]);
  });

  it('ELECTRON_DYNAMIC_ALLOWLIST 保持为空：非宿主代码不再动态加载 electron', () => {
    expect(ELECTRON_DYNAMIC_ALLOWLIST).toEqual([]);
  });
});
