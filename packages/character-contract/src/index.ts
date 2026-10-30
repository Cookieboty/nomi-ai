/**
 * @nomi-ai/character-contract — 角色包契约：类型、zod schema、契约数据、校验与迁移。
 *
 * 本入口 Node 与浏览器通用（不依赖 fs / electron）；从目录读包请用 `@nomi-ai/character-contract/node`。
 * 设计：docs/design/core-host-decoupling.md §10.2、§10.3；说明：docs/character-pack/CONTRACT.md。
 */
export * from './contract';
export * from './copy';
export * from './migrations';
export * from './paths';
export * from './schemas';
export * from './validate';
