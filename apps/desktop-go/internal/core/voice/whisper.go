package voice

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/types"
)

// CliNames = CLI_NAMES
func CliNames() []string {
	if runtime.GOOS == "windows" {
		return []string{"whisper-cli.exe", "main.exe"}
	}
	return []string{"whisper-cli", "main"}
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// FindCliIn = findCliIn(dir)
func FindCliIn(dir string) string {
	for _, n := range CliNames() {
		for _, p := range []string{filepath.Join(dir, n), filepath.Join(dir, "Release", n), filepath.Join(dir, "bin", n)} {
			if exists(p) {
				return p
			}
		}
	}
	return ""
}

// FindCliOnPath = findCliOnPath(env)
func FindCliOnPath(env map[string]string) string {
	pv, ok := env["PATH"]
	if !ok {
		pv = env["Path"]
	}
	dirs := []string{}
	for _, d := range strings.Split(pv, string(os.PathListSeparator)) {
		if d != "" {
			dirs = append(dirs, d)
		}
	}
	if runtime.GOOS == "darwin" {
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	}
	name := "whisper-cli"
	if runtime.GOOS == "windows" {
		name = "whisper-cli.exe"
	}
	for _, d := range dirs {
		if p := filepath.Join(d, name); exists(p) {
			return p
		}
	}
	return ""
}

// BuildArgs = buildArgs(o)；threads<=0 → max(1, min(8, cpus-1))
func BuildArgs(model, wav, language, prompt string, threads int) []string {
	if language == "" {
		language = "auto"
	}
	args := []string{"-m", model, "-f", wav, "-nt", "-np", "-l", language}
	if threads <= 0 {
		threads = max(1, min(8, runtime.NumCPU()-1))
	}
	args = append(args, "-t", strconv.Itoa(threads))
	if prompt != "" {
		args = append(args, "--prompt", prompt)
	}
	return args
}

var (
	reBlank = types.JSRegexp(`\[(BLANK_AUDIO|MUSIC|NOISE|SOUND|silence)[^\]]*\]`, "gi")
	reNoise = types.JSRegexp(`[([（*]\s*(音乐|掌声|笑声|笑|叹气|music|applause|laughter|laughs?|sighs?|coughs?|inaudible|silence|noise)\s*[)\]）*]`, "gi")
	reWS    = types.JSRegexp(`\s+`, "g")
)

func rep(re interface {
	Replace(string, string, int, int) (string, error)
}, s, r string) string {
	out, err := re.Replace(s, r, -1, -1)
	if err != nil {
		return s
	}
	return out
}

// CleanTranscript = cleanTranscript(s)
func CleanTranscript(s string) string {
	s = rep(reBlank, s, "")
	s = rep(reNoise, s, "")
	s = rep(reWS, s, " ")
	return util.JSTrim(s)
}

// WhisperOpts = runWhisperCli 的参数
type WhisperOpts struct {
	Cli      string
	Model    string
	Wav      []byte
	Language string
	Prompt   string
	Timeout  time.Duration
	T        func(key string, args ...any) string
}

// RunWhisperCli = runWhisperCli(o)
func RunWhisperCli(ctx context.Context, o WhisperOpts) (string, error) {
	dir, err := os.MkdirTemp("", "cd-asr-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	wavPath := filepath.Join(dir, "in.wav")
	if err := os.WriteFile(wavPath, o.Wav, 0o666); err != nil {
		return "", err
	}
	cliDir := filepath.Dir(o.Cli)
	env := os.Environ()
	if runtime.GOOS == "linux" {
		ld := cliDir
		if v := os.Getenv("LD_LIBRARY_PATH"); v != "" {
			ld += ":" + v
		}
		env = append(env, "LD_LIBRARY_PATH="+ld)
	}
	if o.Timeout <= 0 {
		o.Timeout = 120 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()
	args := BuildArgs(o.Model, wavPath, o.Language, o.Prompt, 0)
	cmd := exec.CommandContext(cctx, o.Cli, args...)
	cmd.Dir = cliDir
	cmd.Env = env
	hideWindow(cmd)
	var stdout, stderr limitedBuf
	stdout.max, stderr.max = 8<<20, 8<<20
	stdout.name, stderr.name = "stdout", "stderr"
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := stderr.String()
		if msg == "" {
			msg = nodeExecMessage(err, o.Cli, args, ctx)
		}
		return "", errors.New(o.T("electron.common.whisper-cpp-failed", util.UTF16Tail(msg, 300)))
	}
	return CleanTranscript(stdout.String()), nil
}

type limitedBuf struct {
	b    []byte
	max  int
	name string
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	if len(l.b)+len(p) > l.max {
		return 0, errMaxBuffer(l.name + " maxBuffer length exceeded")
	}
	l.b = append(l.b, p...)
	return len(p), nil
}

func (l *limitedBuf) String() string { return strings.ToValidUTF8(string(l.b), "\uFFFD") }

type errMaxBuffer string

func (e errMaxBuffer) Error() string { return string(e) }

// nodeExecMessage = execFile 回调里 err.message（stderr 为空时，见 node:child_process exithandler）：
// 退出码非 0 / 超时被杀 → `Command failed: <file> <args...>\n<stderr>`；spawn 失败 → `spawn <file> <CODE>`；
// signal 中止 → AbortError 'The operation was aborted'；maxBuffer → '<stdout|stderr> maxBuffer length exceeded'
func nodeExecMessage(err error, cli string, args []string, parent context.Context) string {
	var mb errMaxBuffer
	if errors.As(err, &mb) {
		return string(mb)
	}
	if parent.Err() != nil {
		return "The operation was aborted"
	}
	cmd := cli
	if len(args) > 0 {
		cmd += " " + strings.Join(args, " ")
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return "Command failed: " + cmd + "\n"
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
		return "spawn " + cli + " ENOENT"
	}
	if errors.Is(err, os.ErrPermission) {
		return "spawn " + cli + " EACCES"
	}
	return err.Error()
}
