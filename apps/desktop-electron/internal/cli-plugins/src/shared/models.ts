/** 各 CLI 模型目录解析共用的小工具（从主进程 cli/modelCatalog.ts 搬来） */
export type Obj = Record<string, unknown>;
export const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
export const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** ACP / CLI 不同版本对可用权限模式使用过多种包裹形式。 */
export function parsePermissionModes(root: unknown): string[] | undefined {
  const obj = asObj(root);
  const modeRoot = obj.modes;
  const candidates: unknown[] = [
    obj.permissionModes,
    obj.permission_modes,
    obj.availableModes,
    Array.isArray(modeRoot) ? modeRoot : asObj(modeRoot).availableModes,
    Array.isArray(modeRoot) ? undefined : asObj(modeRoot).permissionModes,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const modes = candidate
      .map((x) =>
        typeof x === 'string'
          ? x
          : (asStr(asObj(x).id) ?? asStr(asObj(x).modeId) ?? asStr(asObj(x).value)),
      )
      .filter((x): x is string => !!x);
    if (modes.length) return [...new Set(modes)];
  }
  return undefined;
}
