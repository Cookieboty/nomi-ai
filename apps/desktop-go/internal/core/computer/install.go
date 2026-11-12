package computer

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// agent-desktop 的安装、版本与更新检查。只装适配过的大版本（SupportedMajor），
// 新的大版本只提示、不自动装：JSON 契约可能变了。

const (
	// Package：npm 包名
	Package = "agent-desktop"
	// SupportedMajor：适配过的大版本
	SupportedMajor = 1
	// FallbackVersion：查不到最新版本时装的版本（适配时验证过的那一版）
	FallbackVersion = "1.2.0"
	latestTTL       = 6 * time.Hour
	installTimeout  = 10 * time.Minute
)

var reVersion = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)

// InstallDeps：安装要用的本机信息与运行器（wiring 里接 core/cli 的现成函数）
type InstallDeps struct {
	Npm        func() string // npm 可执行文件（"" = 没装 Node.js / npm）
	NpmPrefix  func() string // npm 全局目录
	UserPrefix func() string // 全局目录不可写时装到这里（--prefix）
	CanWrite   func(dir string) bool
	// Run：执行命令（PATH 含登录 shell 的 PATH），返回合并后的输出与退出码
	Run func(ctx context.Context, argv []string) (output string, code int, err error)
	// Installed：装好后把 bin 目录记下来（之后按它找 agent-desktop）
	Installed func(prefix string)
}

type versionCache struct {
	at             time.Time
	latest, newest string // latest：适配的大版本里最新的；newest：所有版本里最新的
}

type installer struct {
	d          InstallDeps
	mu         sync.Mutex
	installing bool
	cache      versionCache
	// fetching：后台正在查 npm（同一时间只查一次）
	fetching bool
}

// SetInstaller：接上安装依赖（不接时 Install 返回 unavailable）
func (s *Service) SetInstaller(d InstallDeps) { s.inst = &installer{d: d} }

func parseVer(v string) (int, int, int, bool) {
	m := reVersion.FindStringSubmatch(strings.TrimPrefix(strings.TrimSpace(v), "v"))
	if m == nil {
		return 0, 0, 0, false
	}
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	c, _ := strconv.Atoi(m[3])
	return a, b, c, true
}

// CompareVersions：a < b → -1，a == b → 0，a > b → 1（不合法的版本当作最小）
func CompareVersions(a, b string) int {
	a1, a2, a3, okA := parseVer(a)
	b1, b2, b3, okB := parseVer(b)
	switch {
	case !okA && !okB:
		return 0
	case !okA:
		return -1
	case !okB:
		return 1
	}
	for _, d := range [][2]int{{a1, b1}, {a2, b2}, {a3, b3}} {
		if d[0] != d[1] {
			if d[0] < d[1] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// pickLatest：从 npm 的版本列表里挑出适配的大版本里最新的、所有正式版里最新的（跳过预发布）
func pickLatest(versions []string) (latest, newest string) {
	for _, v := range versions {
		major, _, _, ok := parseVer(v)
		if !ok {
			continue
		}
		if newest == "" || CompareVersions(v, newest) > 0 {
			newest = v
		}
		if major == SupportedMajor && (latest == "" || CompareVersions(v, latest) > 0) {
			latest = v
		}
	}
	return latest, newest
}

// InstallArgv：安装 / 更新命令；版本必须是适配的大版本里的正式版
func InstallArgv(npm, version, prefix string) ([]string, error) {
	major, _, _, ok := parseVer(version)
	if !ok || major != SupportedMajor || npm == "" {
		return nil, errf("INVALID_ARGS", "不能安装 agent-desktop %s", version)
	}
	argv := []string{npm, "install", "-g", Package + "@" + version}
	if prefix != "" {
		argv = append(argv, "--prefix", prefix)
	}
	return argv, nil
}

// fetchVersions：npm view agent-desktop versions --json（6 小时缓存，refresh 强制重查）
func (in *installer) fetchVersions(ctx context.Context, refresh bool) versionCache {
	in.mu.Lock()
	c := in.cache
	in.mu.Unlock()
	if !refresh && !c.at.IsZero() && time.Since(c.at) < latestTTL {
		return c
	}
	npm := in.d.Npm()
	if npm == "" || in.d.Run == nil {
		return c
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, code, err := in.d.Run(cctx, []string{npm, "view", Package, "versions", "--json"})
	if err != nil || code != 0 {
		return c
	}
	var list []string
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &list) != nil {
		var one string
		if json.Unmarshal([]byte(strings.TrimSpace(out)), &one) != nil {
			return c
		}
		list = []string{one}
	}
	c.latest, c.newest = pickLatest(list)
	c.at = time.Now()
	in.mu.Lock()
	in.cache = c
	in.mu.Unlock()
	return c
}

// InstalledVersion：agent-desktop version 的 data.version（"" = 没装或读不出）
func (s *Service) InstalledVersion(ctx context.Context) string {
	data, err := s.callHost(ctx, 10*time.Second, "version")
	if err != nil {
		return ""
	}
	var d struct {
		Version string `json:"version"`
	}
	_ = json.Unmarshal(data, &d)
	return d.Version
}

// VersionInfo：本机版本与更新
type VersionInfo struct {
	Installed       bool   `json:"installed"`
	Path            string `json:"path"`
	Version         string `json:"version"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"updateAvailable"`
	// NewerMajor：有更新的大版本，Nomi 还没适配（只提示）
	NewerMajor     string `json:"newerMajor"`
	SupportedMajor int    `json:"supportedMajor"`
	NpmAvailable   bool   `json:"npmAvailable"`
	Installing     bool   `json:"installing"`
	// Unsupported：本机装的是没适配的大版本
	Unsupported bool `json:"unsupported"`
}

// Versions：本机版本 + npm 上的最新版本（refresh = 「检查更新」）
func (s *Service) Versions(ctx context.Context, refresh bool) VersionInfo {
	bin := s.Bin()
	ver := ""
	if bin != "" {
		ver = s.InstalledVersion(ctx)
	}
	return s.versionInfo(ctx, refresh, bin, ver)
}

// versionInfo：在已经读到的本机版本上补 npm 的最新版本。设置页走 hostProbe，避免每次状态都再启一次进程。
func (s *Service) versionInfo(ctx context.Context, refresh bool, bin, ver string) VersionInfo {
	v := VersionInfo{Installed: bin != "", Path: bin, Version: ver, SupportedMajor: SupportedMajor}
	if ver != "" {
		if major, _, _, ok := parseVer(ver); ok && major != SupportedMajor {
			v.Unsupported = true
		}
	}
	if s.inst == nil {
		return v
	}
	v.NpmAvailable = s.inst.d.Npm() != ""
	s.inst.mu.Lock()
	v.Installing = s.inst.installing
	s.inst.mu.Unlock()
	// 打开设置页不等网络（npm view 要几秒，慢网络时更久）：用缓存，过期就在后台查，查完通知页面刷新；
	// 只有「检查更新」（refresh）当场等结果
	var c versionCache
	if refresh {
		c = s.inst.fetchVersions(ctx, true)
	} else {
		c = s.inst.cached()
		if c.at.IsZero() || time.Since(c.at) >= latestTTL {
			s.refreshInBackground()
		}
	}
	v.Latest = c.latest
	if c.newest != "" && c.newest != c.latest {
		if major, _, _, ok := parseVer(c.newest); ok && major > SupportedMajor {
			v.NewerMajor = c.newest
		}
	}
	if v.Installed && v.Latest != "" && v.Version != "" && CompareVersions(v.Version, v.Latest) < 0 {
		v.UpdateAvailable = true
	}
	// 装了更新的大版本：退回适配的版本
	if v.Unsupported && v.Latest != "" {
		v.UpdateAvailable = true
	}
	return v
}

// InstallResult：安装 / 更新结果
type InstallResult struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	Path    string `json:"path"`
	Log     string `json:"log"`
	// NeedsUserScope：npm 全局目录不可写，改装到用户目录（UserPrefix）才行
	NeedsUserScope bool   `json:"needsUserScope"`
	UserPrefix     string `json:"userPrefix,omitempty"`
}

// Install：安装或更新到适配的大版本里的最新版。scope = global | user
func (s *Service) Install(ctx context.Context, scope string) (InstallResult, error) {
	in := s.inst
	if in == nil {
		return InstallResult{}, errf("unavailable", "当前环境不能安装 agent-desktop")
	}
	in.mu.Lock()
	if in.installing {
		in.mu.Unlock()
		return InstallResult{}, errf("busy", "正在安装 agent-desktop")
	}
	in.installing = true
	in.mu.Unlock()
	defer func() {
		in.mu.Lock()
		in.installing = false
		in.mu.Unlock()
	}()
	npm := in.d.Npm()
	if npm == "" {
		return InstallResult{Log: "没有找到 npm：先安装 Node.js 18 或更新版本（https://nodejs.org）"}, nil
	}
	prefix := ""
	if scope == "user" {
		prefix = in.d.UserPrefix()
	} else if g := in.d.NpmPrefix(); g != "" && in.d.CanWrite != nil && !in.d.CanWrite(g) {
		up := in.d.UserPrefix()
		return InstallResult{NeedsUserScope: true, UserPrefix: up,
			Log: fmt.Sprintf("npm 全局目录 %s 不可写，可以改装到用户目录 %s", g, up)}, nil
	}
	ver := in.fetchVersions(ctx, true).latest
	if ver == "" {
		ver = FallbackVersion
	}
	argv, err := InstallArgv(npm, ver, prefix)
	if err != nil {
		return InstallResult{}, err
	}
	cctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	out, code, runErr := in.d.Run(cctx, argv)
	log := "$ " + strings.Join(argv, " ") + "\n" + out
	if r := []rune(log); len(r) > 8000 {
		log = string(r[len(r)-8000:])
	}
	if runErr != nil || code != 0 {
		if runErr != nil {
			log += "\n" + runErr.Error()
		}
		return InstallResult{Log: log}, nil
	}
	if in.d.Installed != nil {
		p := prefix
		if p == "" {
			p = in.d.NpmPrefix()
		}
		if p != "" {
			in.d.Installed(p)
		}
	}
	s.ResetBin()
	bin := s.Bin()
	r := InstallResult{OK: bin != "", Path: bin, Log: log}
	if bin != "" {
		r.Version = s.InstalledVersion(ctx)
	} else {
		r.Log += "\n安装命令执行完了，但没有找到 agent-desktop 可执行文件"
	}
	return r, nil
}

// ResetBin：忘掉缓存的路径，下次重新找（装好 / 卸载后）。版本缓存一起丢掉。
func (s *Service) ResetBin() {
	s.binMu.Lock()
	s.bin, s.binAt = "", time.Time{}
	s.binMu.Unlock()
	s.invalidateHostProbe()
}

// OpenGuide：macOS 打开辅助功能授权引导；其它平台返回 not_supported
func (s *Service) OpenGuide(ctx context.Context) (string, error) {
	data, err := s.callHost(ctx, 0, "permissions", "--guide")
	if err != nil {
		if CodeOf(err) == "PLATFORM_NOT_SUPPORTED" {
			return "not_supported", nil
		}
		return "", err
	}
	var d struct {
		Guide string `json:"guide"`
	}
	_ = json.Unmarshal(data, &d)
	return d.Guide, nil
}

// Permissions：系统权限状态（accessibility / screen_recording：granted / denied / not_required / unknown）
func (s *Service) Permissions(ctx context.Context) map[string]string {
	data, err := s.callHost(ctx, 10*time.Second, "permissions")
	out := map[string]string{}
	if err != nil {
		return out
	}
	var d map[string]struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(data, &d)
	for k, v := range d {
		out[k] = v.State
	}
	return out
}

func (in *installer) cached() versionCache {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.cache
}

// refreshInBackground：后台查一次最新版本，查到了通知 OnStateChange
func (s *Service) refreshInBackground() {
	in := s.inst
	in.mu.Lock()
	if in.fetching {
		in.mu.Unlock()
		return
	}
	in.fetching = true
	in.mu.Unlock()
	go func() {
		c := in.fetchVersions(context.Background(), true)
		in.mu.Lock()
		in.fetching = false
		in.mu.Unlock()
		if !c.at.IsZero() {
			s.stateChanged()
		}
	}()
}
