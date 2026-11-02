// Package hostdrop：从系统拖进对话窗口的文件，在 macOS / Linux 上由 Wails 的原生拖放层接走，
// 网页收不到 DOM 的 drop、也拿不到 File 对象（Windows 的 WebView2 两边都有）。宿主给每个拖进来的文件发一个
// 一次性的临时地址，经资产服务器同源提供，对话页读成 File 再走原来的附件流程。
//
// 只发用户刚拖进来的文件；地址带随机 token、30 秒内有效、读一次就作废；只服务普通文件（不跟随目录）。
package hostdrop

import (
	"crypto/rand"
	"encoding/hex"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Prefix：临时地址的路径前缀（对话页同源 fetch）
const Prefix = "/__nomi/drop/"

// TTL：临时地址的有效期
const TTL = 30 * time.Second

// Entry：发给对话页的一项（nomi:host-files 的 detail 元素）
type Entry struct {
	Path string `json:"path"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

type item struct {
	path string
	at   time.Time
}

// Store：token → 文件路径
type Store struct {
	mu    sync.Mutex
	items map[string]item
	now   func() time.Time
}

func New() *Store { return &Store{items: map[string]item{}, now: time.Now} }

// Add：给普通文件发临时地址；目录、读不到的文件只给路径（URL 为空）
func (s *Store) Add(paths []string) []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc()
	out := make([]Entry, 0, len(paths))
	for _, p := range paths {
		e := Entry{Path: p}
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			e.Size = st.Size()
			if tok, err := token(); err == nil {
				s.items[tok] = item{path: p, at: s.now()}
				e.URL = Prefix + tok
			}
		}
		out = append(out, e)
	}
	return out
}

// take：取出并作废一个没过期的 token
func (s *Store) take(tok string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc()
	it, ok := s.items[tok]
	if ok {
		delete(s.items, tok)
	}
	return it.path, ok
}

func (s *Store) gc() {
	now := s.now()
	for k, v := range s.items {
		if now.Sub(v.at) > TTL {
			delete(s.items, k)
		}
	}
}

func token() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Middleware：资产服务器中间件，Prefix 下按 token 提供文件（一次性），其余交给下一层
func (s *Store) Middleware(next func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler {
		inner := next(h)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok, ok := strings.CutPrefix(r.URL.Path, Prefix)
			if !ok {
				inner.ServeHTTP(w, r)
				return
			}
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			p, found := s.take(tok)
			if !found {
				http.NotFound(w, r)
				return
			}
			f, err := os.Open(p)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil || !st.Mode().IsRegular() {
				http.NotFound(w, r)
				return
			}
			ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(p)))
			if ct == "" {
				ct = "application/octet-stream"
			}
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.ServeContent(w, r, "", st.ModTime(), f)
		})
	}
}
