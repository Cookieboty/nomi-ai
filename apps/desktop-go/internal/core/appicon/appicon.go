// Package appicon = packages/host-electron/src/core/appIcon.ts：应用图标变体（sunset 默认 / cream / ink）的运行时切换。
//
// 能换的（立即）：所有窗口图标（含之后新建的窗口）、Windows 任务栏 AppUserModel 图标（RelaunchIconResource）、
// 托盘（非 macOS）、macOS Dock。真正改窗口 / Dock / 托盘的是 Target（wailsshell 实现，原生部分见 appicon_*.go）。
package appicon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

var Variants = []string{"ink", "cream", "sunset"}

const Default = "sunset"

// AppUserModelID 与 electron-builder.yml 的 appId 一致
const AppUserModelID = "com.cookieboty.nomi"

// Sanitize = sanitizeVariant（只认精确的三个字符串）
func Sanitize(v any) string {
	if s, ok := v.(string); ok {
		for _, x := range Variants {
			if x == s {
				return s
			}
		}
	}
	return Default
}

// IconFile = iconFile：assets/app-icons/<variant>/<part>.png
func IconFile(assets, v, part string) string {
	return filepath.Join(assets, "app-icons", v, part+".png")
}

// IcoFile = icoFile：Windows 多尺寸 .ico
func IcoFile(assets, v string) string { return filepath.Join(assets, "app-icons", v, "app.ico") }

// Window 是单个窗口（= IconTarget）
type Window interface {
	IsDestroyed() bool
	SetIcon(pngPath string)
	SetAppDetails(appID, iconPath string, index int)
}

// Target：宿主图标能力（= app.dock / BrowserWindow.getAllWindows / 托盘监听）
type Target interface {
	SetDockIcon(pngPath string)
	Windows() []Window
	SetTrayIcon(pngPath string)
}

type State struct {
	Variant  string            `json:"variant"`
	Platform string            `json:"platform"`
	Previews map[string]string `json:"previews"`
}

type Service struct {
	mu       sync.Mutex
	file     string
	assets   string // = assetsDir()（读图）
	disk     string // = diskAssetsDir()（Windows Shell 读 .ico 的磁盘目录）
	platform string
	current  string
	target   Target
	// Preview = nativeImage.createFromPath(p).resize({width}).toDataURL()
	Preview func(path string, width int) string
}

// Platform 返回 Node process.platform 的取值
func Platform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func New(assets, disk string, t Target) *Service {
	return &Service{assets: assets, disk: disk, platform: Platform(), current: Default, target: t, Preview: PNGPreview}
}

// SetPlatform 仅供 golden 回放
func (s *Service) SetPlatform(p string) { s.platform = p }

func (s *Service) Current() string { s.mu.Lock(); defer s.mu.Unlock(); return s.current }

// IconPath = iconImage(part) 的文件
func (s *Service) IconPath(part string) string { return IconFile(s.assets, s.Current(), part) }

func (s *Service) currentIco() string {
	f := IcoFile(s.disk, s.current)
	if _, err := os.Stat(f); err == nil {
		return f
	}
	return ""
}

// ApplyToWindow = applyToWindow（新建窗口时由宿主调用，= browser-window-created）
func (s *Service) ApplyToWindow(w Window) {
	s.mu.Lock()
	img, ico, plat := IconFile(s.assets, s.current, "window"), s.currentIco(), s.platform
	s.mu.Unlock()
	applyToWindow(w, plat, img, ico)
}

func applyToWindow(w Window, platform, img, ico string) {
	if w.IsDestroyed() || platform == "darwin" {
		return
	}
	w.SetIcon(img)
	if platform == "win32" && ico != "" {
		w.SetAppDetails(AppUserModelID, ico, 0)
	}
}

func (s *Service) apply() {
	if s.target == nil {
		return
	}
	if s.platform == "darwin" {
		s.target.SetDockIcon(IconFile(s.assets, s.current, "dock"))
		return
	}
	img, ico := IconFile(s.assets, s.current, "window"), s.currentIco()
	for _, w := range s.target.Windows() {
		applyToWindow(w, s.platform, img, ico)
	}
	s.target.SetTrayIcon(IconFile(s.assets, s.current, "tray"))
}

// Init = initAppIcon
func (s *Service) Init(configFile string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.file = configFile
	s.current = Default
	if b, err := os.ReadFile(configFile); err == nil {
		var v struct {
			Variant any `json:"variant"`
		}
		var anyv any
		if json.Unmarshal(b, &anyv) == nil {
			if m, ok := anyv.(map[string]any); ok {
				v.Variant = m["variant"]
				s.current = Sanitize(v.Variant)
			}
		}
	}
	s.apply()
}

// Set = setIconVariant
func (s *Service) Set(v any) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = Sanitize(v)
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err == nil {
		b, _ := json.Marshal(map[string]string{"variant": s.current})
		_ = os.WriteFile(s.file, b, 0o644)
	}
	s.apply()
	return s.current
}

// Get = appIconState
func (s *Service) Get() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	part := "window"
	if s.platform == "darwin" {
		part = "dock"
	}
	pv := make(map[string]string, len(Variants))
	for _, v := range Variants {
		pv[v] = s.Preview(IconFile(s.assets, v, part), 96)
	}
	return State{Variant: s.current, Platform: s.platform, Previews: pv}
}
