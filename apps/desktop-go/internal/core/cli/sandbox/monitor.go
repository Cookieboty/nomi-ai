package sandbox

import (
	"bufio"
	"encoding/json"
	"io"
	"os/exec"
	"sync"
)

// Monitor：读系统日志里带 Nomi 标记的沙箱违规（macOS `log stream`），交给 OnDeny。
// 第一次 Ensure 时启动，进程意外退出后下一次 Ensure 再起；Stop 在应用退出时调用。
type Monitor struct {
	OnDeny func(Denial)

	mu      sync.Mutex
	cmd     *exec.Cmd
	stopped bool
}

// logPredicate：只要 Sandbox 发的、带 Nomi 标记的消息（其他应用的沙箱日志不进来）
const logPredicate = `sender == "Sandbox" AND eventMessage CONTAINS "` + Tag + `"`

// Ensure：确保在读日志（不支持的平台什么也不做）
func (m *Monitor) Ensure() {
	if !Supported() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped || m.cmd != nil {
		return
	}
	cmd := exec.Command("/usr/bin/log", "stream", "--style", "ndjson", "--level", "default", "--predicate", logPredicate)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		return
	}
	m.cmd = cmd
	go m.read(cmd, out)
}

func (m *Monitor) read(cmd *exec.Cmd, out io.Reader) {
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		var line struct {
			EventMessage string `json:"eventMessage"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil {
			continue
		}
		if d, ok := ParseDenial(line.EventMessage); ok && m.OnDeny != nil {
			m.OnDeny(d)
		}
	}
	_ = cmd.Wait()
	m.mu.Lock()
	if m.cmd == cmd {
		m.cmd = nil
	}
	m.mu.Unlock()
}

// Stop：停掉日志读取（之后 Ensure 不再启动）
func (m *Monitor) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped = true
	if m.cmd != nil && m.cmd.Process != nil {
		_ = m.cmd.Process.Kill()
	}
	m.cmd = nil
}
