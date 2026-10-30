/**
 * 产品品牌常量（docs/design/core-host-decoupling.md §10.1）：唯一来源。
 *
 * 只放产品的东西（应用名、appId）；角色名、人设、台词属于角色包（characters/<id>），从当前角色的人设读，
 * 不在这里。`electron-builder.yml` 的 `productName` / `appId` 与这里一致（scripts/__tests__/brand.test.ts 守住）。
 * 运行时应用名（userData 目录名）是另一回事：固定为 `@nomi-ai/electron`，见 host-electron 的 package.json。
 */
export const brand = {
  /** 产品名：窗口标题、托盘提示、侧栏 / 设置页的品牌字样、通知标题、导出文件标题 */
  appName: 'Nomi',
  /** 安装包标识（electron-builder `appId`） */
  appId: 'com.cookieboty.nomi',
} as const;

export type Brand = typeof brand;
