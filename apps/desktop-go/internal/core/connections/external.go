package connections

// 对外动作的副作用日志：共享类型（docs/features/scheduling-calendar.md）。Node 里这些在 src/tasks/external.ts；
// Go 里 tasks 依赖 desktop / connections，接口与错误类型放在这里（desktop、extensions、connections、tasks 都能引用），
// 日志本身（写 intent / done / failed、核对）在 tasks/external.go。

import (
	"crypto/sha256"
	"encoding/hex"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ExternalAction：一次对外动作
type ExternalAction struct {
	// Action：能力名：github.comment / github.pr.create / mcp.call
	Action string
	// Summary：给人看（收件箱、核对卡片）
	Summary string
	// Target：核对用（仓库、编号、分支、MCP 服务器与工具……），保持键的顺序（与 Node 的对象一致）
	Target *u.Obj
	// Payload：动作内容（只记哈希）；nil = JSON null
	Payload any
}

// ExternalJournal：先写 intent 再执行 fn；fn 拿到幂等键，能写进外部内容的就写进去（自动核对靠它）。
// fn 返回 (结果, 外部 id, 错误)；外部 id 为空时 done 里不写 externalId。
type ExternalJournal interface {
	Run(a ExternalAction, fn func(key string) (value any, externalID string, err error)) (any, error)
}

// ExternalNotAppliedError：请求确定没有生效（参数被拒、4xx）：关掉 intent，重启后不必核对
type ExternalNotAppliedError struct{ Msg string }

func (e *ExternalNotAppliedError) Error() string { return e.Msg }

// ExternalCheckpointError：撤销检查点没过：任务已停 / 撤销 / 换了执行（code task_not_running）
type ExternalCheckpointError struct{}

func (e *ExternalCheckpointError) Error() string { return "task_not_running" }
func (e *ExternalCheckpointError) Code() string  { return "task_not_running" }

// MarkerOf：幂等标记：写进评论 / PR 正文末尾，重启后按它查有没有发出去
func MarkerOf(key string) string { return "<!-- nomi-task:" + key + " -->" }

// ContentHash：sha256(JSON.stringify([action, target, payload ?? null])) 的前 32 个十六进制字符。
// 用 util.Stringify（与 JSON.stringify 同样的转义与数字格式）、Target 用保序对象，所以同样的输入与 Node 字节一致。
// 例外：Payload 若是 Go 的 map（不是 *util.Obj / json.RawMessage），键按字母序输出，与 Node 按插入顺序可能不同
// （MCP 工具参数由调用方原样传入时才会遇到；哈希只用于审计，不参与核对）。
func ContentHash(action string, target *u.Obj, payload any) string {
	var t any = target
	if target == nil {
		t = u.NewObj()
	}
	h := sha256.Sum256([]byte(u.Stringify([]any{action, t, payload})))
	return hex.EncodeToString(h[:])[:32]
}
