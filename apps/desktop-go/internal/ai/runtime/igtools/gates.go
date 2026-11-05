package igtools

// 按需提供工具：对话里没提到相关的事，就不把这组工具的定义发给模型。
// 判断看整段对话（用户与助手说过的话），一旦提到过就一直提供：工具集只增不减，前缀缓存不被打断。

import (
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

var (
	gateReminder   = regexp.MustCompile(`提醒|闹钟|日程|定时|计时|叫醒|叫我|记得|别忘|分钟后|小时后|点钟|几点|明天|后天|今晚|早上|下午|晚上|周[一二三四五六日天]|星期|remind|alarm|schedule|timer|tomorrow`)
	gateClipboard  = regexp.MustCompile(`剪贴板|剪切板|复制|粘贴|拷贝|clipboard|copy|paste`)
	gateBrowser    = regexp.MustCompile(`网页|网站|网址|链接|浏览|上网|搜索|搜一下|查一下|查查|新闻|天气|官网|https?:|www\.|\.com|\.cn|\.org|\.io|url|browser|website|web|search|google`)
	gateCode       = regexp.MustCompile(`计算|算一下|算算|算出|统计|代码|脚本|程序|运行|执行|公式|换算|python|javascript|node|script|code|calc|compute`)
	gatePreference = regexp.MustCompile(`偏好|习惯|喜欢|讨厌|不爱|称呼|叫我|以后|记住|忘掉|忘记|设置|prefer|call me|remember|forget`)
	gateRandom     = regexp.MustCompile(`随机|抽签|抽奖|骰子|掷|抛硬币|硬币|选一个|帮我选|random|dice|coin|pick`)
	gateUndo       = regexp.MustCompile(`撤销|撤回|恢复|还原|改回|回滚|undo|revert|restore`)
	gatePermission = regexp.MustCompile(`权限|授权|允许|访问|permission|access|allow`)
	gateFiles      = regexp.MustCompile(`文件|目录|文件夹|桌面|下载|文档|路径|保存|存到|存成|写入|读取|打开|整理|归档|移动|移到|挪|重命名|改名|删除|删掉|新建|创建|废纸篓|回收站|图片|照片|截图|表格|笔记|项目|仓库|~\/|[a-z]:\\|\/users\/|\/home\/|\.(?:md|txt|pdf|docx?|xlsx?|csv|json|png|jpe?g|ts|js|py|go)\b|file|folder|dir|path|desktop|download|document`)
	gateDelegate   = regexp.MustCompile(`编程助手|委派|代码|编程|开发|项目|仓库|bug|修复|报错|测试|重构|部署|需求|审查|调研|网站|网页|应用|插件|功能|实现|claude|codex|grok|gemini|dsh|github|commit|review|research|code|repo|deploy|feature|fix`)
	// 派出去的事（编程助手或后台的 Nomi）：问进度、要停下时也提供查询 / 停止
	gateFollow = regexp.MustCompile(`后台|派|委派|任务|进度|好了没|好了吗|做完|做好|停下|停止|别做|不用做|取消|background|task|progress|status|stop|cancel`)
	// 持续任务：以后 / 定期 / 某件事发生时再做（宁可多带：漏掉时用户就建不了任务）
	gateTask  = regexp.MustCompile(`每天|每日|每周|每月|每晚|每早|每隔|每小时|每次|每当|定期|定时|周期|持续|长期|以后|之后|往后|将来|到时|到点|稍后|晚点|回头|过会|待会|一旦|只要|发生|出现|变化|变动|更新|有新|新邮件|跑完|结束后|完成后|盯|监控|监视|关注|跟进|留意|看着|通知我|告诉我|提醒|订阅|自动|任务|ci\b|rss|cron|daily|weekly|monthly|every|whenever|later|monitor|watch|notify|recurring|subscribe|task`)
	gateImage = regexp.MustCompile(`图|画|照片|相片|海报|头像|壁纸|插画|配图|封面|logo|表情包|生成|chat-asset:|image|picture|photo|draw|paint|illustrat|poster|avatar|wallpaper`)
)

func said(re *regexp.Regexp) func(tools.Turn) bool {
	return func(t tools.Turn) bool { return re.MatchString(t.ConvoText) }
}

// 选了工作区的 Nomi 对话：文件与委派工具总是提供
func orCwd(re *regexp.Regexp) func(tools.Turn) bool {
	return func(t tools.Turn) bool { return t.Cwd != "" || re.MatchString(t.ConvoText) }
}

// follow：委派的门槛，或对话里问到派出去的事的进度 / 要停下
func follow(t tools.Turn) bool { return orCwd(gateDelegate)(t) || gateFollow.MatchString(t.ConvoText) }

// tasks：起草持续任务；对话里说到以后 / 定期 / 某事发生时、提醒类时间词，或问到派出去的事时提供
func tasks(t tools.Turn) bool {
	return gateTask.MatchString(t.ConvoText) || gateReminder.MatchString(t.ConvoText) || gateFollow.MatchString(t.ConvoText)
}

// toolGates：工具名 → 这一轮用不用得上；不在表里的总是提供（记忆、知识库、时间、表情动作、技能、MCP…）
var toolGates = map[string]func(tools.Turn) bool{
	"reminder_create": said(gateReminder), "reminder_list": said(gateReminder),
	"reminder_cancel": said(gateReminder), "reminder_snooze": said(gateReminder),
	"clipboard_read": said(gateClipboard), "clipboard_write": said(gateClipboard),
	"browser_open": said(gateBrowser), "browser_read": said(gateBrowser), "browser_click": said(gateBrowser),
	"browser_type": said(gateBrowser), "browser_close": said(gateBrowser), "http_get_readonly": said(gateBrowser),
	"code_run":            said(gateCode),
	"set_user_preference": said(gatePreference), "get_user_preference": said(gatePreference),
	"list_user_preferences": said(gatePreference), "forget_user_preferences": said(gatePreference),
	"random": said(gateRandom),
	// 调试用：对话里不提供
	"echo":                func(tools.Turn) bool { return false },
	"undo_last":           said(gateUndo),
	"desktop_permissions": said(gatePermission),
	"image_generate":      said(gateImage),
	"delegate_to_cli":     orCwd(gateDelegate), "delegate_status": follow,
	"delegate_followup": orCwd(gateDelegate), "delegate_stop": follow,
	"fs_list": orCwd(gateFiles), "fs_stat": orCwd(gateFiles), "fs_read_text": orCwd(gateFiles),
	"fs_search": orCwd(gateFiles), "fs_summarize": orCwd(gateFiles), "fs_write_text": orCwd(gateFiles),
	"fs_edit": orCwd(gateFiles), "fs_mkdir": orCwd(gateFiles), "fs_copy": orCwd(gateFiles),
	"fs_move": orCwd(gateFiles), "fs_trash": orCwd(gateFiles),
	"task_propose": tasks, "task_recall": tasks,
}

// WithGate：给工具挂上 Relevant（applyToolGates；工具自己写了 Relevant 的不覆盖）
func WithGate(d tools.Definition) tools.Definition {
	if g, ok := toolGates[d.Name]; ok && d.Relevant == nil {
		d.Relevant = g
	}
	return d
}
