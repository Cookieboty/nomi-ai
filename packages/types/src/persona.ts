/**
 * 角色人设（docs/design/core-host-decoupling.md §10.4）：主进程 PersonaService 是唯一来源，
 * 按「当前角色包 → 官方角色数据」解析，再按界面语言取对应文案。
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

/** preload 白名单 `persona`：`character:get-persona` 与 `character:persona-changed` */
export interface PersonaApi {
  get: () => Promise<Persona>;
  /** 换角色包或界面语言后推送；返回取消订阅 */
  onChanged: (callback: (persona: Persona) => void) => () => void;
}
