package main

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 外部会话卡片的「有动静」时间用会话最后一次有动静（mtime），不是监视轮询的时间（updatedAt 每轮都是现在）
func TestFleetExternalUsesLastActivity(t *testing.T) {
	st := util.NewObj("sessions", []any{
		util.NewObj("id", "claude:s1", "source", "file", "status", "waiting", "mtime", float64(1_000), "updatedAt", float64(9_000)),
		util.NewObj("id", "claude:s2", "source", "file", "status", "waiting", "updatedAt", float64(9_000)),
		util.NewObj("id", "tab:x", "source", "tab", "mtime", float64(1_000)),
	})
	out := fleetExternal(st)
	if len(out) != 2 {
		t.Fatalf("only file sessions are external: %+v", out)
	}
	if out[0].UpdatedAt != 1_000 {
		t.Fatalf("last activity, not the poll time: %d", out[0].UpdatedAt)
	}
	if out[1].UpdatedAt != 9_000 {
		t.Fatalf("falls back to updatedAt without mtime: %d", out[1].UpdatedAt)
	}
}
