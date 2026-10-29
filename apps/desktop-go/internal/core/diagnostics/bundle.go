// Package diagnostics 对应 packages/core/src/diagnostics（DiagnosticsService.ts / bundle.ts）。
package diagnostics

import (
	"archive/zip"
	"bytes"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// BundleWindowMs = BUNDLE_WINDOW_MS
const BundleWindowMs = 24 * 60 * 60 * 1000

// MaxFileBytes = MAX_FILE_BYTES（变量以便测试缩小）
var MaxFileBytes int64 = 50 * 1024 * 1024

var (
	logFile   = regexp.MustCompile(`^(app(\.\d+)?\.log|cli-\d{4}-\d{2}-\d{2}\.jsonl)$`)
	traceFile = regexp.MustCompile(`\.json$`)
)

type BundleSource struct{ LogDir, TraceDir string }

// MetaKV：保持插入序（Object.entries）
type MetaKV struct {
	K string
	V string
}

type BundleOptions struct {
	Now      int64
	WindowMs int64
	Meta     []MetaKV
}

// Entry：zip 内一个文件（测试 / golden 用解压后的内容比较，压缩字节 fflate 与 archive/zip 不同，见 D-SH-1）
type Entry struct {
	Name string
	Data []byte
}

func pick(dir string, re *regexp.Regexp, since int64) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		n := e.Name()
		if !re.MatchString(n) {
			continue
		}
		st, err := os.Stat(filepath.Join(dir, n))
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		if float64(st.ModTime().UnixNano())/1e6 >= float64(since) {
			out = append(out, n)
		}
	}
	sort.Strings(out) // JS 默认排序按 UTF-16 码元；文件名受正则约束为 ASCII，等价
	return out
}

func readTail(file string) (string, error) {
	st, err := os.Stat(file)
	if err != nil {
		return "", err
	}
	if st.Size() <= MaxFileBytes {
		b, err := os.ReadFile(file)
		return charcontract.DecodeUTF8(b), err
	}
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, MaxFileBytes)
	n, _ := f.ReadAt(buf, st.Size()-MaxFileBytes)
	return fmt.Sprintf("[truncated: kept last %d bytes]\n%s", MaxFileBytes, charcontract.DecodeUTF8(buf[:n])), nil
}

// BuildEntries：buildDiagnosticsBundle 的条目（zip 前）与收进去的文件
func BuildEntries(src BundleSource, o BundleOptions) ([]Entry, []string) {
	now := o.Now
	if now == 0 {
		now = time.Now().UnixMilli()
	}
	win := o.WindowMs
	if win == 0 {
		win = BundleWindowMs
	}
	since := now - win
	var entries []Entry
	files := []string{}
	add := func(dir, name, prefix string) {
		s, err := readTail(filepath.Join(dir, name))
		if err != nil {
			return
		}
		key := prefix + "/" + name
		entries = append(entries, Entry{key, []byte(server.RedactText(s, nil))})
		files = append(files, key)
	}
	for _, n := range pick(src.LogDir, logFile, since) {
		add(src.LogDir, n, "logs")
	}
	for _, n := range pick(src.TraceDir, traceFile, since) {
		add(src.TraceDir, n, "gateway-trace")
	}
	iso, _ := util.ToISOString(float64(now))
	var b bytes.Buffer
	b.WriteString("Nomi diagnostics bundle\n")
	b.WriteString("created: " + iso + "\n")
	fmt.Fprintf(&b, "window: last %d h\n", int64(math.Floor(float64(now-since)/3600_000+0.5)))
	for _, kv := range o.Meta {
		b.WriteString(kv.K + ": " + kv.V + "\n")
	}
	b.WriteString("\nContains coding-agent input/output and gateway request/response bodies (conversation\n" +
		"content). API keys, tokens and known secret formats are redacted; environment variables\n" +
		"are never recorded.\n")
	entries = append(entries, Entry{"README.txt", b.Bytes()})
	return entries, files
}

// BuildDiagnosticsBundle：zip 字节与文件列表（deflate 级别 6，同 fflate level 6）
func BuildDiagnosticsBundle(src BundleSource, o BundleOptions) ([]byte, []string, error) {
	entries, files := BuildEntries(src, o)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: e.Name, Method: zip.Deflate, Modified: time.UnixMilli(o.Now)})
		if err != nil {
			return nil, nil, err
		}
		if _, err := w.Write(e.Data); err != nil {
			return nil, nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, nil, err
	}
	return buf.Bytes(), files, nil
}
