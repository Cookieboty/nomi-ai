/**
 * @nomi-ai/cli-plugins：内置编程助手插件（docs/design/cli-plugin-architecture.md §5.1、§7）。
 * 根入口给内核 / 宿主用，内容与纯数据目录 `./catalog` 相同；视图包只能 import `./catalog`。
 */
export * from './catalog';
