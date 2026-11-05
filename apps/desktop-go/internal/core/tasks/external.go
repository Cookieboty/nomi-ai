package tasks

// 对外动作的副作用日志（docs/features/scheduling-calendar.md）：
//
//   - 动作执行前先过撤销检查点（任务还在跑、还是这次执行、授权没撤销），再往事件日志写 intent
//     （幂等键 taskId:attemptId:seq、内容哈希、给人看的摘要、核对用的目标）；
//   - 成功写 done（带外部 id）；确定没生效（参数被拒、4xx）写 failed；不确定（超时、断网）什么都不写，
//     留着 intent，重启后进 needs_reconcile；
//   - 重启核对：能自动查的动作（发评论、开 PR 靠正文里的幂等标记）先查，查清了自动续跑；查不了交给用户。
//
// 共享类型（ExternalAction / ExternalJournal / 错误 / MarkerOf / ContentHash）在 connections/external.go。

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
)

// OpenIntents：某次执行里写了 intent、还没有 done / failed 的对外动作（按 seq 先后）
func OpenIntents(journal []JournalEntry, attemptID string) []JournalEntry {
	open := map[int]JournalEntry{}
	order := []int{}
	for _, e := range journal {
		if e.AttemptID != attemptID || e.Seq == nil {
			continue
		}
		switch e.T {
		case "intent":
			if _, ok := open[*e.Seq]; !ok {
				order = append(order, *e.Seq)
			}
			open[*e.Seq] = e
		case "done", "failed":
			delete(open, *e.Seq)
		}
	}
	out := []JournalEntry{}
	for _, s := range order {
		if e, ok := open[s]; ok {
			out = append(out, e)
			delete(open, s)
		}
	}
	return out
}

// ReconcileResult：自动核对的结论：Applied（可带外部 id）或确定没有
type ReconcileResult struct {
	Applied    bool
	ExternalID string
}

// Reconciler：自动核对：查到了 → Applied；确定没有 → !Applied；查不了 → nil（交给用户）
type Reconciler func(intent JournalEntry, t Task) *ReconcileResult

// slice16：按 UTF-16 码元截断（同 JS 的 String.prototype.slice）
func slice16(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

type externalJournal struct {
	store     *Store
	get       func(id string) *Record
	taskID    string
	attemptID string
	now       func() int64

	mu  sync.Mutex
	seq int
	// seqLoaded：seq 是否已按日志里已有的 intent 初始化
	seqLoaded bool
}

// GrantAllows：当前授权是否还允许这个对外动作：对外动作要 L4；GitHub 写还要这条连接的这项能力覆盖这个仓库。
// MCP 的逐个工具授权由 broker 在调用时按当前授权判（派给 Nomi 的高级权限在运行时补授权）
func GrantAllows(t Task, a connections.ExternalAction) bool {
	if t.Grant.Level < 4 {
		return false
	}
	if !strings.HasPrefix(a.Action, "github.") {
		return true
	}
	conn, repo := "", ""
	if a.Target != nil {
		if s, ok := a.Target.Get("connectionId").(string); ok {
			conn = s
		}
		if s, ok := a.Target.Get("repo").(string); ok {
			repo = strings.ToLower(s)
		}
	}
	for _, g := range t.Grant.Connections {
		if conn != "" && g.ConnectionID != conn {
			continue
		}
		if !slices.Contains(g.Capabilities, a.Action) {
			continue
		}
		for _, r := range g.Resources {
			if strings.ToLower(r) == repo {
				return true
			}
		}
	}
	return false
}

func (j *externalJournal) checkpoint(a connections.ExternalAction) error {
	rec := j.get(j.taskID)
	if rec == nil {
		return &connections.ExternalCheckpointError{}
	}
	t := rec.Task
	if t.Status != StatusRunning || !t.Enabled || t.Grant.RevokedAt != nil ||
		len(rec.Attempts) == 0 || rec.Attempts[len(rec.Attempts)-1].ID != j.attemptID {
		return &connections.ExternalCheckpointError{}
	}
	// 投递前按任务「当前」授权再核一次：运行中收窄了就不发（#232）
	if !GrantAllows(t, a) {
		return &connections.ExternalCheckpointError{}
	}
	return nil
}

func (j *externalJournal) Run(a connections.ExternalAction, fn func(key string) (any, string, error)) (any, error) {
	if err := j.checkpoint(a); err != nil {
		return nil, err
	}
	j.mu.Lock()
	if !j.seqLoaded {
		for _, e := range j.store.Journal(j.taskID) {
			if e.T == "intent" && e.AttemptID == j.attemptID && e.Seq != nil && *e.Seq > j.seq {
				j.seq = *e.Seq
			}
		}
		j.seqLoaded = true
	}
	j.seq++
	n := j.seq
	j.mu.Unlock()
	key := fmt.Sprintf("%s:%s:%d", j.taskID, j.attemptID, n)
	if err := j.store.Append(j.taskID, JournalEntry{T: "intent", At: j.now(), AttemptID: j.attemptID, Seq: ptr(n),
		Action: a.Action, Hash: connections.ContentHash(a.Action, a.Target, a.Payload), Key: key,
		Summary: slice16(a.Summary, 300), Target: a.Target}); err != nil {
		// 记不下 intent 就不做（之后无从核对）
		return nil, err
	}
	v, ext, err := fn(key)
	if err != nil {
		var na *connections.ExternalNotAppliedError
		if errors.As(err, &na) {
			_ = j.store.Append(j.taskID, JournalEntry{T: "failed", At: j.now(), AttemptID: j.attemptID, Seq: ptr(n),
				Msg: slice16(na.Error(), 300)})
		}
		return nil, err
	}
	done := JournalEntry{T: "done", At: j.now(), AttemptID: j.attemptID, Seq: ptr(n)}
	if ext != "" {
		done.ExternalID = &ext
	}
	_ = j.store.Append(j.taskID, done)
	return v, nil
}

// ExternalJournal：这次执行的副作用日志（执行者经 PermissionBroker 的后台登记交给对外工具）
func (s *Service) ExternalJournal(taskID, attemptID string) connections.ExternalJournal {
	return &externalJournal{store: s.Store, get: s.Runtime.Get, taskID: taskID, attemptID: attemptID, now: s.d.Now}
}

// RegisterReconciler：对外动作的自动核对（github.comment 等），须在 Start 之前
func (s *Service) RegisterReconciler(action string, fn Reconciler) {
	s.reconcilers[action] = fn
}

// UseMcpTools：MCP 工具信息（ExtensionsService），授权校验用（mcp.read 只能给只读工具）
func (s *Service) UseMcpTools(fn connections.McpToolLookup) { s.mcpTool = fn }

// reconcileAll：启动后：needs_reconcile 的任务先自动核对，查清了就续跑。在单独的 goroutine 上跑：
// 核对要查网络，不能挡启动，也不能在运行时的持有者里调用
func (s *Service) reconcileAll() {
	for _, t := range s.Runtime.List() {
		if t.Status != StatusNeedsReconcile {
			continue
		}
		func() {
			defer func() {
				if p := recover(); p != nil {
					s.d.Log.Warn("自动核对对外动作失败", "id", t.ID, "error", fmt.Sprint(p))
				}
			}()
			s.AutoReconcile(t.ID)
		}()
	}
}

// AutoReconcile：自动核对一个任务；全部查清时提交核对结果并返回 true，查不了的留给用户
func (s *Service) AutoReconcile(id string) bool {
	rec := s.Runtime.Get(id)
	if rec == nil || len(rec.Attempts) == 0 || rec.Task.Status != StatusNeedsReconcile {
		return false
	}
	attempt := rec.Attempts[len(rec.Attempts)-1]
	type res struct {
		seq int
		r   ReconcileResult
	}
	results := []res{}
	for _, intent := range OpenIntents(s.Store.Journal(id), attempt.ID) {
		fn := s.reconcilers[intent.Action]
		var r *ReconcileResult
		if fn != nil {
			r = safeReconcile(fn, intent, rec.Task)
		}
		if r == nil {
			return false
		}
		results = append(results, res{*intent.Seq, *r})
	}
	// 核对期间用户可能已经处理过
	if cur := s.Runtime.Get(id); cur == nil || cur.Task.Status != StatusNeedsReconcile {
		return false
	}
	now := s.d.Now()
	outcome := "applied"
	for _, x := range results {
		e := JournalEntry{T: "done", At: now, AttemptID: attempt.ID, Seq: ptr(x.seq), By: "reconcile"}
		if x.r.Applied {
			if x.r.ExternalID != "" {
				ext := x.r.ExternalID
				e.ExternalID = &ext
			}
		} else {
			e.T = "failed"
			outcome = "not_applied"
		}
		_ = s.Store.Append(id, e)
	}
	return s.Runtime.Command(id, Command{Type: "reconcile", Outcome: outcome}).OK
}

func safeReconcile(fn Reconciler, intent JournalEntry, t Task) (r *ReconcileResult) {
	defer func() {
		if recover() != nil {
			r = nil
		}
	}()
	return fn(intent, t)
}

// userReconcile：用户核对：把还开着的 intent 按用户的判断关掉（审计完整），再交给状态机
func (s *Service) userReconcile(id, outcome string) CmdResult {
	rec := s.Runtime.Get(id)
	var attempt *Attempt
	if rec != nil && len(rec.Attempts) > 0 {
		attempt = &rec.Attempts[len(rec.Attempts)-1]
	}
	r := s.Runtime.Command(id, Command{Type: "reconcile", Outcome: outcome})
	if r.OK && attempt != nil && outcome != "abandon" {
		now := s.d.Now()
		t := "failed"
		if outcome == "applied" {
			t = "done"
		}
		for _, intent := range OpenIntents(s.Store.Journal(id), attempt.ID) {
			_ = s.Store.Append(id, JournalEntry{T: t, At: now, AttemptID: attempt.ID, Seq: ptr(*intent.Seq), By: "user"})
		}
	}
	return r
}
