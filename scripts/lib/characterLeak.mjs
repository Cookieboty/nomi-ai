/**
 * 角色名泄漏的判定规则（docs/design/core-host-decoupling.md §10.1、§11.2）。
 *
 * 「Nomi」同时是产品名和官方角色名。产品名可以出现在任何地方（应用名、「Nomi 对话」「Nomi 网关」……，
 * 统一来源是 `@nomi-ai/types` 的 `brand.appName`）；角色名只能来自角色包。所以这里判的是：
 *   - `诺米`：只是角色名，出现即算；
 *   - 角色语境下的 `Nomi`：指桌面上那个角色、或以角色身份说话的写法（「我是 Nomi」「显示 Nomi」
 *     「Nomi 工具栏」「Nomi's voice」「点她的」……），见 CHARACTER_NOMI。写成 `isNomi`、`Nomi 对话`、
 *     `Nomi · <供应商>` 这类的是产品名，不算。
 *
 * scripts/check-character-leak.mjs（静态扫描）与替身角色的 e2e（界面文本、系统提示）共用这份规则。
 * 其它角色包（`characters/<id>`，`nomi` 除外）没有产品语境，任何 `Nomi` 都算（`anyNomi`）。
 * 新加角色语境的写法时在这里补一条正则，并在 scripts/__tests__/check-character-leak.test.ts 加例子。
 */

/** 只属于角色的名字（中文名）：出现即算泄漏 */
export const CHARACTER_ONLY = /诺米/g;

/**
 * 官方角色包里的「诺米」：「Nomi·诺米」是一个完整的名字，界面上不单独写「诺米」（docs/BRAND.md：
 * 中文界面第一次提到写「Nomi·诺米」，之后写「Nomi」）。前面不是「Nomi·」的「诺米」就算。
 */
export const BARE_CHINESE_NAME = /(?<!Nomi·)诺米/g;

/**
 * 找单独出现的「诺米」（前面不是「Nomi·」），返回每一处所在的片段（前后各取几个字，便于定位）。
 * @param {string} text
 * @returns {string[]}
 */
export function findBareChineseName(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(BARE_CHINESE_NAME.source, 'g'))) {
    out.push(text.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6));
  }
  return out;
}

/** 角色语境下的 Nomi（产品语境的 Nomi 不在这里） */
export const CHARACTER_NOMI = [
  // 以角色身份自称 / 被称呼
  /(?:我是|你是|叫我|I[’']m|I am|You are|you are|call me)\s*Nomi\b/g,
  // 指桌面上的那个角色（看板娘窗口）
  /(?:显示|隐藏|关闭|拖到|桌面)\s*Nomi\b(?!\s*的)/g,
  /\bNomi\s*(?:大小|工具栏|功能面板|动作|气泡|已隐藏|已关闭|不在桌面|和托盘|仍在桌面|在桌面|从桌面|朗读|说话|提示语音|预录|形象|台词|挥手|互动|看板娘)/g,
  /\b(?:Show|Hide|Close|Desktop|Drop onto|Open with|Interrupt|interrupts)\s+Nomi\b/g,
  /\bNomi\s+(?:size|toolbar|panel|motions|bubble|is hidden|is closed|stays on|waits on|appears|is reading|prompt voice|waves|mascot)\b/g,
  /\bNomi[’']s\s+(?:bubble|voice|prerecorded|lines|replies|motions|size|toolbar)\b/g,
  // 以角色口吻描述它在做什么、或对它做动作（「Nomi 正在思考」「Nomi says」「Pet Nomi」）
  /\bNomi\s+(?:is\s+(?:thinking|listening|speaking|talking|sleeping|napping|waving|here)|says|said|thinks|smiles|waves|nods|blushes|giggles|misses you|loves you)\b/g,
  // 「对 Nomi 说」是对助手（产品）说话，不算
  /(?<![对跟和向]\s*)\bNomi\s*(?:正在|在想|在听|说|觉得|想你|陪你|累了|困了|睡了|笑了)/g,
  /\b(?:Pet|Pat|Poke|Hug|Tickle)\s+Nomi\b/g,
  /(?:摸摸|戳戳|抱抱|拍拍)\s*Nomi\b/g,
  // 「点她的」「她不在桌面时」：角色的人称代词（产品不用她 / her）
  /\bNomi\b[^。.!?！？\n]{0,40}(?:\bher\b|\bshe\b|她)/g,
  // 官方角色的资源名（Rive artboard / state machine）只能在角色包里
  /\bNomi(?:-full|Full)\b/g,
];

/**
 * 其它角色包里没有产品语境：包里的文案全是那个角色自己的，出现 `Nomi` 就是抄了官方角色。
 */
export const ANY_NOMI = /\bNomi\b/g;

/**
 * 在一段文本里找角色名泄漏，返回命中的片段（去重）。
 * @param {string} text
 * @param {{ anyNomi?: boolean }} [opts] `anyNomi`：任何 `Nomi` 都算（扫其它角色包时用）
 * @returns {string[]}
 */
export function findCharacterLeaks(text, opts = {}) {
  const hits = new Set();
  // anyNomi 时 ANY_NOMI 已经包含角色语境的写法，不重复报
  const rules = [CHARACTER_ONLY, ...(opts.anyNomi ? [ANY_NOMI] : CHARACTER_NOMI)];
  for (const re of rules) {
    re.lastIndex = 0;
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) hits.add(m[0]);
  }
  return [...hits];
}
