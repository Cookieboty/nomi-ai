package launch

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// mkdirp 复刻 Node fs.mkdirSync(p, {recursive:true}) 的错误语义（node_file.cc MKDirpSync）：
// 已存在但不是目录 → EEXIST；其他错误原样；Node 报错路径为调用参数 p（调用方拼 message）。
func mkdirp(p string, perm os.FileMode) error {
	err := os.Mkdir(p, perm)
	if err == nil {
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		parent := filepath.Dir(p)
		if parent == p {
			return err
		}
		if err := mkdirp(parent, perm); err != nil {
			return err
		}
		err = os.Mkdir(p, perm)
		if err == nil || !errors.Is(err, fs.ErrExist) {
			return err
		}
	}
	st, serr := os.Stat(p)
	if serr != nil {
		return serr
	}
	if !st.IsDir() {
		return syscall.EEXIST
	}
	return nil
}
