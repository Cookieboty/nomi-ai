package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// 对应 platformSandbox.ts：Python 路径的平台隔离（macOS sandbox-exec / Linux bwrap / Windows 无 FS jail）。

// Isolation 是 PlatformSandboxIsolation。
type Isolation = string

// Plan 是 PlatformSandboxPlan。
type Plan struct {
	Cmd       string    `json:"cmd"`
	Args      []string  `json:"args"`
	Isolation Isolation `json:"isolation"`
	Reason    string    `json:"reason,omitempty"`
	Platform  string    `json:"platform"`
}

// NodePlatform 是 process.platform。
func NodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// FindOnPath 是 findOnPath：which / where 找第一行；找不到返回 nil。
func FindOnPath(bin, platform string) *string {
	if platform == "" {
		platform = NodePlatform()
	}
	cmd := "which"
	if platform == "win32" {
		cmd = "where"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, cmd, bin)
	hideWindow(c)
	out, err := c.Output()
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(strings.ReplaceAll(strings.TrimSpace(string(out)), "\r\n", "\n"), "\n") {
		if l := strings.TrimSpace(line); l != "" {
			return &l
		}
	}
	return nil
}

func escapeSb(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
}

// BuildSeatbeltProfile 是 buildSeatbeltProfile。
func BuildSeatbeltProfile(tmpDir, python string, allowNetwork bool) string {
	net := "(deny network*)\n(deny network-outbound)\n(deny network-inbound)"
	if allowNetwork {
		net = "(allow network*)"
	}
	tmp, py := escapeSb(tmpDir), escapeSb(python)
	return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec
  (literal "` + py + `")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read*
  (subpath "/usr")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/private/var/db")
  (subpath "` + tmp + `")
  (literal "` + py + `")
)
(allow file-write*
  (subpath "` + tmp + `")
)
(allow file-ioctl (subpath "` + tmp + `"))
` + net + "\n"
}

// BwrapOpts 是 buildBwrapArgs 的入参；PythonArgs 为 nil 表示缺省 ['-I']。
type BwrapOpts struct {
	Python, ScriptPath, TmpDir string
	AllowNetwork               bool
	PythonArgs                 []string
	Exists                     func(string) bool
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// realpath 是 fs.realpathSync（不存在则出错）。
func realpath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// BuildBwrapArgs 是 buildBwrapArgs：只读系统树 + 可写 tmp + 可选禁网。
func BuildBwrapArgs(o BwrapOpts) []string {
	exists := o.Exists
	if exists == nil {
		exists = fileExists
	}
	binds := []string{}
	for _, dir := range []string{"/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc", "/proc", "/dev"} {
		if !exists(dir) {
			continue
		}
		switch dir {
		case "/proc":
			binds = append(binds, "--proc", "/proc")
		case "/dev":
			binds = append(binds, "--dev", "/dev")
		default:
			binds = append(binds, "--ro-bind", dir, dir)
		}
	}
	if realPy, err := realpath(o.Python); err == nil {
		pyDir := filepath.Dir(realPy)
		if strings.HasPrefix(pyDir, "/") && !strings.HasPrefix(pyDir, o.TmpDir) &&
			!strings.HasPrefix(pyDir, "/usr") && !strings.HasPrefix(pyDir, "/bin") && !contains(binds, pyDir) {
			binds = append(binds, "--ro-bind", pyDir, pyDir)
		}
	}
	args := append(binds, "--bind", o.TmpDir, o.TmpDir, "--chdir", o.TmpDir, "--die-with-parent", "--unshare-pid")
	if !o.AllowNetwork {
		args = append(args, "--unshare-net")
	}
	pa := o.PythonArgs
	if pa == nil {
		pa = []string{"-I"}
	}
	args = append(args, "--", o.Python)
	args = append(args, pa...)
	return append(args, o.ScriptPath)
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// OptPath 是可选路径注入：Set=false 即 undefined；Set 且 Path=nil 即 null。
type OptPath struct {
	Set  bool
	Path *string
}

// PlanOpts 是 PlanPythonSandboxOpts。
type PlanOpts struct {
	Python, ScriptPath, TmpDir string
	AllowNetwork               bool
	Platform                   string
	BwrapPath                  OptPath
	SandboxExecPath            OptPath
	Exists                     func(string) bool
}

func (o OptPath) truthy() bool { return o.Set && o.Path != nil && *o.Path != "" }

// PlanPythonSandbox 是 planPythonSandbox；无可用二进制时 isolation='fallback'。
func PlanPythonSandbox(o PlanOpts) Plan {
	platform := o.Platform
	if platform == "" {
		platform = NodePlatform()
	}
	pythonArgs := []string{"-I", o.ScriptPath}
	exists := o.Exists
	if exists == nil {
		exists = fileExists
	}
	bare := func(iso, reason string) Plan {
		return Plan{Cmd: o.Python, Args: pythonArgs, Isolation: iso, Reason: reason, Platform: platform}
	}
	switch platform {
	case "darwin":
		var sb *string
		switch {
		case o.SandboxExecPath.Set && o.SandboxExecPath.Path == nil:
		case o.SandboxExecPath.truthy():
			sb = o.SandboxExecPath.Path
		case exists("/usr/bin/sandbox-exec"):
			s := "/usr/bin/sandbox-exec"
			sb = &s
		default:
			sb = FindOnPath("sandbox-exec", platform)
		}
		if sb != nil && *sb != "" {
			profile := BuildSeatbeltProfile(o.TmpDir, o.Python, o.AllowNetwork)
			return Plan{Cmd: *sb, Args: append([]string{"-p", profile, o.Python}, pythonArgs...), Isolation: "sandbox-exec", Platform: platform}
		}
		return bare("fallback", "sandbox-exec unavailable")
	case "linux":
		var bw *string
		if o.BwrapPath.Set {
			bw = o.BwrapPath.Path
		} else {
			bw = FindOnPath("bwrap", platform)
		}
		if bw != nil && *bw != "" {
			return Plan{Cmd: *bw, Args: BuildBwrapArgs(BwrapOpts{Python: o.Python, ScriptPath: o.ScriptPath, TmpDir: o.TmpDir, AllowNetwork: o.AllowNetwork, Exists: exists}), Isolation: "bwrap", Platform: platform}
		}
		return bare("fallback", "bwrap not found on PATH")
	}
	return bare("none", "windows-no-fs-jail")
}

// Availability 是 pythonPlatformSandboxAvailable 的返回值。
type Availability struct {
	Available bool   `json:"available"`
	Kind      string `json:"kind"`
	Reason    string `json:"reason,omitempty"`
}

// PythonPlatformSandboxAvailable 是 pythonPlatformSandboxAvailable。
func PythonPlatformSandboxAvailable(platform string) Availability {
	if platform == "" {
		platform = NodePlatform()
	}
	switch platform {
	case "darwin":
		if fileExists("/usr/bin/sandbox-exec") {
			return Availability{Available: true, Kind: "sandbox-exec"}
		}
		return Availability{Kind: "fallback", Reason: "sandbox-exec unavailable"}
	case "linux":
		if FindOnPath("bwrap", platform) != nil {
			return Availability{Available: true, Kind: "bwrap"}
		}
		return Availability{Kind: "fallback", Reason: "bwrap not found on PATH"}
	}
	return Availability{Kind: "none", Reason: "windows-no-fs-jail"}
}
