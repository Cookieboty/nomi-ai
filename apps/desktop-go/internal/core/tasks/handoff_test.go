package tasks

// 前台转后台的回归（#413 接管 / 失败不误停流 / 重试复用同一任务身份；#414 附图带到后台首轮）。

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
)

var errHandoffTestSave = errors.New("handoff test: save failed")

// handoffStore：fail（全部写入失败）/ failAt（第 n 次起写入失败）两种故障注入。
// 所有写入都落到同一份内存快照里（模拟同一份磁盘）：恢复后可直接拿来模拟重启
type handoffStore struct {
	*memStoreSafe
	mu     sync.Mutex
	fail   bool
	failAt int // > 0：从第几次 Save 起失败（含）
	saves  int
}

func (s *handoffStore) Save(r Record) (Record, error) {
	s.mu.Lock()
	s.saves++
	bad := s.fail || (s.failAt > 0 && s.saves >= s.failAt)
	s.mu.Unlock()
	if bad {
		return Record{}, errHandoffTestSave
	}
	return s.memStoreSafe.Save(r)
}

// Remove：与落盘的删除一致（失败注入只管 Save）；少了它删除过的坏任务会在「重启」后被读回来
func (s *handoffStore) Remove(id string) error {
	s.memStoreSafe.mu.Lock()
	defer s.memStoreSafe.mu.Unlock()
	delete(s.memStoreSafe.recs, id)
	return nil
}

func (s *handoffStore) setFail(b bool) {
	s.mu.Lock()
	s.fail = b
	s.mu.Unlock()
}

func (s *handoffStore) setFailAt(n int) {
	s.mu.Lock()
	s.failAt = n
	s.mu.Unlock()
}

func (s *handoffStore) saveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saves
}

func newHandoffStore() *handoffStore { return &handoffStore{memStoreSafe: newMemStoreSafe()} }

// handoffHarness：真正的 nomi 执行者 + 可注入的存储；记下模型每次拿到的输入
type handoffHarness struct {
	svc *Service
	st  *handoffStore
	mu  sync.Mutex
	in  [][]blm.ChatMessage // 每次 AgentStream 的完整输入
	ids int
}

func newHandoffService(t *testing.T, d ServiceDeps, st StoreLike) *Service {
	t.Helper()
	if d.Root == "" {
		d.Root = t.TempDir()
	}
	if d.Log == nil {
		// 默认不打印：故障注入用例本来就会走到 WARN（保存失败是预期）；要看的用例自己传日志
		d.Log = &nopLog{}
	}
	if d.Now == nil {
		d.Now = func() int64 { return 1_800_000_000_000 }
	}
	if d.SetTimer == nil {
		d.SetTimer = func(func(), int64) func() { return func() {} }
	}
	if d.T == nil {
		d.T = func(k string, _ ...any) string { return k }
	}
	s := NewService(d)
	s.Runtime.d.Store = st
	return s
}

func (h *handoffHarness) runnableQuery(t *testing.T) *Service {
	t.Helper()
	h.st = newHandoffStore()
	var mu sync.Mutex
	h.svc = newHandoffService(t, ServiceDeps{}, h.st)
	// 与生产侧（main.go）一致：执行者协程退出时告诉运行时，WaitIdle / TrackCleanup 才等得到它停下
	var deps NomiDeps
	deps.AgentStream = func(_ context.Context, msgs []blm.ChatMessage, _ []string, _ map[string]any, emit func(blm.ChatChunk)) error {
		mu.Lock()
		h.in = append(h.in, append([]blm.ChatMessage{}, msgs...))
		mu.Unlock()
		emit(blm.ChatChunk{Type: "delta", Content: "完成"})
		return nil
	}
	deps.Ready = func() bool { return true }
	deps.OnExit = func(taskID string, gen int) { h.svc.Runtime.ExecutorExited(taskID, gen) }
	exec := NewNomiExecutor(deps)
	h.svc.RegisterExecutor("nomi", exec)
	h.svc.Start()
	// Service.Stop 不排空执行者的 goroutine：它还在跑时 t.TempDir 的 RemoveAll 会撞上「目录非空」。
	// 先取消还占着名额的运行中任务，再等它们都离开 Running（执行者已经写完了），然后才停
	t.Cleanup(func() {
		for _, tk := range h.svc.List().Tasks {
			if tk.Status == StatusRunning {
				_, _ = h.svc.Command(tk.ID, Command{Type: "cancel"})
			}
		}
		waitFor(t, func() bool { return noRunning(h.svc) })
		h.svc.Stop()
	})
	return h.svc
}

func noRunning(s *Service) bool {
	for _, tk := range s.List().Tasks {
		if tk.Status == StatusRunning {
			return false
		}
	}
	return true
}

// cancelOtherRunning：取消除 keep 以外还占着名额的运行中任务，放行排队里的 keep
func cancelOtherRunning(s *Service, keep string) {
	for _, tk := range s.Runtime.List() {
		if tk.ID != keep && tk.Status == StatusRunning {
			_, _ = s.Command(tk.ID, Command{Type: "cancel"})
		}
	}
}

func (h *handoffHarness) inputs() (out [][]blm.ChatMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	out = make([][]blm.ChatMessage, len(h.in))
	copy(out, h.in)
	return out
}

func (h *handoffHarness) blockOneSlot(t *testing.T) string {
	t.Helper()
	h.svc.Runtime.SetMaxConcurrent(1)
	busy := h.svc.Runtime.Create(CreateInput{Title: "占用名额", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &[]string{}}, Grant: Grant{Level: 1}, Acceptance: "auto"})
	if r := h.svc.Runtime.Command(busy.ID, Command{Type: "runNow"}); !r.OK {
		t.Fatalf("runNow: %+v", r)
	}
	waitFor(t, func() bool { return h.svc.Runtime.Get(busy.ID).Task.Status == StatusRunning })
	return busy.ID
}

// #413：创建（任务快照）保存失败 → storage_error，不通知前台停流，不留坏任务；重试后接管成功
func TestHandoffCreateSaveFailureKeepsFrontStream(t *testing.T) {
	h := &handoffHarness{}
	s := h.runnableQuery(t)
	var resumed []Task
	off := s.OnHandoffResume(func(ts Task) { resumed = append(resumed, ts) })
	defer off()
	h.blockOneSlot(t)

	h.st.setFail(true)
	task, err := s.CreateHandoff(HandoffInput{SourceID: "req_a", ConversationID: "conv", UserGoal: "梳理全仓"})
	if task.ID != "" || err == nil {
		t.Fatalf("want storage error, got task=%+v err=%v", task, err)
	}
	var he *HandoffError
	if !errors.As(err, &he) || he.Code != "storage_error" {
		t.Fatalf("want storage_error, got %v", err)
	}
	if len(resumed) != 0 {
		t.Fatalf("front stream aborted although handoff failed: %+v", resumed)
	}
	if n := len(s.Runtime.List()); n != 1 { // 只有占名额的那个
		t.Fatalf("failed handoff left tasks behind: %d", n)
	}

	h.st.setFail(false)
	task, err = s.CreateHandoff(HandoffInput{SourceID: "req_a", ConversationID: "conv", UserGoal: "梳理全仓"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resumed) != 1 || resumed[0].ID != task.ID {
		t.Fatalf("resume after successful handoff = %+v", resumed)
	}
	if !accepted(task.ID, s) {
		t.Fatalf("want queued / running, got %+v", s.Runtime.Get(task.ID))
	}
	handoffTasks(t, s, 1)
	// 放掉占名额的那个，让接管的任务跑完（执行者写完了再结束用例）
	cancelOtherRunning(s, task.ID)
	waitFor(t, func() bool { return IsTerminal(s.Get(task.ID).Task.Status) })
}

// #413：接管（idle → queued 的状态快照）保存失败 → 不接管、不通知停流；重试复用同一个任务身份（同一 ID）
func TestHandoffTakeoverSaveFailureKeepsFrontStream(t *testing.T) {
	h := &handoffHarness{}
	s := h.runnableQuery(t)
	var resumed []Task
	off := s.OnHandoffResume(func(ts Task) { resumed = append(resumed, ts) })
	defer off()

	// 创建成功；从下一次（接管）保存起失败
	h.st.setFailAt(h.st.saveCount() + 1)
	task, err := s.CreateHandoff(HandoffInput{SourceID: "req_b", ConversationID: "conv", UserGoal: "梳理全仓"})
	var he *HandoffError
	if !errors.As(err, &he) || he.Code != "storage_error" {
		t.Fatalf("want storage_error, got task=%+v err=%v", task, err)
	}
	if len(resumed) != 0 {
		t.Fatalf("front stream aborted although takeover failed: %+v", resumed)
	}
	handoffTasks(t, s, 0)
	// 已落盘的这份任务还是 idle、没有中途通知前台停流
	firstID := ""
	h.st.mu.Lock()
	for id, rec := range h.st.recs {
		if rec.Task.Origin.Via != nil && *rec.Task.Origin.Via == "handoff" {
			firstID = id
			if rec.Task.Status != StatusIdle {
				h.st.mu.Unlock()
				t.Fatalf("failed takeover changed status: %s", rec.Task.Status)
			}
		}
	}
	h.st.mu.Unlock()

	h.st.setFailAt(0)
	again, err := s.CreateHandoff(HandoffInput{SourceID: "req_b", ConversationID: "conv", UserGoal: "梳理全仓"})
	if err != nil {
		t.Fatal(err)
	}
	if firstID != "" && again.ID != firstID {
		t.Fatalf("retry created a new task %s, want reuse %s", again.ID, firstID)
	}
	if len(resumed) != 1 || resumed[0].ID != again.ID {
		t.Fatalf("resume = %+v", resumed)
	}
	if !accepted(again.ID, s) {
		t.Fatalf("want queued / running, got %+v", s.Runtime.Get(again.ID))
	}
	handoffTasks(t, s, 1)
	// 等它跑完：后台执行者写完了再结束用例
	waitFor(t, func() bool { return IsTerminal(s.Get(again.ID).Task.Status) })
}

// #413：合法排队（占满名额）算接管成功，只通知一次停流；重复点击只接管一次
func TestHandoffQueuedAndRepeatedClicks(t *testing.T) {
	h := &handoffHarness{}
	s := h.runnableQuery(t)
	var mu sync.Mutex
	resumed := 0
	off := s.OnHandoffResume(func(Task) { mu.Lock(); resumed++; mu.Unlock() })
	defer off()
	busy := h.blockOneSlot(t)

	var wg sync.WaitGroup
	ids := make([]string, 8)
	errs := make([]error, 8)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			task, err := s.CreateHandoff(HandoffInput{SourceID: "req_c", ConversationID: "conv", UserGoal: "梳理全仓"})
			ids[i], errs[i] = task.ID, err
		}(i)
	}
	wg.Wait()
	for i := range ids {
		if errs[i] != nil {
			t.Fatalf("click %d: %v", i, errs[i])
		}
		if ids[i] != ids[0] {
			t.Fatalf("repeated clicks took over different tasks: %v", ids)
		}
	}
	mu.Lock()
	n := resumed
	mu.Unlock()
	if n != 1 {
		t.Fatalf("resume must happen once, got %d", n)
	}
	if !accepted(ids[0], s) {
		t.Fatalf("want queued / running, got %+v", s.Runtime.Get(ids[0]))
	}
	handoffTasks(t, s, 1)

	// 名额空出来：排队里的接管任务开始跑、跑完；再点一次不再接管
	waitFor(t, func() bool { return s.Runtime.Get(busy).Task.Status != StatusRunning })
	waitFor(t, func() bool { return s.Runtime.Get(ids[0]).Task.Status == StatusDone })
	if _, ce := s.Command(ids[0], Command{Type: "accept"}); ce != nil {
		t.Fatalf("accept: %v", ce)
	}
	// 同一轮再点：交回的就是那个已经跑完的任务，不会新建、不会重跑
	if again, err := s.CreateHandoff(HandoffInput{SourceID: "req_c", ConversationID: "conv", UserGoal: "梳理全仓"}); err != nil || again.ID != ids[0] ||
		!IsTerminal(s.Runtime.Get(again.ID).Task.Status) {
		t.Fatalf("repeated click after finish: %+v err=%v", again, err)
	}
	handoffTasks(t, s, 1)
	mu.Lock()
	defer mu.Unlock()
	if resumed != 1 {
		t.Fatalf("resume fired again on repeated click: %d", resumed)
	}
}

// accepted：后台确实接下了（没被删掉、至少执行过一次）；排队 / 直接开跑都算，跑得飞快已经结束的也算
func accepted(id string, s *Service) bool {
	rec := s.Runtime.Get(id)
	return rec != nil && (rec.Task.Status == StatusQueued || rec.Task.Status == StatusRunning ||
		rec.Task.LastRunAt != nil || len(rec.Attempts) > 0)
}

// 帮手上面的断言：转后台任务（via=handoff）的个数
func handoffTasks(t *testing.T, s *Service, want int) []Task {
	t.Helper()
	var out []Task
	for _, tk := range s.Runtime.List() {
		if tk.Origin.Via != nil && *tk.Origin.Via == "handoff" {
			out = append(out, tk)
		}
	}
	if len(out) != want {
		t.Fatalf("handoff tasks = %d, want %d: %+v", len(out), want, out)
	}
	return out
}

func handoffImage(t *testing.T, body string) FollowUpImage {
	t.Helper()
	return FollowUpImage{Mime: "image/png", Data: "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte(body))}
}

func lastUserImages(msgs []blm.ChatMessage) []blm.ChatImage {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return msgs[i].Images
		}
	}
	return nil
}

// #414：带说明图 / 纯图（目标只有标题）/ 纯文字 → 后台首轮输入真的带上了图（或本来就没有图）
func TestHandoffImagesReachBackgroundFirstRun(t *testing.T) {
	cases := []struct {
		name   string
		in     HandoffInput
		images int
		goal   string
	}{
		{name: "说明图", in: HandoffInput{UserGoal: "按这张截图修样式", Images: []FollowUpImage{handoffImage(t, "\x89PNG-a")}}, images: 1, goal: "按这张截图修样式"},
		{name: "纯图", in: HandoffInput{Title: "看这张报错截图", UserGoal: "", Images: []FollowUpImage{handoffImage(t, "\x89PNG-b")}}, images: 1, goal: "看这张报错截图"},
		{name: "多图", in: HandoffInput{UserGoal: "对比前后", Images: []FollowUpImage{handoffImage(t, "\x89PNG-c"), handoffImage(t, "\x89PNG-d")}}, images: 2, goal: "对比前后"},
		{name: "纯文字", in: HandoffInput{UserGoal: "梳理全仓模块"}, images: 0, goal: "梳理全仓模块"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &handoffHarness{}
			s := h.runnableQuery(t)
			in := c.in
			in.SourceID = "req_img"
			in.ConversationID = "conv"
			task, err := s.CreateHandoff(in)
			if err != nil {
				t.Fatal(err)
			}
			if task.Goal != c.goal {
				t.Fatalf("goal = %q, want %q", task.Goal, c.goal)
			}
			waitFor(t, func() bool { return s.Runtime.Get(task.ID).Task.Status == StatusDone })
			seen := h.inputs()
			if len(seen) == 0 {
				t.Fatal("background never called the model")
			}
			imgs := lastUserImages(seen[0])
			if len(imgs) != c.images {
				t.Fatalf("background first run images = %d, want %d", len(imgs), c.images)
			}
			if c.images > 0 && imgs[0].Mime != "image/png" {
				t.Fatalf("image mime = %q", imgs[0].Mime)
			}
		})
	}
}

// #414：引用不可用（数据读不回来 / 类型不支持 / 超出上限）→ 明确失败、不接管、不通知停流、不留坏任务，
// 之后不用图重试则正常接管
func TestHandoffUnavailableImageKeepsFrontStream(t *testing.T) {
	cases := []struct {
		name  string
		in    HandoffInput
		code  string
		fixed HandoffInput
	}{
		{
			name:  "坏数据",
			in:    HandoffInput{UserGoal: "看图", Images: []FollowUpImage{{Mime: "image/png", Data: "not-base64!!"}}},
			code:  "image_unavailable",
			fixed: HandoffInput{UserGoal: "看图"},
		},
		{
			name:  "空数据",
			in:    HandoffInput{UserGoal: "看图", Images: []FollowUpImage{{Mime: "image/png", Data: "data:image/png;base64,"}}},
			code:  "image_unavailable",
			fixed: HandoffInput{UserGoal: "看图"},
		},
		{
			name:  "类型不支持",
			in:    HandoffInput{UserGoal: "看图", Images: []FollowUpImage{{Mime: "image/tiff", Data: base64.StdEncoding.EncodeToString([]byte("TIFF"))}}},
			code:  "image_unavailable",
			fixed: HandoffInput{UserGoal: "看图"},
		},
		{
			name: "超出上限",
			in: HandoffInput{UserGoal: "看图", Images: func() []FollowUpImage {
				var out []FollowUpImage
				for i := 0; i <= MaxFollowUpImages; i++ {
					out = append(out, handoffImage(t, fmt.Sprintf("p%d", i)))
				}
				return out
			}()},
			code:  "bad_input",
			fixed: HandoffInput{UserGoal: "看图"},
		},
		{
			name:  "没有目标",
			in:    HandoffInput{UserGoal: "  ", Images: []FollowUpImage{handoffImage(t, "x")}},
			code:  "bad_input",
			fixed: HandoffInput{UserGoal: "看图"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &handoffHarness{}
			s := h.runnableQuery(t)
			var resumed []Task
			off := s.OnHandoffResume(func(ts Task) { resumed = append(resumed, ts) })
			defer off()
			in := c.in
			in.SourceID = "req_img"
			in.ConversationID = "conv"
			_, err := s.CreateHandoff(in)
			var he *HandoffError
			if !errors.As(err, &he) || he.Code != c.code {
				t.Fatalf("want %s, got %v", c.code, err)
			}
			if len(resumed) != 0 {
				t.Fatalf("front stream aborted although image handoff failed: %+v", resumed)
			}
			handoffTasks(t, s, 0)
			// 附件目录不留半截文件
			if files := attachmentsUnder(t, s); len(files) != 0 {
				t.Fatalf("half-written attachments: %v", files)
			}
			fixed := c.fixed
			fixed.SourceID, fixed.ConversationID = "req_img", "conv"
			task, err := s.CreateHandoff(fixed)
			if err != nil {
				t.Fatal(err)
			}
			if len(resumed) != 1 || resumed[0].ID != task.ID {
				t.Fatalf("resume = %+v", resumed)
			}
			handoffTasks(t, s, 1)
			// 成功接管的后台确实跑完（执行者写完了再结束用例）
			waitFor(t, func() bool { return IsTerminal(s.Get(task.ID).Task.Status) })
		})
	}
}

// #414：附图写入后启动态保存失败 → storage_error，不通知停流；再点一次（同一轮）接管成功且首轮仍带图
func TestHandoffImageSaveFailureThenRetryKeepsImages(t *testing.T) {
	h := &handoffHarness{}
	s := h.runnableQuery(t)
	var resumed []Task
	off := s.OnHandoffResume(func(ts Task) { resumed = append(resumed, ts) })
	defer off()

	// 创建(1) + 附图(2) 成功；启动态（占名额取得后）那一次失败
	h.blockOneSlot(t)
	h.st.setFailAt(h.st.saveCount() + 3)
	in := HandoffInput{SourceID: "req_s", ConversationID: "conv", UserGoal: "按截图修样式",
		Images: []FollowUpImage{handoffImage(t, "\x89PNG-e")}}
	_, err := s.CreateHandoff(in)
	var he *HandoffError
	if err == nil {
		he = &HandoffError{}
	}
	if !errors.As(err, &he) || he.Code != "storage_error" {
		t.Fatalf("want storage_error, got %v", err)
	}
	if len(resumed) != 0 {
		t.Fatalf("front stream aborted although start-state save failed: %+v", resumed)
	}
	// 没跑起来的这次接管不留附件（半截附件 / 空的附件目录）
	if files := attachmentsUnder(t, s); len(files) != 0 {
		t.Fatalf("failed start left attachments behind: %v", files)
	}
	h.st.setFailAt(0)
	task, err := s.CreateHandoff(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(resumed) != 1 || resumed[0].ID != task.ID {
		t.Fatalf("resume = %+v", resumed)
	}
	if files := attachmentsUnder(t, s); len(files) != 1 {
		t.Fatalf("retried handoff attachments = %v, want the one image", files)
	}
	// 放行名额，后台首轮拿到这张图
	cancelOtherRunning(s, task.ID)
	waitFor(t, func() bool {
		rec := s.Runtime.Get(task.ID)
		return rec != nil && rec.Task.Status == StatusDone
	})
	var first []blm.ChatMessage
	for _, in := range h.inputs() {
		if len(in) > 0 && in[len(in)-1].Content == "按截图修样式" {
			first = in
			break
		}
	}
	if first == nil {
		t.Fatalf("background never ran the handoff goal: %d calls", len(h.inputs()))
	}
	if imgs := lastUserImages(first); len(imgs) != 1 {
		t.Fatalf("retried handoff lost the image: %d", len(imgs))
	}
}

// 重试复用同一任务身份：重启后（新 Service，从同一份已落盘的快照加载）用同一个来源轮次重试也接着用原来那个
func TestHandoffRetryReusesTaskAcrossRestart(t *testing.T) {
	h := &handoffHarness{}
	s := h.runnableQuery(t)
	h.st.setFail(true)
	_, err := s.CreateHandoff(HandoffInput{SourceID: "req_r", ConversationID: "conv", UserGoal: "g"})
	if err == nil {
		t.Fatal("want failure while storage is down")
	}
	h.st.setFail(false)
	first, err := s.CreateHandoff(HandoffInput{SourceID: "req_r", ConversationID: "conv", UserGoal: "g"})
	if err != nil {
		t.Fatal(err)
	}
	// 退出前这一轮已经结束（等验收 / 跑完），之后可以重新接管
	waitFor(t, func() bool {
		rec := s.Get(first.ID)
		return rec != nil && (IsTerminal(rec.Task.Status) || rec.Task.Status == StatusAwaitingAccept)
	})
	waitFor(t, func() bool { return s.Get(first.ID).Task.Status != StatusRunning })
	s.Stop()

	// 重启：同一份快照，同一个执行者
	s2 := newHandoffService(t, ServiceDeps{}, h.st)
	s2.RegisterExecutor("nomi", h.svc.exec["nomi"])
	s2.Start()
	defer s2.Stop()
	again, err := s2.CreateHandoff(HandoffInput{SourceID: "req_r", ConversationID: "conv", UserGoal: "g"})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID {
		t.Fatalf("restart retry created %s, want %s", again.ID, first.ID)
	}
	waitFor(t, func() bool {
		rec := s2.Runtime.Get(first.ID)
		return rec != nil && rec.Task.Status == StatusDone
	})
}

// attachmentsUnder：存储根目录下附件目录里的文件（接管失败不应留下半截附件）
func attachmentsUnder(t *testing.T, s *Service) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(filepath.Join(s.d.Root, "attachments"), func(p string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !info.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
