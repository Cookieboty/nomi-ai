/**
 * 按需提供工具：对话里没提到相关的事，就不把这组工具的定义发给模型。
 * 工具定义每轮都随请求发送（几十个工具约 8K token），多步调用时每一步都再算一遍；
 * 提醒 / 剪贴板 / 浏览器 / 代码 / 偏好这些只在少数对话里用得上。
 *
 * 判断看整段对话（用户与助手说过的话），一旦提到过就一直提供：工具集只增不减，
 * 前缀缓存不会因为工具忽有忽无被打断。Go 版 igtools/gates.go 同一张表。
 */
import type { ToolDefinition, ToolRegistry, ToolTurn } from '@nomi-ai/bundle-ig-base';

const REMINDER =
  /提醒|闹钟|日程|定时|计时|叫醒|叫我|记得|别忘|分钟后|小时后|点钟|几点|明天|后天|今晚|早上|下午|晚上|周[一二三四五六日天]|星期|remind|alarm|schedule|timer|tomorrow/;
const CLIPBOARD = /剪贴板|剪切板|复制|粘贴|拷贝|clipboard|copy|paste/;
const BROWSER =
  /网页|网站|网址|链接|浏览|上网|搜索|搜一下|查一下|查查|新闻|天气|官网|https?:|www\.|\.com|\.cn|\.org|\.io|url|browser|website|web|search|google/;
const CODE =
  /计算|算一下|算算|算出|统计|代码|脚本|程序|运行|执行|公式|换算|python|javascript|node|script|code|calc|compute/;
const PREFERENCE =
  /偏好|习惯|喜欢|讨厌|不爱|称呼|叫我|以后|记住|忘掉|忘记|设置|prefer|call me|remember|forget/;
const RANDOM = /随机|抽签|抽奖|骰子|掷|抛硬币|硬币|选一个|帮我选|random|dice|coin|pick/;
const UNDO = /撤销|撤回|恢复|还原|改回|回滚|undo|revert|restore/;
const PERMISSION = /权限|授权|允许|访问|permission|access|allow/;
const FILES =
  /文件|目录|文件夹|桌面|下载|文档|路径|保存|存到|存成|写入|读取|打开|整理|归档|移动|移到|挪|重命名|改名|删除|删掉|新建|创建|废纸篓|回收站|图片|照片|截图|表格|笔记|项目|仓库|~\/|[a-z]:\\|\/users\/|\/home\/|\.(?:md|txt|pdf|docx?|xlsx?|csv|json|png|jpe?g|ts|js|py|go)\b|file|folder|dir|path|desktop|download|document/;
const DELEGATE =
  /编程助手|委派|代码|编程|开发|项目|仓库|bug|修复|报错|测试|重构|部署|需求|审查|调研|网站|网页|应用|插件|功能|实现|claude|codex|grok|gemini|dsh|github|commit|review|research|code|repo|deploy|feature|fix/;
const IMAGE =
  /图|画|照片|相片|海报|头像|壁纸|插画|配图|封面|logo|表情包|生成|chat-asset:|image|picture|photo|draw|paint|illustrat|poster|avatar|wallpaper/;

type Gate = (turn: ToolTurn) => boolean;
const said =
  (re: RegExp): Gate =>
  (turn) =>
    re.test(turn.convoText);
/** 选了工作区的 Nomi 对话：文件与委派工具总是提供 */
const files: Gate = (turn) => !!turn.cwd || FILES.test(turn.convoText);
const delegate: Gate = (turn) => !!turn.cwd || DELEGATE.test(turn.convoText);

/** 工具名 → 这一轮用不用得上；不在表里的总是提供（记忆、知识库、时间、表情动作、技能、MCP…） */
export const TOOL_GATES: Record<string, Gate> = {
  reminder_create: said(REMINDER),
  reminder_list: said(REMINDER),
  reminder_cancel: said(REMINDER),
  reminder_snooze: said(REMINDER),
  clipboard_read: said(CLIPBOARD),
  clipboard_write: said(CLIPBOARD),
  browser_open: said(BROWSER),
  browser_read: said(BROWSER),
  browser_click: said(BROWSER),
  browser_type: said(BROWSER),
  browser_close: said(BROWSER),
  http_get_readonly: said(BROWSER),
  code_run: said(CODE),
  set_user_preference: said(PREFERENCE),
  get_user_preference: said(PREFERENCE),
  list_user_preferences: said(PREFERENCE),
  forget_user_preferences: said(PREFERENCE),
  random: said(RANDOM),
  // 调试用：对话里不提供
  echo: () => false,
  undo_last: said(UNDO),
  desktop_permissions: said(PERMISSION),
  image_generate: said(IMAGE),
  delegate_to_cli: delegate,
  delegate_status: delegate,
  delegate_followup: delegate,
  delegate_stop: delegate,
  fs_list: files,
  fs_stat: files,
  fs_read_text: files,
  fs_search: files,
  fs_summarize: files,
  fs_write_text: files,
  fs_edit: files,
  fs_mkdir: files,
  fs_copy: files,
  fs_move: files,
  fs_trash: files,
};

/** 给已注册的工具挂上 relevant（工具自己写了 relevant 的不覆盖） */
export function applyToolGates(registry: ToolRegistry): void {
  for (const def of registry.list() as ToolDefinition[]) {
    const gate = TOOL_GATES[def.name];
    if (!gate || def.relevant) continue;
    registry.register({ ...def, relevant: gate });
  }
}
