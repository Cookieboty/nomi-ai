/**
 * 产品品牌常量（主进程）：只是 `@nomi-ai/types` 的 `brand` 的别名，唯一来源在那里（§10.1）。
 * 角色名不在这里：从当前角色包的人设读（PersonaService）。
 */
import { brand } from '@nomi-ai/types';

export { brand };
export const APP_NAME = brand.appName;
export const APP_ID = brand.appId;
