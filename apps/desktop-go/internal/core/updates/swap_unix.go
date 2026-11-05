//go:build !windows

package updates

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

// macSwapTarget：当前进程所在的 .app 能不能原地替换。不能的情况：不在 .app 里（开发态）、从挂载的 dmg 里运行、
// 被 App Translocation 隔离（从「下载」里直接打开的隔离副本，路径随机且只读）、所在目录或 .app 不可写
func macSwapTarget() (string, bool) {
	exe, err := os.Executable()
	if err != nil {
		return "", false
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return swapTargetFor(exe)
}

func swapTargetFor(exe string) (string, bool) {
	// <bundle>.app/Contents/MacOS/<exe>
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if !strings.HasSuffix(bundle, ".app") || filepath.Base(filepath.Dir(exe)) != "MacOS" {
		return "", false
	}
	if strings.HasPrefix(bundle, "/Volumes/") || strings.Contains(bundle, "/AppTranslocation/") {
		return "", false
	}
	if !writableDir(filepath.Dir(bundle)) || !writableDir(bundle) {
		return "", false
	}
	return bundle, true
}

// writableDir：能在 d 里改名 / 删除（替换 .app 要求它的父目录与它自己都可写）
func writableDir(d string) bool {
	return syscall.Access(d, 0x2 /* W_OK */) == nil
}

// swapScript：等原进程退出（最多 60 秒），把旧 .app 挪开、新 .app 换进原位置；换失败就挪回旧的。
// 参数：$1 原进程 pid，$2 原 .app，$3 新 .app，$4 暂存目录（与 .app 同一目录，rename 不跨卷），
// $5 是否重新打开（1 / 0），$6 打开命令
const swapScript = `pid=$1 old=$2 new=$3 stage=$4 relaunch=$5 opener=$6
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 600 ] && exit 1
  sleep 0.1
done
if mv "$old" "$stage/previous.app"; then
  if mv "$new" "$old"; then
    rm -rf "$stage"
  else
    mv "$stage/previous.app" "$old"
  fi
fi
[ "$relaunch" = 1 ] && $opener "$old"
exit 0
`

// stagePrefix：暂存目录的前缀（放在 .app 所在目录，隐藏）
const stagePrefix = ".nomi-update-"

// startMacSwap：解压 zip 到 .app 旁边的暂存目录，校验新 .app，然后起一个分离的脚本在本进程退出后替换并重新打开。
// 返回后调用方退出应用。
func startMacSwap(zip, bundle string, relaunch bool) error {
	return startSwapWith(zip, bundle, relaunch, swapEnv{
		extract: func(zip, dst string) error { return run("ditto", "-x", "-k", zip, dst) },
		verify:  verifyMacApp,
		opener:  "open",
		pid:     os.Getpid(),
	})
}

type swapEnv struct {
	extract func(zip, dst string) error
	verify  func(newApp, curApp string) error
	opener  string
	pid     int
}

func startSwapWith(zip, bundle string, relaunch bool, env swapEnv) error {
	parent := filepath.Dir(bundle)
	// 上次失败留下的暂存目录
	if old, _ := filepath.Glob(filepath.Join(parent, stagePrefix+"*")); len(old) > 0 {
		for _, d := range old {
			os.RemoveAll(d)
		}
	}
	stage, err := os.MkdirTemp(parent, stagePrefix)
	if err != nil {
		return err
	}
	fail := func(err error) error {
		os.RemoveAll(stage)
		return err
	}
	if err := env.extract(zip, stage); err != nil {
		return fail(fmt.Errorf("extract update: %w", err))
	}
	apps, _ := filepath.Glob(filepath.Join(stage, "*.app"))
	if len(apps) != 1 {
		return fail(fmt.Errorf("update archive must contain one .app, found %d", len(apps)))
	}
	if err := env.verify(apps[0], bundle); err != nil {
		return fail(err)
	}
	script := filepath.Join(stage, "swap.sh")
	if err := os.WriteFile(script, []byte(swapScript), 0o700); err != nil {
		return fail(err)
	}
	rl := "0"
	if relaunch {
		rl = "1"
	}
	cmd := exec.Command("/bin/sh", script, strconv.Itoa(env.pid), bundle, apps[0], stage, rl, env.opener)
	// 自己一个进程组：应用退出时不随之结束
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fail(err)
	}
	go cmd.Wait()
	return nil
}

// verifyMacApp：新 .app 的签名有效，Bundle ID 与当前一致；当前应用有 Team ID 时新包必须是同一个 Team
func verifyMacApp(newApp, curApp string) error {
	if err := run("codesign", "--verify", "--deep", "--strict", newApp); err != nil {
		return fmt.Errorf("update signature is invalid: %w", err)
	}
	if a, b := bundleID(newApp), bundleID(curApp); a == "" || a != b {
		return fmt.Errorf("update bundle id %q does not match %q", a, b)
	}
	if cur := teamID(curApp); cur != "" && teamID(newApp) != cur {
		return fmt.Errorf("update is signed by a different team (want %s)", cur)
	}
	return nil
}

func bundleID(app string) string {
	out, err := exec.Command("/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", filepath.Join(app, "Contents", "Info.plist")).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

var teamRE = regexp.MustCompile(`(?m)^TeamIdentifier=(.+)$`)

// teamID：codesign -dv 的 TeamIdentifier；未签名 / ad-hoc（"not set"）为空
func teamID(app string) string {
	var buf bytes.Buffer
	cmd := exec.Command("codesign", "-dv", "--verbose=2", app)
	cmd.Stderr = &buf
	if cmd.Run() != nil {
		return ""
	}
	m := teamRE.FindStringSubmatch(buf.String())
	if m == nil || strings.TrimSpace(m[1]) == "not set" {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}
