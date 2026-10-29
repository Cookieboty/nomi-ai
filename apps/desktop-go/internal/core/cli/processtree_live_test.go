package cli

// 真实进程树：父 node 再拉起子 node（Windows 上走 taskkill /T /F，其它平台 pgrep -P 递归 + SIGKILL），
// KillProcessTree 之后两者都必须消失。与 Node killProcessTree 的可观察结果一致。

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

func pidAlive(t *testing.T, node string, pid int) bool {
	out, err := exec.Command(node, "-e", "try{process.kill("+strconv.Itoa(pid)+",0);process.stdout.write('1')}catch(e){process.stdout.write(e.code==='EPERM'?'1':'0')}").Output()
	if err != nil {
		t.Fatal(err)
	}
	return string(out) == "1"
}

func TestKillProcessTreeLive(t *testing.T) {
	node := findNode(t)
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "grandchild.pid")
	script := filepath.Join(dir, "parent.js")
	src := `const {spawn}=require('child_process');const fs=require('fs');
const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(process.argv[2],String(c.pid));setInterval(()=>{},1000);`
	if err := os.WriteFile(script, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	// nodeproc.Child 的方法须在 jsrt 线程内调用（与 Node 单线程一致）
	var child *nodeproc.Child
	jsrt.Run(func() {
		child = nodeproc.Spawn(node, []string{script, pidFile}, nodeproc.Options{IgnoreStdin: true, IgnoreStderr: true})
	})
	if child.Pid == 0 {
		t.Fatal("spawn failed")
	}
	var gpid int
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(pidFile); err == nil && strings.TrimSpace(string(b)) != "" {
			gpid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if gpid == 0 {
		t.Fatal("grandchild pid not written")
	}
	if !pidAlive(t, node, gpid) {
		t.Fatal("grandchild not running before kill")
	}
	jsrt.Run(func() { KillProcessTree(NodeChild{child}) })
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !pidAlive(t, node, gpid) && !pidAlive(t, node, child.Pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("process tree survived: parent %d alive=%v grandchild %d alive=%v", child.Pid, pidAlive(t, node, child.Pid), gpid, pidAlive(t, node, gpid))
}
