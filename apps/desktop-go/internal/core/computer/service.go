package computer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultTimeout = 20 * time.Second
	// keepSnapshots：ref 缓存保留最近几次 snapshot（更早的 ref 当作未知，让模型重新 snapshot）
	keepSnapshots = 8
	// binRetry：没找到 agent-desktop 时多久再找一次（用户可能刚装上）
	binRetry = 30 * time.Second
)

// RefInfo：一个 ref 来自哪个应用 / 窗口的哪次 snapshot，元素是什么（安全判定与 STALE_REF 重定位用）
type RefInfo struct {
	App string
	// BundleID：读界面时这个应用的 bundle id（之后的动作核对身份没变）
	BundleID   string
	WindowID   string
	SnapshotID string
	Role       string
	Name       string
}

// Options：Service 的依赖
type Options struct {
	// Resolve：找 agent-desktop 可执行文件（"" = 没有）
	Resolve func() string
	// Exec：测试注入；nil 用 os/exec
	Exec ExecFn
	// Self：是不是 Nomi 自己（不能操作自己的窗口，否则模型能点掉自己的确认卡片）
	Self func(name, bundleID string) bool
	// ShotsDir：截图保存目录
	ShotsDir string
	// Getenv：测试注入；nil 用 os.Getenv
	Getenv func(string) string
	// SettingsPath：设置文件（"" = 不持久化）
	SettingsPath string
}

// Service：agent-desktop 执行器 + ref 缓存
type Service struct {
	resolve  func() string
	exec     ExecFn
	self     func(name, bundleID string) bool
	shotsDir string
	getenv   func(string) string

	binMu  sync.Mutex
	bin    string
	binAt  time.Time
	headed sync.Mutex

	// 设置页读版本 / 权限：短缓存 + 单飞，避免 Windows 上控制台抢焦点造成的紧循环
	hostMu       sync.Mutex
	hostGen      uint64
	hostRes      hostProbeResult
	hostFly      *hostProbeFlight
	hostProbeTTL time.Duration
	mu           sync.Mutex
	refs         map[string]RefInfo
	snaps        []string // snapshot id，旧 → 新
	snapApp      map[string]string
	apps         appsCache

	inst *installer
	act  *activity

	// 设置（userData/desktop/computer.json）
	settingsPath string
	setMu        sync.Mutex
	settings     Settings
	setListeners []func(Settings)
}

func New(o Options) *Service {
	s := &Service{resolve: o.Resolve, exec: o.Exec, self: o.Self, shotsDir: o.ShotsDir, getenv: o.Getenv,
		refs: map[string]RefInfo{}, snapApp: map[string]string{}, settingsPath: o.SettingsPath, act: newActivity(),
		settings: Settings{CliEnabled: true}}
	s.loadSettings()
	if s.exec == nil {
		s.exec = defaultExec
	}
	if s.getenv == nil {
		s.getenv = os.Getenv
	}
	return s
}

// Bin：agent-desktop 路径（缓存；没找到时每 30 秒再找一次）
func (s *Service) Bin() string {
	if s == nil || s.resolve == nil {
		return ""
	}
	s.binMu.Lock()
	defer s.binMu.Unlock()
	if s.bin != "" {
		if _, err := os.Stat(s.bin); err == nil {
			return s.bin
		}
		s.bin = ""
	} else if !s.binAt.IsZero() && time.Since(s.binAt) < binRetry {
		return ""
	}
	s.binAt = time.Now()
	s.bin = s.resolve()
	return s.bin
}

// Available：本机能不能用（工具的 Available）
func (s *Service) Available() bool { return s.Bin() != "" }

// Wayland：Linux Wayland 会话下全局截图和输入注入受限，只支持无障碍树。
// 与 Wails 一致：XDG_SESSION_TYPE=wayland，或设置了 WAYLAND_DISPLAY（有的会话不写 XDG_SESSION_TYPE）。
func (s *Service) Wayland() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(s.getenv("XDG_SESSION_TYPE")), "wayland") {
		return true
	}
	return strings.TrimSpace(s.getenv("WAYLAND_DISPLAY")) != ""
}

// Blocked：这个应用能不能碰
func (s *Service) Blocked(name, bundleID string) string {
	if r := BlockedApp(name, bundleID, s.self); r != "" {
		return r
	}
	return s.userBlocked(name, bundleID)
}

// Status：平台、权限、可用能力；guide 为 true 时在 macOS 上打开系统设置的授权引导
func (s *Service) Status(ctx context.Context, guide bool) (map[string]any, error) {
	data, err := s.call(ctx, 0, "", "status")
	if err != nil {
		return nil, err
	}
	var st map[string]any
	_ = json.Unmarshal(data, &st)
	out := map[string]any{"executor": "agent-desktop", "platform": runtime.GOOS}
	for _, k := range []string{"version", "permissions", "supported_surfaces"} {
		if v, ok := st[k]; ok {
			out[k] = v
		}
	}
	caps := []string{"snapshot", "click", "type", "set_value", "press", "scroll", "wait"}
	if s.Wayland() {
		out["note"] = "Wayland 会话：只支持无障碍树操作，截图和坐标点击不可用"
	} else {
		caps = append(caps, "screenshot", "click_xy")
	}
	out["capabilities"] = caps
	if guide {
		if runtime.GOOS != "darwin" {
			out["guide"] = "not_supported"
		} else if g, err := s.call(ctx, 0, "", "permissions", "--guide"); err == nil {
			var gd map[string]any
			_ = json.Unmarshal(g, &gd)
			out["guide"] = gd["guide"]
		} else {
			out["guide"] = "error: " + err.Error()
		}
	}
	return out, nil
}

// App：list-apps 的一项
type App struct {
	Name       string `json:"name"`
	BundleID   string `json:"bundle_id,omitempty"`
	PID        int    `json:"pid,omitempty"`
	Foreground bool   `json:"foreground"`
	Blocked    string `json:"blocked,omitempty"`
}

// ListApps：正在运行的 GUI 应用（标出不能操作的）
func (s *Service) ListApps(ctx context.Context) ([]App, error) {
	data, err := s.call(ctx, 0, "", "list-apps")
	if err != nil {
		return nil, err
	}
	var d struct {
		Apps []struct {
			Name         string `json:"name"`
			BundleID     string `json:"bundle_id"`
			PID          int    `json:"pid"`
			Presentation string `json:"presentation"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, errf("bad_output", "list-apps 输出无法解析")
	}
	out := make([]App, 0, len(d.Apps))
	for _, a := range d.Apps {
		out = append(out, App{Name: a.Name, BundleID: a.BundleID, PID: a.PID, Foreground: a.Presentation != "background",
			Blocked: s.Blocked(a.Name, a.BundleID)})
	}
	return out, nil
}

// SnapshotOpts：snapshot 参数
type SnapshotOpts struct {
	App      string
	WindowID string
	Root     string // 只看某个 ref 下面的子树
	Skeleton bool   // 元素很多的应用先看骨架
}

// Snapshot：snapshot 结果；Outline 是给模型看的缩进大纲（每行：角色 "名字" =值 [ref]）
type Snapshot struct {
	ID       string
	App      string
	WindowID string
	RefCount int
	Complete bool
	Outline  string
}

type node struct {
	Role        string          `json:"role"`
	Name        string          `json:"name"`
	Value       json.RawMessage `json:"value"`
	Description string          `json:"description"`
	Ref         string          `json:"ref_id"`
	States      []string        `json:"states"`
	Children    []node          `json:"children"`
}

// Snapshot：读应用的无障碍树（-i --compact：只列可交互元素），记下 ref
func (s *Service) Snapshot(ctx context.Context, o SnapshotOpts) (Snapshot, error) {
	app := o.App
	if o.Root != "" {
		info, ok := s.Ref(o.Root)
		if !ok {
			return Snapshot{}, unknownRef(o.Root)
		}
		app = info.App
		if o.WindowID == "" {
			o.WindowID = info.WindowID
		}
	}
	if app == "" {
		return Snapshot{}, errf("INVALID_ARGS", "需要 app（应用名，来自 computer_list_apps）")
	}
	if err := s.CheckApp(ctx, app); err != nil {
		return Snapshot{}, err
	}
	args := []string{"snapshot", "-i", "--compact"}
	if o.Root != "" {
		args = append(args, "--root", o.Root)
	} else {
		args = append(args, "--app", app)
	}
	if o.WindowID != "" && o.Root == "" {
		args = append(args, "--window-id", o.WindowID)
	}
	if o.Skeleton {
		args = append(args, "--skeleton")
	}
	data, err := s.call(ctx, 0, "", args...)
	if err != nil {
		return Snapshot{}, err
	}
	var d struct {
		App        string          `json:"app"`
		SnapshotID string          `json:"snapshot_id"`
		RefCount   int             `json:"ref_count"`
		Complete   *bool           `json:"complete"`
		Tree       *node           `json:"tree"`
		Window     json.RawMessage `json:"window"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return Snapshot{}, errf("bad_output", "snapshot 输出无法解析")
	}
	if d.App == "" {
		d.App = app
	}
	// agent-desktop 按名字模糊匹配应用：实际拿到的应用也要过一遍黑名单（名字 + bundle id）
	bundle, err := s.identify(ctx, d.App)
	if err != nil {
		return Snapshot{}, err
	}
	win := o.WindowID
	if len(d.Window) > 0 {
		var w struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(d.Window, &w) == nil && w.ID != nil {
			win = fmt.Sprint(w.ID)
		}
	}
	snap := Snapshot{ID: d.SnapshotID, App: d.App, WindowID: win, RefCount: d.RefCount, Complete: d.Complete == nil || *d.Complete}
	var b strings.Builder
	refs := map[string]RefInfo{}
	redact := s.Settings().Redact
	if d.Tree != nil {
		walk(*d.Tree, 0, &b, redact, func(n node) {
			refs[n.Ref] = RefInfo{App: d.App, BundleID: bundle, WindowID: win, SnapshotID: d.SnapshotID, Role: n.Role, Name: n.Name}
		})
	}
	snap.Outline = b.String()
	s.remember(d.SnapshotID, d.App, refs)
	return snap, nil
}

// walk：写缩进大纲；没有名字、值和 ref 的容器不单独占一行
func walk(n node, depth int, b *strings.Builder, redact bool, onRef func(node)) {
	val := ""
	if len(n.Value) > 0 && string(n.Value) != "null" {
		var sv string
		if json.Unmarshal(n.Value, &sv) != nil {
			sv = string(n.Value)
		}
		val = sv
	}
	if secretRole(n.Role) && val != "" {
		val = "***"
	} else if redact && val != "" && inputRole(n.Role) {
		val = fmt.Sprintf("（已隐去 %d 字）", len([]rune(val)))
	}
	show := n.Name != "" || val != "" || n.Ref != ""
	if show {
		b.WriteString(strings.Repeat("  ", depth))
		b.WriteString(n.Role)
		if n.Name != "" {
			b.WriteString(" " + strconv.Quote(clip(n.Name, 200)))
		}
		if val != "" {
			b.WriteString(" =" + strconv.Quote(clip(val, 200)))
		}
		if len(n.States) > 0 {
			b.WriteString(" (" + strings.Join(n.States, ",") + ")")
		}
		if n.Ref != "" {
			b.WriteString(" [" + n.Ref + "]")
			onRef(n)
		}
		b.WriteByte('\n')
		depth++
	}
	for _, c := range n.Children {
		walk(c, depth, b, redact, onRef)
	}
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func (s *Service) remember(id, app string, refs map[string]RefInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" {
		return
	}
	if _, ok := s.snapApp[id]; !ok {
		s.snaps = append(s.snaps, id)
	}
	s.snapApp[id] = app
	for r, info := range refs {
		s.refs[r] = info
	}
	for len(s.snaps) > keepSnapshots {
		old := s.snaps[0]
		s.snaps = s.snaps[1:]
		delete(s.snapApp, old)
		for r, info := range s.refs {
			if info.SnapshotID == old {
				delete(s.refs, r)
			}
		}
	}
}

// Ref：查 ref 的来源（只认最近几次 snapshot 里出现过的 ref）
func (s *Service) Ref(ref string) (RefInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, ok := s.refs[ref]
	return info, ok
}

func unknownRef(ref string) *Error {
	return errf("unknown_ref", "不认识 ref %s：先调用 computer_snapshot，用它返回的 ref（形如 @s8f3k2p9:e8）", ref)
}

// Action：作用在 ref 上的动作
type Action struct {
	Kind      string // click / type / set_value / scroll
	Ref       string
	Text      string // type / set_value 的文本（走 stdin，不进进程参数）
	Direction string // scroll
	Amount    int    // scroll
}

// ActResult：动作结果；Ref 是实际用到的 ref（STALE_REF 重定位后会变），Retried 表示重定位过
type ActResult struct {
	Ref     string
	Retried bool
	Data    json.RawMessage
}

// Act：执行动作；ref 过期（STALE_REF）时重新 snapshot，按角色 + 名字找到唯一的同一元素后重试一次
func (s *Service) Act(ctx context.Context, a Action) (ActResult, error) {
	info, ok := s.Ref(a.Ref)
	if !ok {
		return ActResult{}, unknownRef(a.Ref)
	}
	if err := s.CheckRef(ctx, info); err != nil {
		return ActResult{}, err
	}
	data, err := s.actOnce(ctx, a)
	if CodeOf(err) != "STALE_REF" || ctx.Err() != nil {
		return ActResult{Ref: a.Ref, Data: data}, err
	}
	var e *Error
	if errors.As(err, &e) && e.Retry == "unsafe" {
		return ActResult{Ref: a.Ref}, err
	}
	nref, rerr := s.relocate(ctx, info)
	if rerr != nil || nref == "" {
		return ActResult{Ref: a.Ref}, err
	}
	b := a
	b.Ref = nref
	data, err = s.actOnce(ctx, b)
	return ActResult{Ref: nref, Retried: true, Data: data}, err
}

func (s *Service) actOnce(ctx context.Context, a Action) (json.RawMessage, error) {
	switch a.Kind {
	case "click":
		return s.call(ctx, 0, "", "click", a.Ref)
	case "type":
		// 文字一律走 stdin，不进进程参数（隔离模式下 sandbox exec 若不转发 stdin，输入会失败而不是把文字摆在参数里）
		return s.call(ctx, 0, a.Text, "type", a.Ref, "--stdin")
	case "set_value":
		if a.Text == "" {
			return s.call(ctx, 0, "", "clear", a.Ref)
		}
		return s.call(ctx, 0, a.Text, "set-value", a.Ref, "--stdin")
	case "scroll":
		dir := a.Direction
		if dir == "" {
			dir = "down"
		}
		amt := a.Amount
		if amt <= 0 {
			amt = 3
		}
		return s.call(ctx, 0, "", "scroll", a.Ref, "--direction", dir, "--amount", strconv.Itoa(amt))
	}
	return nil, errf("INVALID_ARGS", "未知动作 %s", a.Kind)
}

// relocate：重新 snapshot 同一应用 / 窗口，找角色和名字都相同的唯一元素
func (s *Service) relocate(ctx context.Context, info RefInfo) (string, error) {
	if info.Name == "" {
		return "", nil
	}
	snap, err := s.Snapshot(ctx, SnapshotOpts{App: info.App, WindowID: info.WindowID})
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	found := ""
	for r, x := range s.refs {
		if x.SnapshotID != snap.ID || x.Role != info.Role || x.Name != info.Name {
			continue
		}
		if found != "" {
			return "", nil // 不唯一，不猜
		}
		found = r
	}
	return found, nil
}

// Press：向指定应用发送组合键（总是带 --app，不往当前焦点窗口里乱发）
func (s *Service) Press(ctx context.Context, app, combo string) (json.RawMessage, error) {
	if err := s.CheckApp(ctx, app); err != nil {
		return nil, err
	}
	return s.call(ctx, 0, "", "press", combo, "--app", app)
}

// WaitOpts：等元素状态 / 文字 / 窗口出现
type WaitOpts struct {
	Ref, Predicate string
	Text, Window   string
	App            string
	TimeoutMs      int
}

func (s *Service) Wait(ctx context.Context, o WaitOpts) (json.RawMessage, error) {
	if o.TimeoutMs <= 0 {
		o.TimeoutMs = 10_000
	}
	var args []string
	switch {
	case o.Ref != "":
		info, ok := s.Ref(o.Ref)
		if !ok {
			return nil, unknownRef(o.Ref)
		}
		if err := s.CheckRef(ctx, info); err != nil {
			return nil, err
		}
		p := o.Predicate
		if p == "" {
			p = "exists"
		}
		args = []string{"wait", "--element", o.Ref, "--predicate", p}
	case o.Text != "" || o.Window != "":
		if o.App == "" {
			return nil, errf("INVALID_ARGS", "等文字或窗口时需要 app")
		}
		if err := s.CheckApp(ctx, o.App); err != nil {
			return nil, err
		}
		if o.Text != "" {
			args = []string{"wait", "--text", o.Text, "--app", o.App}
		} else {
			args = []string{"wait", "--window", o.Window, "--app", o.App}
		}
	default:
		return nil, errf("INVALID_ARGS", "需要 ref、text 或 window 之一")
	}
	args = append(args, "--timeout", strconv.Itoa(o.TimeoutMs))
	return s.call(ctx, time.Duration(o.TimeoutMs)*time.Millisecond+5*time.Second, "", args...)
}

// Shot：截图结果（只存在本机，路径交给模型 / 用户）
type Shot struct {
	Path          string  `json:"path"`
	Width         float64 `json:"width"`
	Height        float64 `json:"height"`
	ScaleFactor   float64 `json:"scale_factor,omitempty"`
	CapturedAppOf string  `json:"app,omitempty"`
	// PNG：图片内容（视觉兜底用，不序列化）
	PNG []byte `json:"-"`
}

// Screenshot：截应用窗口（app 为空时截主屏）。图片以 base64 回传再由这里写盘：隔离模式下命令在虚拟机里执行，
// 那边的路径这边读不到
func (s *Service) Screenshot(ctx context.Context, app string) (Shot, error) {
	if s.Wayland() && s.Settings().Sandbox == "" {
		return Shot{}, errf("PLATFORM_NOT_SUPPORTED", "Wayland 会话不支持截图")
	}
	// 指定应用：按身份（名字 + bundle id）检查；整个屏幕：屏幕上有禁用应用的可见窗口就不截
	if app != "" {
		if err := s.CheckApp(ctx, app); err != nil {
			return Shot{}, err
		}
	} else if err := s.CheckScreen(ctx); err != nil {
		return Shot{}, err
	}
	if s.shotsDir == "" {
		return Shot{}, errf("unavailable", "没有截图保存目录")
	}
	args := []string{"screenshot"}
	if app != "" {
		args = append(args, "--app", app)
	} else {
		args = append(args, "--screen", "0")
	}
	data, err := s.call(ctx, 30*time.Second, "", args...)
	if err != nil {
		return Shot{}, err
	}
	var d struct {
		Data        string  `json:"data"`
		Width       float64 `json:"width"`
		Height      float64 `json:"height"`
		ScaleFactor float64 `json:"scale_factor"`
	}
	_ = json.Unmarshal(data, &d)
	png, err := base64.StdEncoding.DecodeString(d.Data)
	if err != nil || len(png) == 0 {
		return Shot{}, errf("bad_output", "截图没有返回图片")
	}
	if err := os.MkdirAll(s.shotsDir, 0o700); err != nil {
		return Shot{}, err
	}
	p := filepath.Join(s.shotsDir, "shot-"+time.Now().Format("20060102-150405.000")+".png")
	if err := os.WriteFile(p, png, 0o600); err != nil {
		return Shot{}, err
	}
	if d.ScaleFactor <= 0 {
		d.ScaleFactor = 1
	}
	return Shot{Path: p, Width: d.Width, Height: d.Height, ScaleFactor: d.ScaleFactor, CapturedAppOf: app, PNG: png}, nil
}

// Bounds：屏幕坐标（点）里的矩形
type Bounds struct{ X, Y, Width, Height float64 }

// WindowBounds：应用的主窗口在屏幕上的位置（有焦点的优先，否则最大的可见窗口）
func (s *Service) WindowBounds(ctx context.Context, app string) (Bounds, error) {
	data, err := s.call(ctx, 0, "", "list-windows", "--app", app)
	if err != nil {
		return Bounds{}, err
	}
	var ws []struct {
		Bounds    Bounds `json:"bounds"`
		Focused   bool   `json:"is_focused"`
		Visible   *bool  `json:"visible"`
		Minimized bool   `json:"minimized"`
	}
	if json.Unmarshal(data, &ws) != nil {
		return Bounds{}, errf("bad_output", "list-windows 输出无法解析")
	}
	best, found := Bounds{}, false
	for _, w := range ws {
		if w.Minimized || (w.Visible != nil && !*w.Visible) || w.Bounds.Width <= 0 {
			continue
		}
		if w.Focused {
			return w.Bounds, nil
		}
		if !found || w.Bounds.Width*w.Bounds.Height > best.Width*best.Height {
			best, found = w.Bounds, true
		}
	}
	if !found {
		return Bounds{}, errf("WINDOW_NOT_FOUND", "「%s」没有可见的窗口", app)
	}
	return best, nil
}

// AppsAt：屏幕坐标落在哪些应用的可见窗口上（窗口叠放次序拿不到：凡是盖住这一点的都算）
func (s *Service) AppsAt(ctx context.Context, x, y int) ([]string, error) {
	data, err := s.call(ctx, 0, "", "list-windows")
	if err != nil {
		return nil, err
	}
	var ws []struct {
		App       string `json:"app_name"`
		Bounds    Bounds `json:"bounds"`
		Visible   *bool  `json:"visible"`
		Minimized bool   `json:"minimized"`
	}
	if json.Unmarshal(data, &ws) != nil {
		return nil, errf("bad_output", "list-windows 输出无法解析")
	}
	seen := map[string]bool{}
	out := []string{}
	px, py := float64(x), float64(y)
	for _, w := range ws {
		if w.Minimized || (w.Visible != nil && !*w.Visible) {
			continue
		}
		b := w.Bounds
		if px < b.X || py < b.Y || px >= b.X+b.Width || py >= b.Y+b.Height || seen[w.App] {
			continue
		}
		seen[w.App] = true
		out = append(out, w.App)
	}
	return out, nil
}

// ClickXY：按屏幕坐标点击（物理输入，--headed；同一时间只允许一个）
func (s *Service) ClickXY(ctx context.Context, x, y int) (json.RawMessage, error) {
	if s.Wayland() {
		return nil, errf("PLATFORM_NOT_SUPPORTED", "Wayland 会话不支持坐标点击")
	}
	s.headed.Lock()
	defer s.headed.Unlock()
	return s.call(ctx, 0, "", "--headed", "mouse-click", "--xy", strconv.Itoa(x)+","+strconv.Itoa(y))
}

// inputRole：可编辑的文本元素（打码时隐去它们的值）
func inputRole(role string) bool {
	r := strings.ToLower(role)
	for _, k := range []string{"text", "edit", "entry", "combo", "search"} {
		if strings.Contains(r, k) {
			return true
		}
	}
	return false
}
