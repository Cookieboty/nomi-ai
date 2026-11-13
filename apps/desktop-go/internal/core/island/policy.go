package island

// 灵动岛（以及它退回的系统通知）显示与否的唯一判断。
//
// 规则：
//   - 进度类（进行中 / 定时汇总 / 好像卡住）一律不显示：不扫描、不播报，只在结束时说一次；
//   - 工作台（对话窗口）在屏幕上（可见、没最小化）时，只显示「等你处理」和「报警」两类；
//     完成、AI 主动消息等普通通知不弹：你已经能在窗口里看到；
//   - 你正看着这条通知所属的会话（窗口在前台、当前标签就是它）时，什么都不弹，
//     等你处理的卡片、出错信息都已经在对话里了；
//   - 工作台不在屏幕上：照常显示（仍受各类开关与免打扰约束，见 Accepts）。

// Class：通知的分类
type Class string

const (
	// ClassProgress：进行中、定时汇总、卡住提醒这类中途播报（不再显示）
	ClassProgress Class = "progress"
	// ClassCompletion：任务 / 一轮做完、定时任务结果
	ClassCompletion Class = "completion"
	// ClassActionable：要你处理（权限、批准、回答问题）
	ClassActionable Class = "actionable"
	// ClassAlert：报警（失败、出错、到点的提醒、用量预算告警）
	ClassAlert Class = "alert"
	// ClassOther：其他（AI 主动消息、每日简报等）
	ClassOther Class = "other"
)

// Classify：按通知的 kind / status 分类（kind：message | agent | reminder | info；
// status：done | failed | attention | running | ""）
func Classify(kind, status string) Class {
	switch status {
	case "running":
		return ClassProgress
	case "failed":
		return ClassAlert
	case "done":
		return ClassCompletion
	case "attention":
		switch kind {
		case "agent":
			// 编程助手要权限 / 等你确认
			return ClassActionable
		case "message":
			return ClassOther
		}
		// 到点的提醒、用量预算告警
		return ClassAlert
	}
	switch kind {
	case "reminder":
		// 定时任务结果、持续任务的产出：一件事做完了
		return ClassCompletion
	case "agent":
		return ClassCompletion
	}
	return ClassOther
}

// MainSession：主对话的会话 id（与编排器的主标签 id 一致）
const MainSession = "main"

// Screen：通知那一刻工作台的状态
type Screen struct {
	// WorkbenchVisible：对话窗口在屏幕上（可见、没最小化；平台拿不到遮挡信息，被别的窗口盖住也算在屏幕上）
	WorkbenchVisible bool
	// ForegroundSession：窗口在前台时你正看着的会话（标签 id，主对话是 MainSession）；不在前台为 ""
	ForegroundSession string
}

// ShouldShow：这一类、属于 session（"" = 不属于任何会话，如外部终端里的 CLI、提醒、用量告警）的通知此刻要不要弹
func ShouldShow(c Class, session string, sc Screen) bool {
	if c == ClassProgress {
		return false
	}
	if sc.WorkbenchVisible && session != "" && session == sc.ForegroundSession {
		// 你就在这个会话里：卡片、结果、出错都已经在眼前
		return false
	}
	if !sc.WorkbenchVisible {
		return true
	}
	return c == ClassActionable || c == ClassAlert
}
