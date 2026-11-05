package chatassets

// localimage.go：对话里引用的本机图片 → data URL。编程助手 / CLI 常把二维码、截图存成本地文件
// （如飞书 CLI 设备授权的 auth-qr.png），回复里写的是本地路径，视图不能直接加载 file:。
// 只读用户认可的位置里的图片：工作区 / 授权过的文件夹（dirOk 判断）或系统临时目录；按内容嗅探确认是图片，限大小。

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// LocalImageMaxBytes：本机图片的大小上限
const LocalImageMaxBytes = 10 << 20

var localImageTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
}

// ErrLocalImageDenied：不在允许的位置 / 不是图片 / 太大
var ErrLocalImageDenied = errors.New("local image not allowed")

// LocalImagePath：Markdown 图片地址是不是本机文件（绝对路径、~/、file://）；是的话返回绝对路径
func LocalImagePath(src string) (string, bool) {
	s := strings.TrimSpace(src)
	if strings.HasPrefix(strings.ToLower(s), "file://") {
		u, err := url.Parse(s)
		if err != nil || (u.Host != "" && u.Host != "localhost") {
			return "", false
		}
		s = u.Path
		// Windows：file:///C:/x/y.png → C:/x/y.png
		if len(s) >= 3 && s[0] == '/' && s[2] == ':' {
			s = s[1:]
		}
		s = filepath.FromSlash(s)
	} else if strings.HasPrefix(s, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", false
		}
		s = filepath.Join(home, s[2:])
	}
	if !filepath.IsAbs(s) {
		return "", false
	}
	return filepath.Clean(s), true
}

// LocalImage：读本机图片，返回 data URL。dirOk(dir)：这个目录（或它的上级）是用户认可的工作区 / 授权文件夹
func LocalImage(src string, dirOk func(dir string) bool) (string, error) {
	p, ok := LocalImagePath(src)
	if !ok {
		return "", ErrLocalImageDenied
	}
	mime, ok := localImageTypes[strings.ToLower(filepath.Ext(p))]
	if !ok {
		return "", ErrLocalImageDenied
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Size() <= 0 || st.Size() > LocalImageMaxBytes || !localImageAllowed(filepath.Dir(real), dirOk) {
		return "", ErrLocalImageDenied
	}
	b, err := os.ReadFile(real)
	if err != nil {
		return "", err
	}
	// 按内容确认是图片（改了扩展名的文本 / 二进制不读出去）
	if !strings.HasPrefix(http.DetectContentType(b), "image/") {
		return "", ErrLocalImageDenied
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}

func localImageAllowed(dir string, dirOk func(string) bool) bool {
	for _, t := range tempRoots() {
		if within(t, dir) {
			return true
		}
	}
	if dirOk == nil {
		return false
	}
	for d, i := dir, 0; i < 64; d, i = filepath.Dir(d), i+1 {
		if dirOk(d) {
			return true
		}
		if parent := filepath.Dir(d); parent == d {
			break
		}
	}
	return false
}

func tempRoots() []string {
	out := []string{}
	for _, t := range []string{os.TempDir(), "/tmp"} {
		if r, err := filepath.EvalSymlinks(t); err == nil {
			out = append(out, r)
		}
	}
	return out
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && (rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)))
}
