package shared

import (
	"io/fs"
	"os"
	"path/filepath"
)

// Readdir mirrors readdir()：OS 原序（不排序，同 fs.promises.readdir），失败 = 空。
func Readdir(d string) []fs.DirEntry {
	f, err := os.Open(d)
	if err != nil {
		return nil
	}
	defer f.Close()
	es, err := f.ReadDir(-1)
	if err != nil && len(es) == 0 {
		return nil
	}
	return es
}

// IsDirent* = Dirent.isDirectory()/isFile()（符号链接两者皆假）。
func IsDirentDir(e fs.DirEntry) bool  { return e.Type()&fs.ModeType == fs.ModeDir }
func IsDirentFile(e fs.DirEntry) bool { return e.Type()&fs.ModeType == 0 }

// MtimeMs = Stats.mtimeMs。
func MtimeMs(st fs.FileInfo) float64 {
	t := st.ModTime()
	return float64(t.Unix())*1000 + float64(t.Nanosecond())/1e6
}

type FileCand struct{ Path, DirID string }

// StatAll mirrors statAll（stat 跟随符号链接；失败的跳过）。
func StatAll(files []FileCand) []HistoryFileRef {
	out := []HistoryFileRef{}
	for _, f := range files {
		st, err := os.Stat(f.Path)
		if err != nil {
			continue
		}
		out = append(out, HistoryFileRef{Path: f.Path, Mtime: MtimeMs(st), Size: float64(st.Size()), DirID: f.DirID})
	}
	return out
}

// WalkFiles mirrors walkFiles。
func WalkFiles(root string, depth int, match func(string) bool, dirID bool) []FileCand {
	files := []FileCand{}
	var walk func(d string, left int)
	walk = func(d string, left int) {
		if left < 0 {
			return
		}
		for _, e := range Readdir(d) {
			p := filepath.Join(d, e.Name())
			if IsDirentDir(e) {
				walk(p, left-1)
			} else if IsDirentFile(e) && match(e.Name()) {
				c := FileCand{Path: p}
				if dirID {
					c.DirID = filepath.Base(filepath.Dir(p))
				}
				files = append(files, c)
			}
		}
	}
	walk(root, depth)
	return files
}
