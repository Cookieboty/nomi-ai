package tasks

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

func TestCliExplicitAutoJudgeFalseAsks(t *testing.T) {
	no := false
	tk := Task{Grant: Grant{Level: 4, AutoJudge: &no, Connections: []ConnectionGrant{{Capabilities: []string{"github.pr.create"}}}}, Executor: ExecutorSpec{Kind: "cli"}}
	for _, askCommands := range []*bool{nil, ptr(false), ptr(true)} {
		tk.Executor.AskCommands = askCommands
		for _, summary := range []string{"Bash: npm test", "Bash: git push origin topic"} {
			if got := DecidePermission(tk, "", summary, false, autoJudge(tk)); got != "ask" {
				t.Fatalf("explicit AutoJudge=false, AskCommands=%v, %q: got %s, want ask", askCommands, summary, got)
			}
		}
	}
	// 全部自动仍覆盖逐条审批，但不覆盖事件污染或敏感命令。
	tk.Executor.AskCommands = nil
	if got := DecidePermission(tk, "", "Bash: npm test", false, true); got != "allow" {
		t.Fatal(got)
	}
	for _, summary := range []string{"Bash: gh auth token", "Bash: gh pr merge 1"} {
		if got := DecidePermission(tk, "", summary, false, true); got != "ask" {
			t.Fatal(got)
		}
	}
	if got := DecidePermission(tk, "", "Bash: npm test", true, true); got != "ask" {
		t.Fatal(got)
	}
	tk.Grant.Level = 2
	if got := DecidePermission(tk, "", "Bash: npm test", false, false); got != "deny" {
		t.Fatal(got)
	}
}

// Retry must preserve the accepted follow-up, not silently repeat the original goal.
func TestNomiFollowUpRetryRetainsContext(t *testing.T) {
	p := filepath.Join(t.TempDir(), "image.png")
	if err := os.WriteFile(p, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	note := "FOLLOWUP_SENTINEL: revise only the last paragraph"
	previous := "PREVIOUS_SENTINEL: the original document is finished"
	tk := Task{ID: "task_1", SchemaVersion: SchemaVersion, Status: StatusDone, Enabled: true, Gen: 1, Grant: Grant{Level: 3}, Budget: Budget{MaxRetries: 3}, Goal: "ORIGINAL_GOAL", Executor: ExecutorSpec{Kind: "nomi"}}
	a := &Attempt{ID: "a1", TaskID: "task_1", Gen: 1, Status: "succeeded", Cause: AttemptCause{EventKey: sp("event_1")}, Result: &AttemptResult{Summary: previous}}
	storeDir := t.TempDir()
	persist := func(task Task, attempt *Attempt) (Task, *Attempt) {
		t.Helper()
		if _, err := NewStore(storeDir, &nopLog{}).Save(Record{Task: task, Attempts: []Attempt{*attempt}}); err != nil {
			t.Fatal(err)
		}
		// 重建 Store，只保留本次执行：不能靠进程内指针或更早的成功执行找回结论。
		rec, err := NewStore(storeDir, &nopLog{}).Load(task.ID)
		if err != nil || rec == nil || len(rec.Attempts) != 1 {
			t.Fatalf("reload: %+v %v", rec, err)
		}
		return rec.Task, &rec.Attempts[0]
	}

	follow := Transition(tk, a, Event{Type: "follow_up", Feedback: note, Images: []string{p}, At: 10})
	if !follow.OK {
		t.Fatalf("follow-up: %+v", follow)
	}
	started := Transition(follow.Task, follow.Attempt, Event{Type: "slot_acquired", At: 20, AttemptID: "a2"})
	if !started.OK {
		t.Fatalf("start: %+v", started)
	}
	tk, a = persist(started.Task, started.Attempt)
	for retry := 0; retry < 2; retry++ {
		failed := Transition(tk, a, Event{Type: "failed", Gen: ptr(a.Gen), At: int64(100 + retry*10000), Error: &TaskError{Code: "network"}})
		if !failed.OK || failed.Task.Pending == nil {
			t.Fatalf("failure: %+v", failed)
		}
		savedTask, savedAttempt := persist(failed.Task, failed.Attempt)
		next := Transition(savedTask, savedAttempt, Event{Type: "slot_acquired", At: int64(10000 + retry*10000), AttemptID: fmt.Sprintf("retry_%d", retry)})
		if !next.OK {
			t.Fatalf("start retry: %+v", next)
		}
		if !next.Attempt.Cause.FromExternalEvent() {
			t.Fatal("follow-up retry lost external taint")
		}
		if next.Attempt.Cause.Kind != "retry" {
			t.Fatal("retry cause must retain its reconciliation semantics")
		}
		msgs := BuildPrompt(AttemptContext{Task: next.Task, Attempt: *next.Attempt, Previous: savedAttempt}, "", 10000, nil)
		if !strings.Contains(msgs[0].Content, note) || !strings.Contains(msgs[0].Content, previous) || len(msgs[1].Images) != 1 {
			t.Fatalf("retry %d lost follow-up context: cause=%+v images=%d prompt=%q", retry, next.Attempt.Cause, len(msgs[1].Images), msgs[0].Content)
		}
		tk, a = next.Task, next.Attempt
	}
	for recovery := 0; recovery < 2; recovery++ {
		at := int64(30000 + recovery*10000)
		restarted := Transition(tk, a, Event{Type: "restarted", At: at})
		if !restarted.OK {
			t.Fatal(restarted)
		}
		savedTask, savedAttempt := persist(restarted.Task, restarted.Attempt)
		resumed := Transition(savedTask, savedAttempt, Event{Type: "slot_acquired", At: at + 1, AttemptID: fmt.Sprintf("resumed_%d", recovery)})
		if !resumed.OK || resumed.Attempt.Cause.Kind != "resume" {
			t.Fatal(resumed)
		}
		tk, a = persist(resumed.Task, resumed.Attempt)
		msgs := BuildPrompt(AttemptContext{Task: tk, Attempt: *a}, "", at+1, nil)
		if !strings.Contains(msgs[0].Content, note) || !strings.Contains(msgs[0].Content, previous) || len(msgs[1].Images) != 1 {
			t.Fatalf("restart %d lost follow-up context: %+v", recovery, a.Cause)
		}
		if !a.Cause.FromExternalEvent() {
			t.Fatal("resumed follow-up lost external taint")
		}
	}
	done := Transition(tk, a, Event{Type: "completed", Gen: ptr(a.Gen), At: 50000, Result: &AttemptResult{Summary: "revised"}})
	triggered := Transition(done.Task, done.Attempt, Event{Type: "trigger", Cause: "manual", At: 50001})
	fresh := Transition(triggered.Task, triggered.Attempt, Event{Type: "slot_acquired", At: 50002, AttemptID: "manual"})
	if !fresh.OK || fresh.Attempt.Cause.FollowUp != nil || len(fresh.Attempt.Cause.Images) != 0 {
		t.Fatalf("new manual run inherited stale follow-up: %+v", fresh)
	}
}

func TestRecurringCliAutoAcceptanceLandsWorktree(t *testing.T) {
	for _, kind := range []string{"schedule", "event"} {
		for _, acceptance := range []string{"", "user"} {
			label := acceptance
			if label == "" {
				label = "default-auto"
			}
			t.Run(kind+"/"+label, func(t *testing.T) {
				f := newFakeCli(map[string]bool{"claude": true})
				type retirement struct {
					kind  string
					iso   CliIsolation
					files []string
				}
				retired := make(chan retirement, 4)
				var changes, ids atomic.Int64
				ex := NewCliExecutor(CliDeps{
					Harness: f,
					PrepareIsolation: func(cwd, key, base string) (CliIsolation, error) {
						return CliIsolation{Kind: "worktree", Cwd: "/wt/" + key, SourceCwd: cwd, GitRoot: cwd, WorktreePath: "/wt/" + key}, nil
					},
					ReleaseIsolation: func(iso CliIsolation) { retired <- retirement{kind: "released", iso: iso} },
					Land: func(iso CliIsolation, files []string, _ string) WorktreeApply {
						retired <- retirement{kind: "landed", iso: iso, files: files}
						return WorktreeApply{}
					},
					GitChanged: func(string) []string {
						if changes.Add(1)%2 == 1 {
							return []string{}
						}
						return []string{"result.txt"}
					},
					BuildPrompt: func(goal, _, _, _ string) string { return goal },
					ParseReport: func(string) *CliReport { return &CliReport{Done: "done", ChangedFiles: []string{"result.txt"}} },
					DirOk:       func(string) bool { return true },
				})
				rt := NewRuntime(RuntimeDeps{
					Store: newMemStoreSafe(), Executors: map[string]Executor{"cli": ex},
					Now: func() int64 { return 1800000000000 }, SetTimer: func(func(), int64) func() { return func() {} },
					NewID: func(p string) string { return fmt.Sprintf("%s_%d", p, ids.Add(1)) }, Log: &nopLog{},
				})
				rt.Start()
				defer rt.Stop()
				trigger := Trigger{Kind: kind}
				if kind == "schedule" {
					trigger.At = ptr(int64(1800000060000))
					trigger.Repeat = &schedule.Repeat{Kind: "daily"}
				}
				id := rt.Create(CreateInput{
					Title: "repeat", Goal: "generate result", Trigger: trigger, Acceptance: acceptance,
					Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), Cwd: sp("/repo"), BaseBranch: sp("other")}, Grant: Grant{Level: 3},
				}).ID
				if acceptance == "" && rt.Get(id).Task.Acceptance != "auto" {
					t.Fatal("not default auto")
				}
				previousWorktree := ""
				for round := 1; round <= 2; round++ {
					if res := rt.Command(id, Command{Type: "runNow"}); !res.OK {
						t.Fatal(res)
					}
					waitFor(t, func() bool { return f.sendCount() == round })
					f.finish("done")
					if acceptance == "user" {
						waitFor(t, func() bool { return rt.Get(id).Task.Status == StatusAwaitingAccept })
						select {
						case got := <-retired:
							t.Fatalf("retired before acceptance: %+v", got)
						default:
						}
						if res := rt.Command(id, Command{Type: "accept"}); !res.OK {
							t.Fatal(res)
						}
					}
					select {
					case got := <-retired:
						if got.kind != "landed" || !slices.Equal(got.files, []string{"result.txt"}) || got.iso.SourceCwd != "/repo" {
							t.Fatalf("successful recurring task retirement: %+v", got)
						}
						if got.iso.WorktreePath == previousWorktree {
							t.Fatal("next run reused a retired worktree")
						}
						previousWorktree = got.iso.WorktreePath
					case <-time.After(time.Second):
						t.Fatal("no retirement")
					}
					if rt.Get(id).Task.Status != StatusIdle {
						t.Fatal("recurring task did not return to idle")
					}
				}
			})
		}
	}
}

func TestRejectedFollowUpKeepsAcceptedImages(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, Now: func() int64 { return 1800000000000 }, SetTimer: func(func(), int64) func() { return func() {} }})
	s.Runtime.SetAdmit(func(Task) bool { return false })
	s.Runtime.Start()
	defer s.Runtime.Stop()
	id := s.Runtime.Create(CreateInput{Title: "t", Goal: "g", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}, Grant: Grant{Level: 3}}).ID
	img := func(s string) FollowUpImage {
		return FollowUpImage{Mime: "image/png", Data: base64.StdEncoding.EncodeToString([]byte(s))}
	}
	if res := s.FollowUp(id, "first", img("FIRST")); !res.OK {
		t.Fatal(res)
	}
	path := s.Get(id).Task.Pending.Images[0]
	if res := s.FollowUp(id, "duplicate", img("SECOND")); res.OK || res.Reason != "busy" {
		t.Fatal(res)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "FIRST" {
		t.Fatalf("accepted image corrupted by rejected follow-up: raw=%q err=%v", raw, err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("rejected request did not clean its attachments: %v %v", entries, err)
	}

}

// A later invalid attachment must not leak files already saved for this request.
func TestFollowUpImageFailureCleansPartialFiles(t *testing.T) {
	for _, bad := range []FollowUpImage{{Mime: "text/plain", Data: "eA=="}, {Mime: "image/png", Data: "not-base64"}} {
		s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}})
		_, err := s.saveFollowUpImages("task_1", []FollowUpImage{{Mime: "image/png", Data: "eA=="}, bad})
		if err == nil {
			t.Fatal("invalid image accepted")
		}
		if err := filepath.WalkDir(s.d.Root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() {
				t.Errorf("partial attachment left behind: %s", p)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestConcurrentFollowUpImageFilesArePrivateAndUnique(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, Now: func() int64 { return 1800000000000 }})
	type saved struct {
		files []string
		err   error
		body  string
	}
	results := make(chan saved, 8)
	for i := 0; i < cap(results); i++ {
		go func(i int) {
			body := fmt.Sprintf("image-%d", i)
			files, err := s.saveFollowUpImages("task_1", []FollowUpImage{{Mime: "image/png", Data: base64.StdEncoding.EncodeToString([]byte(body))}})
			results <- saved{files: files, err: err, body: body}
		}(i)
	}
	seen := map[string]bool{}
	// Drain all writers before reporting failures, so no goroutine outlives TempDir cleanup.
	for i := 0; i < cap(results); i++ {
		result := <-results
		if result.err != nil || len(result.files) != 1 {
			t.Errorf("save: %+v", result)
			continue
		}
		p := result.files[0]
		if seen[p] {
			t.Errorf("shared path: %s", p)
		}
		seen[p] = true
		raw, err := os.ReadFile(p)
		if err != nil || string(raw) != result.body {
			t.Errorf("image corrupted: %q %v", raw, err)
		}
		info, err := os.Stat(p)
		if err != nil {
			t.Error(err)
		} else if info.Mode().Perm() != 0600 {
			t.Errorf("attachment mode %v, want 0600", info.Mode())
		}
	}
}
