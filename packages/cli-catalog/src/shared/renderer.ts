/**
 * 渲染进程用的插件信息：从清单里取界面需要的部分（名称、图标、能力位、档位）。纯数据。
 */
import type { CliCapabilities, CliManifest, HarnessPermissionMode } from '../manifest';

export interface CliRendererInfo {
  id: string;
  displayName: string;
  icon: string;
  capabilities: CliCapabilities;
  /** 这个 CLI 支持的权限档位（界面只列这些） */
  permissionModes: HarnessPermissionMode[];
  modelSwitch: CliManifest['modelSwitch'];
}

export function rendererInfo(m: CliManifest): CliRendererInfo {
  return {
    id: m.id,
    displayName: m.displayName,
    icon: m.icon,
    capabilities: m.capabilities,
    permissionModes: (m.capabilities.permissionModes ?? []).map((p) => p.mode),
    modelSwitch: m.modelSwitch,
  };
}
