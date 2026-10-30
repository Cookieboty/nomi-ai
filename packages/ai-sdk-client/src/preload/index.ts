/**
 * `@nomi-ai/ai-sdk-client/preload` —— preload 层子入口（docs/design/core-host-decoupling.md §5.2、§8）。
 *
 * preload 只暴露两个对象：
 * - [`mkNomiTransportPreload`](file:///./mkNomiTransportPreload.ts)：契约传输 `window.nomiTransport`，
 *   视图对内核的全部调用与事件都走它（经 `services/api.ts` 的类型化客户端）；
 * - [`mkNomiHostPreload`](file:///./mkNomiHostPreload.ts)：`window.nomiHost`，只放不能做成契约调用的宿主能力
 *   （拖入文件的本机路径）。
 *
 * 该子入口预期在 Electron preload 脚本里被 `import`（Node/Electron 环境），
 * 因此 **不** 依赖任何 React / DOM API。
 */

export * from './mkNomiHostPreload';
export * from './mkNomiTransportPreload';
export * from './types';
export * from './windowKind';
