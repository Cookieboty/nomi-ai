package agents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

// ClaudePidSessions：Claude Code 每个交互进程在 ~/.claude/sessions/<pid>.json 登记当前会话
// （{"pid", "sessionId", ...}，/clear 后会改成新会话）。只读 procs 里的 claude 进程，
// 返回 pid → 会话键（claude:<sessionId>）。读不到的进程不在结果里（老版本没有这个文件）。
func ClaudePidSessions(home string, procs []AgentProc) map[float64]string {
	out := map[float64]string{}
	if home == "" {
		return out
	}
	dir := filepath.Join(home, ".claude", "sessions")
	for _, p := range procs {
		if p.Kind != "claude" || p.Pid <= 0 {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, strconv.FormatInt(int64(p.Pid), 10)+".json"))
		if err != nil || len(raw) > 64*1024 {
			continue
		}
		var v struct {
			Pid       float64 `json:"pid"`
			SessionID string  `json:"sessionId"`
		}
		if json.Unmarshal(raw, &v) != nil || v.SessionID == "" || (v.Pid != 0 && v.Pid != p.Pid) {
			continue
		}
		out[p.Pid] = "claude:" + v.SessionID
	}
	return out
}
