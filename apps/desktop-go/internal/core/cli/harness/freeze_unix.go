//go:build !windows

package harness

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// suspendPid / resumePid：冻结 / 恢复一个进程（SIGSTOP / SIGCONT）
func suspendPid(pid int) error { return syscall.Kill(pid, syscall.SIGSTOP) }
func resumePid(pid int) error  { return syscall.Kill(pid, syscall.SIGCONT) }

// procStarts：进程的启动时间（ps -o lstart），用来认「还是不是当初那个进程」（pid 会被复用）；读不到的不在结果里
func procStarts(pids []int) map[int]string {
	out := map[int]string{}
	if len(pids) == 0 {
		return out
	}
	list := make([]string, len(pids))
	for i, p := range pids {
		list[i] = strconv.Itoa(p)
	}
	b, _ := exec.Command("ps", "-o", "pid=,lstart=", "-p", strings.Join(list, ",")).Output()
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		if pid, err := strconv.Atoi(f[0]); err == nil {
			out[pid] = strings.Join(f[1:], " ")
		}
	}
	return out
}
