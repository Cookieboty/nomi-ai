/**
 * 宿主侧契约处理函数能拿到的服务实例：内核的服务表（`@nomi-ai/core/contract/services`）加上宿主自己的
 * 槽位（docs/design/core-host-decoupling.md §7.2、§12「P1b 实施约定」）。
 *
 * 组合根（core/Application.ts）在创建服务时顺手登记到这里；处理函数在**调用时**读取。
 * 只放类型引用（`import type`），本文件不加载任何服务模块。
 */

import type { CoreContractServices } from '@nomi-ai/core/contract/services';

import type { AIRuntimeBootHandle } from '../../ai/AIRuntimeBoot';
import type { WindowManager } from '../../core/WindowManager';
import type { IslandService } from '../../island/IslandService';
import type { MascotWindowActions } from '../mascotWindowActions';

/** 全部可选：服务创建失败（或还没创建）时为 undefined，处理函数用 `need()` 报 UNAVAILABLE */
export interface ContractServices extends CoreContractServices {
  windowManager?: WindowManager;
  /** 看板娘窗口的宿主操作（契约 `window.*`） */
  windowActions?: MascotWindowActions;
  aiRuntime?: AIRuntimeBootHandle;
  /** 灵动岛窗口（D5 mascot） */
  island?: IslandService;
}

/** 组合根持有的可写实例；处理函数只读 */
export function createContractServices(): ContractServices {
  return {};
}
