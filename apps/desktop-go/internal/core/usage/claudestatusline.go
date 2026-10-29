package usage

// 对应 claudeStatusline.ts：Claude Code 订阅额度——官方 statusline 输入里的 `rate_limits`（five_hour / seven_day）。
//
// 做法（用户在面板里主动开启，可随时关闭恢复原配置）：
//  1. 在 userData/usage 下生成一个很小的 sh 脚本：把 stdin 的 JSON 落成本地快照文件（0600），
//     再把原来的 statusLine 命令（如果有）原样串接执行；
//  2. 在 ~/.claude/settings.json 里把 statusLine 指到这个脚本（先备份，原 statusLine 记下来用于恢复）。
// 不读取 / 不转发任何凭据，不访问网络，不调用未文档接口。

import (
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
)

const (
	StatuslineSnapshotFile = "claude-statusline.json"
	StatuslineScriptFile   = "claude-statusline.sh"
	statuslineOrigFile     = "claude-statusline.orig.json"
	statuslineOrigCmdFile  = "claude-statusline.orig.cmd"
	statuslineMark         = "nomi-usage-statusline"
)

// slNum = num：typeof number && Number.isFinite。
func slNum(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || !finite(f) {
		return 0, false
	}
	return f, true
}

// slToMs = toMs：resets_at 官方是 Unix 秒；也容忍毫秒 / ISO 字符串。
func slToMs(v any) (float64, bool) {
	if s, ok := v.(string); ok {
		t, ok := reminders.DateParse(s)
		if !ok || !finite(t) {
			return 0, false
		}
		return t, true
	}
	n, ok := slNum(v)
	if !ok || n <= 0 {
		return 0, false
	}
	if n < 1e11 {
		return n * 1000, true
	}
	return n, true
}

// ParseStatuslineRateLimits：没有 rate_limits（API 用户 / 首次响应前）返回 nil，不编造。
func ParseStatuslineRateLimits(raw string, updatedAt float64) *QuotaReading {
	o, err := util.ParseString(raw)
	if err != nil {
		return nil
	}
	obj, _ := o.(*util.Obj)
	if obj == nil {
		return nil
	}
	rlv := obj.Get("rate_limits")
	if !util.Truthy(rlv) {
		return nil
	}
	rl, isObj := rlv.(*util.Obj)
	if !isObj {
		if _, isArr := rlv.([]any); !isArr {
			return nil // typeof !== 'object'
		}
	}
	windows := []QuotaWindow{}
	for _, km := range []struct {
		key     string
		minutes float64
	}{{"five_hour", 300}, {"seven_day", 10080}} {
		var w *util.Obj
		if rl != nil {
			w, _ = rl.Get(km.key).(*util.Obj)
		}
		var pv, rv any
		if w != nil {
			pv, rv = w.Get("used_percentage"), w.Get("resets_at")
		}
		pct, ok := slNum(pv)
		if !ok || pct < 0 {
			continue
		}
		m := km.minutes
		qw := QuotaWindow{ID: km.key, UsedPercent: math.Min(100, pct), WindowMinutes: &m}
		if resetAt, ok := slToMs(rv); ok && resetAt != 0 {
			qw.ResetAt = f64p(resetAt)
		}
		windows = append(windows, qw)
	}
	if len(windows) == 0 {
		return nil
	}
	return &QuotaReading{Windows: windows, UpdatedAt: updatedAt}
}

// MtimeMs = fs.Stats.mtimeMs（秒 * 1e3 + 纳秒 / 1e6）。
func MtimeMs(st os.FileInfo) float64 {
	t := st.ModTime()
	return float64(float64(t.Unix())*1e3) + float64(t.Nanosecond())/1e6
}

// ReadStatuslineSnapshot：读快照文件（只提取 rate_limits，其余字段一概忽略）。
func ReadStatuslineSnapshot(root string) *QuotaReading {
	f := filepath.Join(root, StatuslineSnapshotFile)
	st, err := os.Stat(f)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(f)
	if err != nil {
		return nil
	}
	return ParseStatuslineRateLimits(string(b), MtimeMs(st))
}

// shq：POSIX sh 单引号转义。
func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// BuildStatuslineScript = buildScript：落快照 + 串接原命令（原命令在单独的文本文件里，用 sh -c 执行）。
func BuildStatuslineScript(root string) string {
	return `#!/bin/sh
# ` + statuslineMark + `: saves Claude Code's statusline JSON next to Nomi's usage data (local only, 0600),
# then runs your previous statusLine command, if any. Undo it in Nomi: Settings > Usage & cost.
SNAP=` + shq(filepath.Join(root, StatuslineSnapshotFile)) + `
ORIGCMD=` + shq(filepath.Join(root, statuslineOrigCmdFile)) + `
umask 077
tmp="$SNAP.$$"
cat > "$tmp" && mv "$tmp" "$SNAP" || exit 0
if [ -s "$ORIGCMD" ]; then
  sh -c "$(cat "$ORIGCMD")" < "$SNAP"
fi
exit 0
`
}

// HookStatus = interface HookStatus。键顺序：supported, hasSnapshot, enabled, hadOwnStatusLine, problem。
type HookStatus struct {
	Supported        bool   `json:"supported"`
	HasSnapshot      bool   `json:"hasSnapshot"`
	Enabled          bool   `json:"enabled"`
	HadOwnStatusLine bool   `json:"hadOwnStatusLine"`
	Problem          string `json:"problem,omitempty"` // 'invalid-settings' | 'unsupported-statusline'
}

func (h HookStatus) ToObj() *util.Obj {
	o := util.NewObj("supported", h.Supported, "hasSnapshot", h.HasSnapshot, "enabled", h.Enabled, "hadOwnStatusLine", h.HadOwnStatusLine)
	if h.Problem != "" {
		o.Set("problem", h.Problem)
	}
	return o
}

func (h HookStatus) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(h.ToObj())), nil }

// HookDeps = interface HookDeps。Home "" = os.homedir()；Env nil = process.env；Platform "" = process.platform；Now nil = Date.now。
type HookDeps struct {
	Root     string
	Home     string
	Env      *util.Obj
	Platform string
	Now      func() float64
}

func (d HookDeps) home() string {
	if d.Home != "" {
		return d.Home
	}
	return Homedir()
}

// settingsFile：尊重 CLAUDE_CONFIG_DIR。
func statuslineSettingsFile(home string, env *util.Obj) string {
	if env == nil {
		env = ProcessEnv()
	}
	return filepath.Join(ClaudeConfigDir(home, env), "settings.json")
}

type slSettings struct {
	ok  bool
	raw *string
	obj *util.Obj
}

func readStatuslineSettings(file string) slSettings {
	b, err := os.ReadFile(file)
	if err != nil {
		return slSettings{ok: true, obj: util.NewObj()}
	}
	raw := string(b)
	if util.JSTrim(raw) == "" {
		return slSettings{ok: true, raw: &raw, obj: util.NewObj()}
	}
	if o, err := util.ParseString(raw); err == nil {
		if obj, ok := o.(*util.Obj); ok && obj != nil {
			return slSettings{ok: true, raw: &raw, obj: obj}
		}
	}
	return slSettings{ok: false}
}

func jsThrow(msg string) error { return jsrt.JSThrow{Name: "Error", Message: msg} }

// writeStatuslineSettings：原子写 settings.json，并保持原文件权限位（writePrivateFileAtomic 默认收紧到 0600）。
func writeStatuslineSettings(file, text string) error {
	var mode os.FileMode
	had := false
	if st, err := os.Stat(file); err == nil {
		mode, had = st.Mode().Perm(), true
	}
	if err := utils.WritePrivateFileAtomicNode(file, []byte(text)); err != nil {
		return err
	}
	if had {
		_ = os.Chmod(file, mode)
	}
	return nil
}

// isObject = v && typeof v === 'object'（含数组）。
func isObject(v any) bool {
	switch x := v.(type) {
	case *util.Obj:
		return x != nil
	case []any:
		return true
	}
	return false
}

func objGet(v any, k string) any {
	if o, ok := v.(*util.Obj); ok && o != nil {
		return o.Get(k)
	}
	return nil
}

func isOurs(sl any, root string) bool {
	c, ok := objGet(sl, "command").(string)
	return ok && strings.Contains(c, filepath.Join(root, StatuslineScriptFile))
}

func HookStatusOf(d HookDeps) HookStatus {
	home := d.home()
	platform := d.Platform
	if platform == "" {
		platform = Platform()
	}
	s := readStatuslineSettings(statuslineSettingsFile(home, d.Env))
	hasSnapshot := ExistsSync(filepath.Join(d.Root, StatuslineSnapshotFile))
	base := HookStatus{Supported: platform != "win32", HasSnapshot: hasSnapshot}
	if !s.ok {
		base.Problem = "invalid-settings"
		return base
	}
	sl := s.obj.Get("statusLine")
	enabled := isOurs(sl, d.Root)
	var hadOwn bool
	if enabled {
		hadOwn = ExistsSync(filepath.Join(d.Root, statuslineOrigFile))
	} else {
		hadOwn = isObject(sl)
	}
	base.Enabled = enabled
	base.HadOwnStatusLine = hadOwn
	if !enabled && isObject(sl) && objGet(sl, "type") != "command" {
		base.Problem = "unsupported-statusline"
	}
	return base
}

func writeNodeFile(file, data string, mode os.FileMode) error {
	if err := os.WriteFile(file, []byte(data), mode); err != nil {
		return jsThrow(nodefs.Message(err, "open", file))
	}
	return nil
}

func mkdirpNode(dir string) error {
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return jsThrow(nodefs.Message(err, "mkdir", dir))
	}
	return nil
}

func writePrivateNode(file, data string) error {
	if err := writeNodeFile(file, data, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	return nil
}

// EnableHook：写脚本、备份并改写 settings.json 的 statusLine。出问题返回 Error（同 Node 抛错），且不会改动 settings.json。
func EnableHook(d HookDeps) (HookStatus, error) {
	home := d.home()
	st := HookStatusOf(d)
	if !st.Supported {
		return HookStatus{}, jsThrow("unsupported-platform")
	}
	if st.Problem != "" {
		return HookStatus{}, jsThrow(st.Problem)
	}
	if st.Enabled {
		return st, nil
	}
	file := statuslineSettingsFile(home, d.Env)
	s := readStatuslineSettings(file)
	if !s.ok {
		return HookStatus{}, jsThrow("invalid-settings")
	}
	if err := mkdirpNode(d.Root); err != nil {
		return HookStatus{}, err
	}
	prev := s.obj.Get("statusLine")
	script := filepath.Join(d.Root, StatuslineScriptFile)
	// 1) 脚本与原命令
	if err := writeNodeFile(script, BuildStatuslineScript(d.Root), 0o700); err != nil {
		return HookStatus{}, err
	}
	if err := os.Chmod(script, 0o700); err != nil {
		return HookStatus{}, jsThrow(nodefs.Message(err, "chmod", script))
	}
	if isObject(prev) {
		if err := writePrivateNode(filepath.Join(d.Root, statuslineOrigFile), util.Stringify(prev)); err != nil {
			return HookStatus{}, err
		}
		cmd, _ := objGet(prev, "command").(string)
		if err := writePrivateNode(filepath.Join(d.Root, statuslineOrigCmdFile), cmd); err != nil {
			return HookStatus{}, err
		}
	} else {
		_ = nodefs.RmForce(filepath.Join(d.Root, statuslineOrigFile))
		_ = nodefs.RmForce(filepath.Join(d.Root, statuslineOrigCmdFile))
	}
	// 2) 备份 settings.json，再改写 statusLine（保留其它所有字段；沿用原来的 padding / refreshInterval）
	if s.raw != nil {
		bdir := filepath.Join(d.Root, "backups")
		if err := mkdirpNode(bdir); err != nil {
			return HookStatus{}, err
		}
		var now float64
		if d.Now != nil {
			now = d.Now()
		} else {
			now = nowMs()
		}
		if err := writePrivateNode(filepath.Join(bdir, "claude-settings."+util.FormatNumber(now)+".json"), *s.raw); err != nil {
			return HookStatus{}, err
		}
	}
	next := util.NewObj("type", "command", "command", shq(script))
	if p, ok := objGet(prev, "padding").(float64); ok {
		next.Set("padding", p)
	}
	if p, ok := objGet(prev, "refreshInterval").(float64); ok {
		next.Set("refreshInterval", p)
	}
	if err := mkdirpNode(filepath.Dir(file)); err != nil {
		return HookStatus{}, err
	}
	out := s.obj.Clone()
	out.Set("statusLine", next)
	if err := writeStatuslineSettings(file, util.StringifyIndent(out, "  ")+"\n"); err != nil {
		return HookStatus{}, err
	}
	return HookStatusOf(d), nil
}

// DisableHook：恢复原 statusLine（没有就删掉这个键），清理脚本 / 快照。当前不是我们的配置则只清理自己的文件。
func DisableHook(d HookDeps) (HookStatus, error) {
	home := d.home()
	file := statuslineSettingsFile(home, d.Env)
	s := readStatuslineSettings(file)
	if s.ok && isOurs(s.obj.Get("statusLine"), d.Root) {
		var orig any
		if b, err := os.ReadFile(filepath.Join(d.Root, statuslineOrigFile)); err == nil {
			if v, err := util.ParseString(string(b)); err == nil {
				orig = v
			}
		}
		next := s.obj.Clone()
		if isObject(orig) {
			next.Set("statusLine", orig)
		} else {
			next.Delete("statusLine")
		}
		if err := writeStatuslineSettings(file, util.StringifyIndent(next, "  ")+"\n"); err != nil {
			return HookStatus{}, err
		}
	}
	for _, f := range []string{StatuslineScriptFile, StatuslineSnapshotFile, statuslineOrigFile, statuslineOrigCmdFile} {
		_ = nodefs.RmForce(filepath.Join(d.Root, f))
	}
	return HookStatusOf(d), nil
}
