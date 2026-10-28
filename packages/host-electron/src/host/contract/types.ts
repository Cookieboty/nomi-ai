/**
 * 宿主侧契约处理函数的共用类型：内核的 `@nomi-ai/core/contract/types`，`ContractDeps` 带上宿主的服务表
 * （docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 */

import type { ContractDeps as CoreContractDeps } from '@nomi-ai/core/contract/types';

import type { ContractServices } from './services';

export * from '@nomi-ai/core/contract/types';

/** 宿主的域处理函数（media / shell / mascot）与 `createAppRouter` 收到的依赖 */
export type ContractDeps = CoreContractDeps<ContractServices>;
