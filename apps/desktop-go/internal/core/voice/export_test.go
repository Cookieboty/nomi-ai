package voice

import (
	"context"
	"os/exec"
	"time"
)

// RunExecForTest：按 whisper.go 的方式跑命令，返回无 stderr 时的 Node err.message
func RunExecForTest(file string, args []string, timeout, abort time.Duration) string {
	parent, pc := context.WithCancel(context.Background())
	defer pc()
	if abort > 0 {
		time.AfterFunc(abort, pc)
	}
	ctx, cancel := parent, context.CancelFunc(func() {})
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(parent, timeout)
	}
	defer cancel()
	cmd := exec.CommandContext(ctx, file, args...)
	if err := cmd.Run(); err != nil {
		return nodeExecMessage(err, file, args, parent)
	}
	return ""
}
