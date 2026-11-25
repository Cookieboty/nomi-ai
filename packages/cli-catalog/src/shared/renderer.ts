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
  /**
   * 清单里写 `branding` 时：品牌元数据。`modelBrand` 是自家模型在视图品牌图标（`modelBrandOf`）里的 id：
   * 视图拿当前模型认出的品牌与它相等，就知道是底座自家模型（胶囊里只留底座图标，不重复画模型图标）。
   * 没写的 CLI 没有自家品牌（如 Antigravity 换底座 / 模型都走第三方）。
   */
  brand?: NonNullable<CliManifest['branding']>;
}

export function rendererInfo(m: CliManifest): CliRendererInfo {
  return {
    id: m.id,
    displayName: m.displayName,
    icon: m.icon,
    capabilities: m.capabilities,
    permissionModes: (m.capabilities.permissionModes ?? []).map((p) => p.mode),
    modelSwitch: m.modelSwitch,
    brand: m.branding,
  };
}
