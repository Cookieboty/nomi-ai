package sandbox

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"

	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// 对应 CodeSandbox.ts：JS 走 Node 权限模型，Python 走平台隔离；最小化环境变量、超时强杀、输出截断、运行后删临时目录。

const maxOut = 20_000

// EnvVar 是有序环境变量（对象键插入序）。
type EnvVar struct{ Key, Value string }

// MinimalEnv 是 minimalEnv：不继承 API key / 令牌等；extra 覆盖同名键但保持首次出现位置。
func MinimalEnv(tmp string, extra []EnvVar) []EnvVar {
	out := []EnvVar{}
	set := func(k, v string) {
		for i := range out {
			if out[i].Key == k {
				out[i].Value = v
				return
			}
		}
		out = append(out, EnvVar{k, v})
	}
	for _, k := range []string{"PATH", "SYSTEMROOT", "WINDIR", "LANG", "TZ"} {
		if v, ok := lookupEnv(k); ok && v != "" {
			set(k, v)
		}
	}
	for _, k := range []string{"HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"} {
		set(k, tmp)
	}
	for _, e := range extra {
		set(e.Key, e.Value)
	}
	return out
}

// RunResult 是 CodeRunResult；ExitCode 为 nil 表示被信号终止。
type RunResult struct {
	ExitCode  *int   `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
	Ms        int64  `json:"ms"`
	Sandbox   string `json:"sandbox,omitempty"`
}

// RunOpts 是 run 的 opts。
type RunOpts struct {
	TimeoutMs int
	Stdin     string
}

// Options 是构造参数。NodeBin 为空时取 PATH 上的 node（Go 宿主无内嵌 Node，见 D-B7-S2-5）；
// RunAsNode 为 nil 视为 true（注入 ELECTRON_RUN_AS_NODE=1）。
type Options struct {
	NodeBin   string
	RunAsNode *bool
}

// CodeSandbox 是 CodeSandbox。
type CodeSandbox struct {
	opts    Options
	pyOnce  sync.Once
	pyCache string
}

// New 构造 CodeSandbox。
func New(opts Options) *CodeSandbox { return &CodeSandbox{opts: opts} }

func (s *CodeSandbox) python() string {
	s.pyOnce.Do(func() {
		cands := []string{"python3", "python"}
		if NodePlatform() == "win32" {
			cands = []string{"python", "py"}
		}
		for _, c := range cands {
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			cmd := exec.CommandContext(ctx, c, "-c", "import sys;print(sys.version_info[0])")
			hideWindow(cmd)
			out, err := cmd.Output()
			cancel()
			if err == nil && strings.TrimSpace(string(out)) == "3" {
				s.pyCache = c
				return
			}
		}
	})
	return s.pyCache
}

// Available 是 available()。
func (s *CodeSandbox) Available() []string {
	out := []string{"javascript"}
	if s.python() != "" {
		out = append(out, "python")
	}
	return out
}

// 按 JS 字符串（UTF-16 码元）计长的输出缓冲
type capBuf struct {
	units     []uint16
	truncated *bool
}

func (c *capBuf) add(chunk []byte) {
	if len(c.units) >= maxOut {
		*c.truncated = true
		return
	}
	c.units = append(c.units, utf16.Encode([]rune(decodeUTF8(chunk)))...)
	if len(c.units) > maxOut {
		*c.truncated = true
		c.units = c.units[:maxOut]
	}
}

func (c *capBuf) String() string { return jsString(c.units) }

// jsString 把 UTF-16 码元转回 Go 字符串；孤立代理项按 WTF-8 之外的 U+FFFD 处理（与 JSON 序列化后一致的可见文本）
func jsString(u []uint16) string { return string(utf16.Decode(u)) }

// decodeUTF8 是 Buffer.toString('utf8')：非法字节替换为 U+FFFD
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		sb.WriteRune(r)
		b = b[n:]
	}
	return sb.String()
}

type chunkWriter struct {
	mu *sync.Mutex
	b  *capBuf
}

func (w chunkWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.b.add(p)
	w.mu.Unlock()
	return len(p), nil
}

// Run 是 run(lang, code, opts, signal)；ctx 取消对应 AbortSignal。
func (s *CodeSandbox) Run(ctx context.Context, lang, code string, opts RunOpts) (*RunResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	mk, err := os.MkdirTemp(os.TempDir(), "cd-sbx-")
	if err != nil {
		return nil, err
	}
	tmp, err := realpath(mk)
	if err != nil {
		os.RemoveAll(mk)
		return nil, err
	}
	defer os.RemoveAll(tmp)
	t0 := time.Now()
	var cmdName string
	var args []string
	var env []EnvVar
	var sandbox string
	if lang == "javascript" {
		file := filepath.Join(tmp, "main.cjs")
		if err := os.WriteFile(file, []byte(code), 0o666); err != nil {
			return nil, err
		}
		cmdName = s.opts.NodeBin
		if cmdName == "" {
			cmdName = "node"
		}
		args = []string{"--permission", "--allow-fs-read=" + tmp, "--allow-fs-write=" + tmp,
			"--disallow-code-generation-from-strings", "--max-old-space-size=256", file}
		var extra []EnvVar
		if s.opts.RunAsNode == nil || *s.opts.RunAsNode {
			extra = []EnvVar{{"ELECTRON_RUN_AS_NODE", "1"}}
		}
		env = MinimalEnv(tmp, extra)
		sandbox = "node-permission"
	} else {
		py := s.python()
		if py == "" {
			return nil, errors.New("python unavailable")
		}
		file := filepath.Join(tmp, "main.py")
		if err := os.WriteFile(file, []byte(code), 0o666); err != nil {
			return nil, err
		}
		plan := PlanPythonSandbox(PlanOpts{Python: py, ScriptPath: file, TmpDir: tmp})
		cmdName, args = plan.Cmd, plan.Args
		env = MinimalEnv(tmp, []EnvVar{{"PYTHONIOENCODING", "utf-8"}})
		sandbox = plan.Isolation
		if plan.Reason != "" {
			log.Printf("[CodeSandbox] python isolation=%s: %s", plan.Isolation, plan.Reason)
		}
	}

	res := &RunResult{Sandbox: sandbox}
	var mu sync.Mutex
	stdout := &capBuf{truncated: &res.Truncated}
	stderr := &capBuf{truncated: &res.Truncated}
	cmd := exec.Command(cmdName, args...)
	cmd.Dir = tmp
	cmd.Env = make([]string, 0, len(env))
	for _, e := range env {
		cmd.Env = append(cmd.Env, e.Key+"="+e.Value)
	}
	// 同 Node spawn：Windows 上 libuv 补齐 HOMEDRIVE/USERNAME 等必需变量
	cmd.Env = nodeproc.LibuvEnv(cmd.Env)
	hideWindow(cmd)
	cmd.Stdout = chunkWriter{&mu, stdout}
	cmd.Stderr = chunkWriter{&mu, stderr}
	stdin, perr := cmd.StdinPipe()
	if perr == nil {
		perr = cmd.Start()
	}
	if perr != nil {
		// spawn 失败：Node 先发 error（stderr 追加消息），close 码为负 errno
		res.Stderr = stderr.String() + spawnErrorMessage(cmdName, perr)
		res.ExitCode = spawnErrorCode(perr)
		res.Ms = time.Since(t0).Milliseconds()
		return res, nil
	}
	go func() {
		// 程序不读 stdin 就退出时写入会 EPIPE；属正常情况
		if opts.Stdin != "" {
			_, _ = io.Copy(stdin, bytes.NewReader([]byte(opts.Stdin)))
		}
		_ = stdin.Close()
	}()
	var killMu sync.Mutex
	killed := false
	kill := func() {
		killMu.Lock()
		killed = true
		killMu.Unlock()
		_ = cmd.Process.Kill()
	}
	timer := time.AfterFunc(time.Duration(opts.TimeoutMs)*time.Millisecond, func() {
		mu.Lock()
		res.TimedOut = true
		mu.Unlock()
		kill()
	})
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			kill()
		case <-done:
		}
	}()
	werr := cmd.Wait()
	close(done)
	timer.Stop()
	mu.Lock()
	defer mu.Unlock()
	killMu.Lock()
	wasKilled := killed
	killMu.Unlock()
	res.Stdout, res.Stderr = stdout.String(), stderr.String()
	res.ExitCode = exitCodeOf(cmd, werr, wasKilled)
	res.Ms = time.Since(t0).Milliseconds()
	return res, nil
}

func exitCodeOf(cmd *exec.Cmd, werr error, killed bool) *int {
	st := cmd.ProcessState
	if st == nil {
		return nil
	}
	if signaled(st) || (killed && NodePlatform() == "win32") {
		return nil
	}
	c := st.ExitCode()
	if c < 0 {
		return nil
	}
	_ = werr
	return &c
}

func spawnErrorMessage(cmd string, err error) string {
	return "spawn " + cmd + " " + errnoName(err)
}
