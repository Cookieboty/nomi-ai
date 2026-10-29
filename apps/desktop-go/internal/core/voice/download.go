package voice

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Progress = DownloadProgress
type Progress struct {
	Received int64
	Total    int64
}

// ChecksumError = ChecksumError（消息经 i18n）
type ChecksumError struct {
	Expected, Actual string
	msg              string
}

func (e *ChecksumError) Error() string { return e.msg }

// DownloadTimeoutError = DownloadTimeoutError
type DownloadTimeoutError struct{ IdleMs int64 }

func (e *DownloadTimeoutError) Error() string {
	return fmt.Sprintf("download stalled: no data for %ds (timeout)", int64(math.Floor(float64(e.IdleMs)/1000+0.5)))
}

// HTTPError：`download failed: HTTP n`（带 status）
type HTTPError struct {
	Status int
	msg    string
}

func (e *HTTPError) Error() string { return e.msg }

// FetchLike：发 GET，返回响应（Body 由调用方关闭）。默认 net/http（跟随重定向）
type FetchLike func(ctx context.Context, url string, headers map[string]string) (*http.Response, error)

// DefaultFetch：net/http 等价于 fetch(u, {redirect:'follow'})
func DefaultFetch(ctx context.Context, u string, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return http.DefaultClient.Do(req)
}

// DownloadOpts = downloadVerified 的参数
type DownloadOpts struct {
	URL           string
	Sha256        string
	Dest          string
	ExpectedBytes int64
	OnProgress    func(Progress)
	Fetch         FetchLike
	IdleTimeout   time.Duration
	Resume        bool
	T             func(key string, args ...any) string
	Now           func() time.Time
}

func sizeOf(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

func rmRetry(p string) {
	for i := 0; i < 6; i++ {
		err := os.RemoveAll(p)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// DownloadVerified = downloadVerified(opts)：流式写 .part → sha256 → 改名；ctx 取消 = abort
func DownloadVerified(ctx context.Context, o DownloadOpts) (retErr error) {
	if o.Fetch == nil {
		o.Fetch = DefaultFetch
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	tr := o.T
	if tr == nil {
		tr = func(k string, a ...any) string { return k }
	}
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var timer *time.Timer
	timedOut := make(chan struct{})
	arm := func() {
		if o.IdleTimeout <= 0 {
			return
		}
		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(o.IdleTimeout, func() {
			select {
			case <-timedOut:
			default:
				close(timedOut)
			}
			cancel()
		})
	}
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	isTimedOut := func() bool {
		select {
		case <-timedOut:
			return true
		default:
			return false
		}
	}
	tmp := o.Dest + ".part"
	keepPart := false
	var out *os.File
	defer func() {
		if retErr == nil {
			return
		}
		if out != nil {
			_ = out.Close()
		}
		if !keepPart {
			rmRetry(tmp)
		}
		if isTimedOut() {
			var te *DownloadTimeoutError
			if !errors.As(retErr, &te) {
				retErr = &DownloadTimeoutError{IdleMs: o.IdleTimeout.Milliseconds()}
			}
		}
	}()
	if err := os.MkdirAll(filepath.Dir(o.Dest), 0o755); err != nil {
		return err
	}
	var offset int64
	if o.Resume {
		offset = sizeOf(tmp)
		if o.ExpectedBytes > 0 && offset > o.ExpectedBytes {
			offset = 0
		}
	}
	arm()
	headers := map[string]string{}
	if offset > 0 {
		headers["Range"] = fmt.Sprintf("bytes=%d-", offset)
	}
	res, err := o.Fetch(cctx, o.URL, headers)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if res.StatusCode == 416 {
			rmRetry(tmp)
		}
		return &HTTPError{Status: res.StatusCode, msg: tr("electron.common.download-failed-http", res.StatusCode)}
	}
	resumed := offset > 0 && res.StatusCode == 206
	if !resumed {
		offset = 0
	}
	ln, _ := strconv.ParseFloat(strings.TrimSpace(res.Header.Get("Content-Length")), 64)
	var total int64
	if ln > 0 && !math.IsInf(ln, 0) {
		total = int64(ln) + offset
	}
	if total == 0 {
		total = o.ExpectedBytes
	}
	h := sha256.New()
	if resumed {
		f, err := os.Open(tmp)
		if err != nil {
			return err
		}
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
	} else {
		rmRetry(tmp)
	}
	keepPart = o.Resume
	flag := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	if resumed {
		flag = os.O_CREATE | os.O_WRONLY | os.O_APPEND
	}
	if out, err = os.OpenFile(tmp, flag, 0o666); err != nil {
		return err
	}
	received := offset
	var lastEmit int64
	emit := func(p Progress) {
		if o.OnProgress != nil {
			o.OnProgress(p)
		}
	}
	emit(Progress{received, total})
	buf := make([]byte, 64<<10)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			arm()
			h.Write(buf[:n])
			received += int64(n)
			if _, err := out.Write(buf[:n]); err != nil {
				return err
			}
			if now := o.Now().UnixMilli(); now-lastEmit > 150 {
				lastEmit = now
				emit(Progress{received, total})
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			if ctx.Err() != nil && !isTimedOut() {
				return ctx.Err()
			}
			return rerr
		}
	}
	if err := out.Close(); err != nil {
		out = nil
		return err
	}
	out = nil
	t := total
	if t == 0 {
		t = received
	}
	emit(Progress{received, t})
	actual := hex.EncodeToString(h.Sum(nil))
	if actual != strings.ToLower(o.Sha256) {
		keepPart = false
		return &ChecksumError{Expected: o.Sha256, Actual: actual,
			msg: tr("electron.common.checksum-failed-expected-got", firstN(o.Sha256, 12), actual[:12])}
	}
	return RenameWithRetry(tmp, o.Dest, 8, 150*time.Millisecond)
}

func firstN(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// RenameWithRetry = renameWithRetry（Windows 杀软占用时短暂 EPERM / EBUSY / EACCES）
func RenameWithRetry(from, to string, attempts int, delay time.Duration) error {
	for i := 0; ; i++ {
		err := os.Rename(from, to)
		if err == nil {
			return nil
		}
		if i >= attempts-1 || !(errors.Is(err, os.ErrPermission) || isBusy(err)) {
			return err
		}
		time.Sleep(delay * time.Duration(i+1))
	}
}

func isBusy(err error) bool {
	s := err.Error()
	return strings.Contains(s, "busy") || strings.Contains(s, "not empty") || strings.Contains(s, "being used")
}

var driveRe = regexp.MustCompile(`^[a-zA-Z]:`)

// SafeJoin = safeJoin(root, rel)：拒绝 ../ 与绝对路径（zip-slip）；root 须已是绝对路径
func SafeJoin(root, rel string) (string, bool) {
	clean := strings.ReplaceAll(rel, `\`, "/")
	if clean == "" || strings.HasPrefix(clean, "/") || driveRe.MatchString(clean) {
		return "", false
	}
	out, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(clean)))
	if err != nil {
		return "", false
	}
	if out == root || strings.HasPrefix(out, root+string(filepath.Separator)) {
		return out, true
	}
	return "", false
}

// Entry：归档里的一项
type Entry struct {
	Name string
	Data []byte
	Mode int64
	Link string
}

// ExtractZip = extractZip(buf, destDir)
func ExtractZip(buf []byte, destDir string) ([]string, error) {
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		return nil, err
	}
	es := []Entry{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		d, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
		es = append(es, Entry{Name: f.Name, Data: d, Mode: 0o755})
	}
	return writeEntries(es, destDir)
}

var nulTail = regexp.MustCompile(`(?s)\x00.*$`)

// parseInt(s, 8)：前导八进制数字；没有 → NaN（ok=false）
func parseOctal(s string) (int64, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	var v int64
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '7' {
		v = v*8 + int64(s[n]-'0')
		n++
	}
	if n == 0 {
		return 0, false
	}
	if neg {
		v = -v
	}
	return v, true
}

func tdecode(b []byte) string { return strings.ToValidUTF8(string(b), "\uFFFD") }

// ParseTar = parseTar(buf)（最小 ustar；模式 NaN → -1）
func ParseTar(buf []byte) []Entry {
	out := []Entry{}
	str := func(o, n int) string {
		e := o + n
		if e > len(buf) {
			e = len(buf)
		}
		return nulTail.ReplaceAllString(tdecode(buf[o:e]), "")
	}
	off := 0
	longName := ""
	hasLong := false
	for off+512 <= len(buf) {
		if buf[off] == 0 {
			break
		}
		name := str(off, 100)
		if prefix := str(off+345, 155); prefix != "" {
			name = prefix + "/" + name
		}
		if hasLong {
			name, hasLong = longName, false
		}
		ms := strings.TrimSpace(str(off+100, 8))
		if ms == "" {
			ms = "644"
		}
		mode, ok := parseOctal(ms)
		if !ok {
			mode = -1
		}
		ss := strings.TrimSpace(str(off+124, 12))
		if ss == "" {
			ss = "0"
		}
		size, ok := parseOctal(ss)
		if !ok {
			break // NaN 偏移：JS 循环条件为假
		}
		typ := buf[off+156]
		if typ == 0 {
			typ = '0'
		}
		link := str(off+157, 100)
		ds, de := off+512, off+512+int(size)
		if de > len(buf) {
			de = len(buf)
		}
		if de < ds {
			de = ds
		}
		data := buf[ds:de]
		switch typ {
		case 'L':
			longName, hasLong = nulTail.ReplaceAllString(tdecode(data), ""), true
		case '0':
			out = append(out, Entry{Name: name, Data: data, Mode: mode})
		case '2', '1':
			out = append(out, Entry{Name: name, Data: []byte{}, Mode: mode, Link: link})
		}
		off += 512 + int(math.Ceil(float64(size)/512))*512
	}
	return out
}

// ExtractTarGz = extractTarGz(buf, destDir)
func ExtractTarGz(buf []byte, destDir string) ([]string, error) {
	zr, err := gzip.NewReader(bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	return writeEntries(ParseTar(raw), destDir)
}

func writeEntries(entries []Entry, destDir string) ([]string, error) {
	files := []Entry{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name, "/") {
			files = append(files, e)
		}
	}
	tops := map[string]bool{}
	all := true
	for _, e := range files {
		tops[strings.Split(strings.ReplaceAll(e.Name, `\`, "/"), "/")[0]] = true
		if !strings.Contains(e.Name, "/") {
			all = false
		}
	}
	strip := len(tops) == 1 && all
	rel := func(n string) string {
		if !strip {
			return n
		}
		return strings.Join(strings.Split(strings.ReplaceAll(n, `\`, "/"), "/")[1:], "/")
	}
	abs, err := filepath.Abs(destDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o777); err != nil {
		return nil, err
	}
	byName := map[string]Entry{}
	for _, e := range files {
		byName[rel(e.Name)] = e
	}
	written := []string{}
	for _, e := range files {
		r := rel(e.Name)
		target, ok := SafeJoin(abs, r)
		if !ok {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			return written, err
		}
		data := e.Data
		if e.Link != "" {
			l, ok := byName[path.Join(path.Dir(r), e.Link)]
			if !ok {
				continue
			}
			data = l.Data
		}
		mode := os.FileMode(0o644)
		if e.Mode > 0 && e.Mode&0o777 != 0 {
			mode = os.FileMode(e.Mode & 0o777)
		}
		if err := os.WriteFile(target, data, mode); err != nil {
			return written, err
		}
		written = append(written, r)
	}
	return written, nil
}
