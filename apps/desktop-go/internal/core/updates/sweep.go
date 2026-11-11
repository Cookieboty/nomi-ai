package updates

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// semverish：安装包文件名里的版本。不认「Nomi-notes.dmg」这种不是版本的名字。
var semverish = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)

// installerVersion 认出更新缓存里的安装包，并取出版本。
// .part 是没下完的半截文件。不是这些安装包的文件返回 ok=false，调用方必须留着。
func installerVersion(name string) (ver string, part bool, ok bool) {
	part = strings.HasSuffix(name, ".part")
	if part {
		name = strings.TrimSuffix(name, ".part")
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".dmg", ".zip", ".exe", ".appimage", ".deb":
	default:
		return "", false, false
	}
	stem := name[:len(name)-len(ext)]
	switch {
	case ext == ".deb":
		// nomi_<version>_amd64
		if !strings.HasPrefix(stem, "nomi_") {
			return "", false, false
		}
		rest := strings.TrimPrefix(stem, "nomi_")
		i := strings.LastIndex(rest, "_")
		if i <= 0 {
			return "", false, false
		}
		ver = rest[:i]
	case strings.HasPrefix(stem, "Nomi-Setup-"):
		ver = strings.TrimPrefix(stem, "Nomi-Setup-")
	case strings.HasPrefix(stem, "Nomi-"):
		ver = trimInstallerSuffix(strings.TrimPrefix(stem, "Nomi-"))
	default:
		return "", false, false
	}
	if !semverish.MatchString(ver) {
		return "", false, false
	}
	return ver, part, true
}

func trimInstallerSuffix(s string) string {
	changed := true
	for changed {
		changed = false
		for _, suf := range []string{"-mac", "-arm64", "-amd64"} {
			if strings.HasSuffix(s, suf) {
				s = strings.TrimSuffix(s, suf)
				changed = true
			}
		}
	}
	return s
}

// SweepObsoleteInstallers 删掉 dir 里已经不需要的更新安装包。
// 版本不比 current 新的（含刚装好的这一版）删掉；还没装的更新版本留着，下次不用重下。
// 没下完的 .part 一律删掉：下次下载会重新建文件。其它文件、子目录、符号链接不动。
// keep 里的文件（正在运行的程序，如直接从缓存目录打开的 AppImage）不删。
// dir 不存在时什么都不做。
func SweepObsoleteInstallers(dir, current string, keep ...string) []string {
	if dir == "" || current == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var kept []os.FileInfo
	for _, k := range keep {
		if k == "" {
			continue
		}
		if info, err := os.Stat(k); err == nil {
			kept = append(kept, info)
		}
	}
	var removed []string
	for _, e := range entries {
		name := e.Name()
		ver, part, ok := installerVersion(name)
		if !ok {
			continue
		}
		if !part && CompareVersions(ver, current) > 0 {
			continue
		}
		p := filepath.Join(dir, name)
		if !pathInside(dir, p) {
			continue
		}
		info, err := os.Lstat(p)
		if err != nil || !info.Mode().IsRegular() || sameAsAny(info, kept) {
			continue
		}
		if err := os.Remove(p); err != nil {
			continue
		}
		removed = append(removed, name)
	}
	return removed
}

func sameAsAny(info os.FileInfo, kept []os.FileInfo) bool {
	for _, k := range kept {
		if os.SameFile(info, k) {
			return true
		}
	}
	return false
}

// runningFiles：正在运行的程序文件。AppImage 运行时 os.Executable 是挂载里的 exe，
// 真正的包在 $APPIMAGE。
func runningFiles() []string {
	out := []string{os.Getenv("APPIMAGE")}
	if exe, err := os.Executable(); err == nil {
		out = append(out, exe)
	}
	return out
}

func pathInside(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (g *GitHubUpdater) cacheDir() string {
	if g.CacheDir != "" {
		return g.CacheDir
	}
	return filepath.Join(os.TempDir(), "nomi-updater")
}

// SweepObsoleteInstallers 清掉这个更新器缓存里用过的安装包。打包版启动时调用，此时还没有正在进行的下载。
func (g *GitHubUpdater) SweepObsoleteInstallers() {
	ver := ""
	if g.Version != nil {
		ver = g.Version()
	}
	removed := SweepObsoleteInstallers(g.cacheDir(), ver, runningFiles()...)
	if len(removed) == 0 || g.log == nil {
		return
	}
	g.log.Info("removed obsolete update packages", "files", strings.Join(removed, ", "))
}
