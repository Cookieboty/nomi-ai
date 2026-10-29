//go:build windows

package launch

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// realpathNative = fs.realpathSync.native：libuv fs__realpath_handle——
// GetFinalPathNameByHandleW(VOLUME_NAME_DOS)，去掉 \\?\ 前缀，\\?\UNC\ → \\。
func realpathNative(p string) (string, error) {
	if p == "" {
		return "", syscall.ENOENT
	}
	u, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(u, 0, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, 512)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0 /* VOLUME_NAME_DOS */)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]uint16, n+1)
	}
	s := windows.UTF16ToString(buf)
	switch {
	case strings.HasPrefix(s, `\\?\UNC\`):
		s = `\\` + s[8:]
	case strings.HasPrefix(s, `\\?\`):
		s = s[4:]
	}
	return s, nil
}

// readlinkNode = fs.readlinkSync：Go 与 libuv 都去掉 \??\ 前缀；junction 的 substitute name 结尾 \
// 由 libuv 去掉（Windows CI golden 实测 Node 返回 `X:\dir` 不带结尾 \），Go os.Readlink 保留，这里同样去掉。
func readlinkNode(p string) (string, error) {
	to, err := os.Readlink(p)
	if err != nil {
		return to, err
	}
	if st, e := os.Lstat(p); e == nil && isJunction(st) && len(to) > 3 && strings.HasSuffix(to, `\`) {
		to = to[:len(to)-1]
	}
	return to, nil
}

// nodeStatMode = libuv fs__stat 在 Windows 上的 st_mode 权限位：只读属性 0444，否则 0666（目录也一样）。
func nodeStatMode(st os.FileInfo) float64 {
	if st.Mode().Perm()&0o200 == 0 {
		return 0o444
	}
	return 0o666
}

func symlinkNode(target, link, kind string) error {
	if kind == "junction" {
		// Node：junction 目标先相对 link 所在目录 resolve
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(link), target)
		}
		t, _ := filepath.Abs(target)
		return createJunction(t, link)
	}
	return os.Symlink(target, link)
}

const ioReparseTagMountPoint = 0xA0000003

// createJunction 复刻 libuv fs__create_junction：建空目录，写 IO_REPARSE_TAG_MOUNT_POINT；
// SubstituteName = `\??\` + target + `\`，PrintName = target + `\`（已以 \ 结尾则不再加）。失败删掉目录。
func createJunction(target, link string) error {
	target = strings.TrimPrefix(target, `\\?\`)
	if !strings.HasSuffix(target, `\`) {
		target += `\`
	}
	sub := utf16NoNul(`\??\` + target)
	prn := utf16NoNul(target)
	// MountPointReparseBuffer: SubstituteNameOffset/Length, PrintNameOffset/Length (u16 ×4)，PathBuffer
	pathBytes := (len(sub) + 1 + len(prn) + 1) * 2
	dataLen := 8 + pathBytes
	buf := make([]byte, 8+dataLen)
	le16 := func(o int, v int) { buf[o] = byte(v); buf[o+1] = byte(v >> 8) }
	le32 := func(o int, v uint32) { le16(o, int(v&0xffff)); le16(o+2, int(v>>16)) }
	le32(0, ioReparseTagMountPoint)
	le16(4, dataLen)
	le16(8, 0)
	le16(10, len(sub)*2)
	le16(12, (len(sub)+1)*2)
	le16(14, len(prn)*2)
	o := 16
	for _, c := range sub {
		le16(o, int(c))
		o += 2
	}
	o += 2
	for _, c := range prn {
		le16(o, int(c))
		o += 2
	}
	lp, err := windows.UTF16PtrFromString(link)
	if err != nil {
		return err
	}
	if err := windows.CreateDirectory(lp, nil); err != nil {
		return err
	}
	h, err := windows.CreateFile(lp, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		_ = windows.RemoveDirectory(lp)
		return err
	}
	var ret uint32
	err = windows.DeviceIoControl(h, windows.FSCTL_SET_REPARSE_POINT, &buf[0], uint32(len(buf)), nil, 0, &ret, nil)
	windows.CloseHandle(h)
	if err != nil {
		_ = windows.RemoveDirectory(lp)
		return err
	}
	return nil
}

func utf16NoNul(s string) []uint16 {
	u, _ := windows.UTF16FromString(s)
	return u[:len(u)-1]
}

// isJunction：Go ≥1.23 把 mount point（junction）报为 ModeIrregular；Node lstat 视其为 isSymbolicLink。
func isJunction(st os.FileInfo) bool { return st.Mode()&os.ModeIrregular != 0 }
