package tasks

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func outboxHarness(t *testing.T, file string, fail func() bool, quiet func() *int64) (*Outbox, *fakeClock, *[]string) {
	clock := &fakeClock{t: 1_800_000_000_000}
	sent := []string{}
	n := 0
	ob := NewOutbox(OutboxDeps{File: file, Now: clock.Now, SetTimer: clock.SetTimer, Log: &nopLog{},
		NewID: func() string { n++; return fmt.Sprintf("o%d", n) },
		Send: func(title, text string) error {
			if fail != nil && fail() {
				return errors.New("down")
			}
			sent = append(sent, text)
			return nil
		},
		QuietUntil: quiet,
		MergedText: func(items []OutboxItem) (string, string) {
			ts := []string{}
			for _, x := range items {
				ts = append(ts, x.TaskTitle)
			}
			return "T", fmt.Sprintf("%d:%s", len(items), strings.Join(ts, ","))
		}})
	return ob, clock, &sent
}

func TestOutboxMergeQuietRetryReplay(t *testing.T) {
	dir := t.TempDir()
	ob, clock, sent := outboxHarness(t, filepath.Join(dir, "a.json"), nil, nil)
	ob.Push("task_1", "t1", "T", "msg1")
	clock.Advance(1000)
	ob.Push("task_2", "t2", "T", "msg2")
	ob.Push("task_3", "t3", "T", "msg3")
	if len(*sent) != 1 {
		t.Fatal(*sent)
	}
	clock.Advance(MergeWindowMs)
	if strings.Join(*sent, "|") != "msg1|2:t2,t3" || len(ob.Pending()) != 0 {
		t.Fatal(*sent)
	}

	until := int64(1_800_000_000_000 + 3600_000)
	qob, qclock, qsent := outboxHarness(t, filepath.Join(dir, "q.json"), nil, func() *int64 {
		return &until
	})
	qob.Push("task_1", "t1", "T", "m1")
	qob.Push("task_2", "t2", "T", "m2")
	if len(*qsent) != 0 {
		t.Fatal(*qsent)
	}
	qclock.Advance(3600_000)
	if strings.Join(*qsent, "|") != "2:t1,t2" {
		t.Fatal(*qsent)
	}

	down := 3
	rob, rclock, rsent := outboxHarness(t, filepath.Join(dir, "r.json"), func() bool { down--; return down >= 0 }, nil)
	rob.Push("task_1", "t1", "T", "m1")
	rclock.Advance(2000)
	rclock.Advance(4000)
	if len(*rsent) != 0 {
		t.Fatal(*rsent)
	}
	rclock.Advance(8000)
	if strings.Join(*rsent, "|") != "m1" {
		t.Fatal(*rsent)
	}

	// 先存再发：发不出去的留在文件里，重启后补发
	f := filepath.Join(dir, "p.json")
	pob, _, _ := outboxHarness(t, f, func() bool { return true }, nil)
	pob.Push("task_1", "t1", "T", "m1")
	pob.Stop()
	nob, nclock, nsent := outboxHarness(t, f, nil, nil)
	nob.Start()
	nclock.Advance(0)
	if strings.Join(*nsent, "|") != "m1" || len(nob.Pending()) != 0 {
		t.Fatal(*nsent)
	}
}
