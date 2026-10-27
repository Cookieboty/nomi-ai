/**
 * Nomi 对话请求发出前的外发检查（#149 / #117）。
 *
 * 普通对话消息不经过文件工具，这里对消息里两类本地内容补上同一套「仅本地 / 云端首次发送」规则：
 * - 用户拖入的文本附件正文（`<attached-file …>正文</attached-file>`）视同文件内容；
 * - 历史里编程助手委派的汇报（`<cli-output>…</cli-output>`）视同编程助手的输出。
 *
 * 不允许发送时：本轮新附件直接失败并提示；历史里的正文换成占位说明（旧附件不能卡住整段对话）。
 */
import { t } from '../i18n';

export type SendVerdict = null | 'local_only' | 'user_denied';

/** 对本次请求的全部实际接收者做「仅本地 / 云端同意」校验，返回第一个失败码 */
export type OutboundCheck = (what: string) => Promise<SendVerdict>;

interface Msg {
  role?: unknown;
  content?: unknown;
}

/** 与渲染进程 fileAttachments.serialize 的格式一致；只匹配带正文的块（只有路径的自闭合块不算文件内容） */
const FILE_BODY = /<attached-file (name="[^"]*"(?: path="[^"]*")?)>\n[\s\S]*?\n<\/attached-file>/g;
const CLI_OUTPUT = /<cli-output>[\s\S]*?<\/cli-output>/g;

const has = (re: RegExp, s: string) => new RegExp(re.source).test(s);

/** 给模型看的占位说明（不随界面语言变化） */
const WITHHELD =
  '(Content withheld: shown only on this device. Per the "only local models can read files" setting or the user\'s choice, it was not sent to the current model.)';

/** 就地处理 messages；本轮附件不允许发送时抛错 */
export async function guardOutboundMessages(
  messages: unknown,
  check: OutboundCheck,
): Promise<void> {
  if (!Array.isArray(messages)) return;
  const list = messages as Msg[];
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }

  const cache = new Map<string, SendVerdict>();
  const verdict = async (what: string) => {
    if (!cache.has(what)) cache.set(what, await check(what));
    return cache.get(what)!;
  };
  const fileWhat = t('electron.common.file-contents');
  const cliWhat = t('electron.common.coding-assistant-output');

  // 本轮新附件：先问（同意后同一接收者记住，历史里的不再重复弹窗）
  const current = list[lastUser]?.content;
  if (typeof current === 'string' && has(FILE_BODY, current)) {
    const r = await verdict(fileWhat);
    if (r === 'local_only') throw new Error(t('electron.common.local-only-attachment-blocked'));
    if (r === 'user_denied') throw new Error(t('electron.common.cancelled-attachment-not-sent'));
  }

  for (let i = 0; i < list.length; i++) {
    const m = list[i]!;
    if (i === lastUser || typeof m.content !== 'string') continue;
    let content = m.content;
    if (has(FILE_BODY, content) && (await verdict(fileWhat)))
      content = content.replace(FILE_BODY, `<attached-file $1>\n${WITHHELD}\n</attached-file>`);
    if (has(CLI_OUTPUT, content) && (await verdict(cliWhat)))
      content = content.replace(CLI_OUTPUT, `<cli-output>\n${WITHHELD}\n</cli-output>`);
    m.content = content;
  }
}
