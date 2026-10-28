/**
 * 角色人设（docs/design/core-host-decoupling.md §10.4）：主进程 PersonaService 是唯一来源，
 * 按「当前角色包 → 内置角色包（默认 characters/nomi）」解析，再按界面语言取对应文案。
 * 角色包文件格式见 `@nomi-ai/character-contract` 的 personaSchema。
 */
export interface Persona {
  /** 角色 id（manifest.id；官方角色为 `nomi`） */
  characterId: string;
  /** 角色名（当前界面语言） */
  displayName: string;
  /** 系统提示里的身份段（只描述「你是谁」，不含对话行为要求） */
  systemPromptIdentity: string;
  /** 角色对用户的称呼 */
  addressUser?: string;
  /** 问候语（当前界面语言） */
  greetings: string[];
}
