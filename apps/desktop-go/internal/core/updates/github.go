package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ManifestURL：packaging/update-manifest.py 产出的 latest-go.json（D-B11-3）
const ManifestURL = "https://github.com/Cookieboty/nomi-ai/releases/latest/download/latest-go.json"

type manifestEntry struct {
	File   string `json:"file"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
	// Update：应用内原地替换用的包（mac 的 -mac.zip，2.2.0 起）。File / URL 仍是给人下载的安装包（dmg），
	// ≤ 2.1.2 的客户端只认它们，打开后让用户拖拽安装
	Update *manifestEntry `json:"update,omitempty"`
}

type manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Version       string `json:"version"`
	Tag           string `json:"tag"`
	ReleaseURL    string `json:"releaseUrl"`
	// ReleaseNotes：docs/releases/vX.Y.Z.md 原文（2.0.8 起）
	ReleaseNotes string                   `json:"releaseNotes"`
	Platforms    map[string]manifestEntry `json:"platforms"`
}

// GitHubUpdater：Updater 的实现——读 latest-go.json，下载本平台的包并校验 sha256，然后安装：
//   - macOS：应用在可写位置时下载 -mac.zip，校验签名后由分离的脚本在退出后把新 Nomi.app 换进原位置并重新打开；
//     否则（从 dmg 里运行、被 App Translocation 隔离、目录不可写）打开 dmg 让用户拖拽；
//   - Windows：静默运行 NSIS 安装器（/S --updated --force-run），装完自动启动；
//   - Linux：AppImage 原地替换后重启；deb 交给系统打开。
type GitHubUpdater struct {
	URL      string
	Version  func() string
	CacheDir string
	Client   *http.Client
	// Quit：退出应用（安装器接手）
	Quit func()
	// PlatformKey：nil = runtime.GOOS-GOARCH（Linux 非 AppImage 用 -deb）
	PlatformKey func() string
	// SwapTarget：可以原地替换的 .app 路径；nil = 按当前进程判断（只在 macOS 上可能为真）
	SwapTarget func() (bundle string, ok bool)
	// startSwap：测试替身；nil = startMacSwap
	startSwap func(zip, bundle string, relaunch bool) error

	mu           sync.Mutex
	ev           UpdaterEvents
	autoDownload bool
	log          Logger
	pending      *manifestEntry
	info         UpdateInfo
	downloaded   string
	// swapBundle：pending 是原地替换包时，要替换的 .app
	swapBundle string
	cancel     context.CancelFunc
}

func (g *GitHubUpdater) Configure(autoDownload, _, _ bool, log Logger) {
	g.mu.Lock()
	g.autoDownload, g.log = autoDownload, log
	g.mu.Unlock()
}

func (g *GitHubUpdater) On(ev UpdaterEvents) { g.mu.Lock(); g.ev = ev; g.mu.Unlock() }

func (g *GitHubUpdater) RemoveAllListeners() { g.mu.Lock(); g.ev = UpdaterEvents{}; g.mu.Unlock() }

func (g *GitHubUpdater) events() UpdaterEvents { g.mu.Lock(); defer g.mu.Unlock(); return g.ev }

func (g *GitHubUpdater) client() *http.Client {
	if g.Client != nil {
		return g.Client
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (g *GitHubUpdater) key() string {
	if g.PlatformKey != nil {
		return g.PlatformKey()
	}
	k := runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "linux" && os.Getenv("APPIMAGE") == "" {
		k += "-deb"
	}
	return k
}

func notFound(what string) error {
	return &CodedError{Code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", Msg: "Cannot find " + what + " in the latest release artifacts"}
}

func (g *GitHubUpdater) CheckForUpdates() (*CheckResult, error) {
	if ev := g.events(); ev.CheckingForUpdate != nil {
		ev.CheckingForUpdate()
	}
	url := g.URL
	if url == "" {
		url = ManifestURL
	}
	res, err := g.client().Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, notFound("latest-go.json")
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HttpError: %d %s", res.StatusCode, http.StatusText(res.StatusCode))
	}
	var m manifest
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&m); err != nil {
		return nil, fmt.Errorf("invalid latest-go.json: %w", err)
	}
	e, ok := m.Platforms[g.key()]
	if !ok || e.URL == "" {
		return nil, notFound(g.key() + " entry of latest-go.json")
	}
	swap := ""
	if e.Update != nil && e.Update.URL != "" {
		if b, ok := g.swapTarget(); ok {
			swap = b
			e = *e.Update
		}
	}
	info := UpdateInfo{Version: m.Version, ReleaseName: OptStr(m.Tag)}
	if m.ReleaseNotes != "" {
		info.ReleaseNotes = m.ReleaseNotes
	}
	if CompareVersions(m.Version, g.Version()) <= 0 {
		if ev := g.events(); ev.UpdateNotAvailable != nil {
			ev.UpdateNotAvailable()
		}
		return &CheckResult{Info: info}, nil
	}
	g.mu.Lock()
	g.pending, g.info, g.downloaded, g.swapBundle = &e, info, "", swap
	auto := g.autoDownload
	g.mu.Unlock()
	if ev := g.events(); ev.UpdateAvailable != nil {
		ev.UpdateAvailable(info)
	}
	r := &CheckResult{Info: info}
	if auto {
		ctx, cancel := context.WithCancel(context.Background())
		r.Cancel = cancel
		go func() {
			if err := g.download(ctx); err != nil && ctx.Err() == nil {
				if ev := g.events(); ev.Error != nil {
					ev.Error(err)
				}
			}
		}()
	}
	return r, nil
}

func (g *GitHubUpdater) DownloadUpdate() error {
	return g.download(context.Background())
}

func (g *GitHubUpdater) download(ctx context.Context) error {
	g.mu.Lock()
	e, info := g.pending, g.info
	if g.cancel != nil {
		g.cancel()
	}
	ctx, cancel := context.WithCancel(ctx)
	g.cancel = cancel
	g.mu.Unlock()
	defer cancel()
	if e == nil {
		return fmt.Errorf("Please check update first")
	}
	dir := g.CacheDir
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "nomi-updater")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dst := filepath.Join(dir, filepath.Base(e.File))
	if fileSHA(dst) == strings.ToLower(e.Sha256) {
		return g.done(dst, info)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.URL, nil)
	if err != nil {
		return err
	}
	res, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HttpError: %d %s", res.StatusCode, http.StatusText(res.StatusCode))
	}
	total := e.Size
	if total <= 0 {
		total = res.ContentLength
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	var n, sent int64 = 0, -1
	start, last := time.Now(), time.Time{}
	buf := make([]byte, 256<<10)
	for {
		k, rerr := res.Body.Read(buf)
		if k > 0 {
			if _, err := f.Write(buf[:k]); err != nil {
				f.Close()
				return err
			}
			h.Write(buf[:k])
			n += int64(k)
			if time.Since(last) > 500*time.Millisecond {
				last, sent = time.Now(), n
				g.progress(n, total, start)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(tmp)
			return rerr
		}
	}
	f.Close()
	if sent != n {
		g.progress(n, total, start)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != strings.ToLower(e.Sha256) {
		os.Remove(tmp)
		return fmt.Errorf("sha256 checksum mismatch, expected %s, got %s", e.Sha256, got)
	}
	if err := os.Rename(tmp, dst); err != nil {
		return err
	}
	return g.done(dst, info)
}

func (g *GitHubUpdater) progress(n, total int64, start time.Time) {
	ev := g.events()
	if ev.DownloadProgress == nil {
		return
	}
	pct := 0.0
	if total > 0 {
		pct = float64(n) / float64(total) * 100
	}
	bps := float64(n) / max(time.Since(start).Seconds(), 0.001)
	ev.DownloadProgress(ProgressInfo{Percent: pct, BytesPerSecond: float64(int64(bps)), Transferred: float64(n), Total: float64(total)})
}

func (g *GitHubUpdater) done(dst string, info UpdateInfo) error {
	g.mu.Lock()
	g.downloaded = dst
	g.mu.Unlock()
	if ev := g.events(); ev.UpdateDownloaded != nil {
		ev.UpdateDownloaded(info)
	}
	return nil
}

func fileSHA(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (g *GitHubUpdater) swapTarget() (string, bool) {
	if g.SwapTarget != nil {
		return g.SwapTarget()
	}
	if runtime.GOOS != "darwin" {
		return "", false
	}
	return macSwapTarget()
}

// QuitAndInstall：安装后退出（isForceRunAfter：装完重启新版本）
func (g *GitHubUpdater) QuitAndInstall(_ bool, runAfter bool) error {
	g.mu.Lock()
	p, bundle := g.downloaded, g.swapBundle
	g.mu.Unlock()
	if p == "" {
		return fmt.Errorf("No update downloaded")
	}
	var err error
	if bundle != "" {
		start := g.startSwap
		if start == nil {
			start = startMacSwap
		}
		err = start(p, bundle, runAfter)
	} else {
		err = installerCommand(p, runAfter)
	}
	if err != nil {
		return err
	}
	if g.Quit != nil {
		g.Quit()
	}
	return nil
}

func installerCommand(p string, runAfter bool) error {
	switch {
	case runtime.GOOS == "darwin":
		return exec.Command("open", p).Start()
	case runtime.GOOS == "windows":
		// 静默覆盖安装（安装器先结束正在运行的 Nomi、沿用原目录与卸载项）；--force-run：装完启动
		args := []string{"/S", "--updated"}
		if runAfter {
			args = append(args, "--force-run")
		}
		return exec.Command(p, args...).Start()
	case strings.HasSuffix(p, ".AppImage") && os.Getenv("APPIMAGE") != "":
		cur := os.Getenv("APPIMAGE")
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		tmp := cur + ".new"
		if err := os.WriteFile(tmp, b, 0o755); err != nil {
			return err
		}
		if err := os.Rename(tmp, cur); err != nil {
			return err
		}
		if runAfter {
			return exec.Command(cur).Start()
		}
		return nil
	default:
		return exec.Command("xdg-open", p).Start()
	}
}

// CompareVersions：semver 主次补丁比较（预发布段排在正式版前）
func CompareVersions(a, b string) int {
	pa, pb := splitVer(a), splitVer(b)
	for i := 0; i < 3; i++ {
		if pa.n[i] != pb.n[i] {
			if pa.n[i] < pb.n[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case pa.pre == pb.pre:
		return 0
	case pa.pre == "":
		return 1
	case pb.pre == "":
		return -1
	case pa.pre < pb.pre:
		return -1
	}
	return 1
}

type ver struct {
	n   [3]int
	pre string
}

func splitVer(s string) ver {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	var v ver
	if i := strings.IndexByte(s, '-'); i >= 0 {
		v.pre, s = s[i+1:], s[:i]
	}
	for i, p := range strings.SplitN(s, ".", 3) {
		v.n[i], _ = strconv.Atoi(p)
	}
	return v
}
