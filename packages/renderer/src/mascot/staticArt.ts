/**
 * 当前角色包的静态立绘（默认渲染器 `svg`）；只经 rendererChoice.ts 的动态 import 加载。
 * 构建插件按所选包给出（scripts/character/vite-plugin.mjs `staticArtModule`）：静态包是它自己的立绘，
 * 官方包是它的 SVG 立绘，其它包为 null（按包自己的模式渲染）。
 */
export { default } from 'virtual:character-static-art';
