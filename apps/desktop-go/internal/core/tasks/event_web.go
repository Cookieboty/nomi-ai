package tasks

// `web` 事件源：HTTP 轮询网页 / RSS·Atom。条件请求（ETag /
// Last-Modified），没有就比内容哈希；订阅源按条目 id 去重。只拉公网地址（netguard 预检 + 不跟随跳转），正文最多 2 MB。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

type WebFilter struct {
	URL string `json:"url"`
	// Kind：page 整页有变化；feed RSS / Atom 的新条目
	Kind *string `json:"kind,omitempty"`
}

type webCursor struct {
	Etag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	Hash         string `json:"hash,omitempty"`
}

// WebResponse：可注入的请求结果（测试用）
type WebResponse struct {
	Status  int
	Headers http.Header
	Body    string
}

// WebFetch：不跟随跳转的 GET，正文最多读 maxBody 字节
type WebFetch func(ctx context.Context, url string, headers map[string]string, maxBody int64) (WebResponse, error)

const webMaxBody = 2 * 1024 * 1024

type WebSourceDeps struct {
	Fetch WebFetch
	// Resolve：DNS 解析后再查一次公网（测试里跳过）
	Resolve func(url string) error
	Now     func() int64
	T       i18n.Translate
}

var (
	cdataRE    = regexp.MustCompile(`<!\[CDATA\[([\s\S]*?)\]\]>`)
	feedItemRE = regexp.MustCompile(`(?i)<(item|entry)\b[\s\S]*?</(item|entry)>`)
	atomLinkRE = regexp.MustCompile(`(?i)<link\b[^>]*href="([^"]+)"`)
	scriptRE   = regexp.MustCompile(`(?i)<(script|style|noscript)\b[\s\S]*?</(script|style|noscript)>`)
	anyTagRE   = regexp.MustCompile(`<[^>]+>`)
	spacesRE   = regexp.MustCompile(`\s+`)
	tagREs     = func() map[string]*regexp.Regexp {
		m := map[string]*regexp.Regexp{}
		for _, n := range []string{"link", "guid", "id", "title", "pubDate", "updated", "published"} {
			m[n] = regexp.MustCompile(`(?i)<` + n + `\b[^>]*>([\s\S]*?)</` + n + `>`)
		}
		return m
	}()
)

func xmlDecode(s string) string {
	s = cdataRE.ReplaceAllString(s, "$1")
	s = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'").Replace(s)
	s = strings.ReplaceAll(s, "&amp;", "&")
	return strings.TrimSpace(s)
}

func xmlTag(block, name string) string {
	m := tagREs[name].FindStringSubmatch(block)
	if m == nil {
		return ""
	}
	return xmlDecode(m[1])
}

type FeedItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Link  string `json:"link"`
	At    int64  `json:"at"`
}

// parseFeedTime：Date.parse 能认的常见格式（RSS 的 RFC 1123 与 Atom 的 RFC 3339）
func parseFeedTime(s string) int64 {
	for _, layout := range []string{time.RFC1123Z, time.RFC1123, time.RFC3339Nano, time.RFC3339, "Mon, 2 Jan 2006 15:04:05 MST", "Mon, 2 Jan 2006 15:04:05 -0700"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// ParseFeed：RSS <item> / Atom <entry>：id、标题、链接、时间
func ParseFeed(xml string) []FeedItem {
	out := []FeedItem{}
	for _, m := range feedItemRE.FindAllStringSubmatch(xml, -1) {
		if len(out) >= 200 {
			break
		}
		if !strings.EqualFold(m[1], m[2]) {
			continue
		}
		b := m[0]
		atom := ""
		if a := atomLinkRE.FindStringSubmatch(b); a != nil {
			atom = a[1]
		}
		link := xmlTag(b, "link")
		if link == "" {
			link = xmlDecode(atom)
		}
		id := firstNonEmpty(xmlTag(b, "guid"), xmlTag(b, "id"), link, xmlTag(b, "title"))
		when := parseFeedTime(firstNonEmpty(xmlTag(b, "pubDate"), xmlTag(b, "updated"), xmlTag(b, "published")))
		if id != "" {
			out = append(out, FeedItem{ID: id, Title: xmlTag(b, "title"), Link: link, At: when})
		}
	}
	return out
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

// PageText：网页正文：去脚本、样式与标签，压空白（比哈希、给执行者看摘录）
func PageText(html string) string {
	s := scriptRE.ReplaceAllString(html, " ")
	s = anyTagRE.ReplaceAllString(s, " ")
	s = spacesRE.ReplaceAllString(s, " ")
	return xmlDecode(s)
}

// defaultWebFetch：不跟随跳转（3xx 原样返回），读到 maxBody 为止
func defaultWebFetch(ctx context.Context, url string, headers map[string]string, maxBody int64) (WebResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return WebResponse{}, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	c := &http.Client{Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := c.Do(req)
	if err != nil {
		return WebResponse{}, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if err != nil {
		return WebResponse{}, err
	}
	return WebResponse{Status: res.StatusCode, Headers: res.Header, Body: string(b)}, nil
}

func NewWebSource(d WebSourceDeps) *EventSource {
	if d.Fetch == nil {
		d.Fetch = defaultWebFetch
	}
	if d.Resolve == nil {
		d.Resolve = func(u string) error {
			_, err := security.AssertPublicHttpUrlResolved(u, nil)
			return err
		}
	}
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.T == nil {
		d.T = i18n.T
	}
	return &EventSource{
		ID:            "web",
		MinIntervalMs: 15 * 60_000,
		Validate: func(filter json.RawMessage, _ Task) string {
			var f WebFilter
			if len(filter) == 0 || json.Unmarshal(filter, &f) != nil || f.URL == "" {
				return "url required"
			}
			if _, err := security.AssertPublicHttpUrl(f.URL); err != nil {
				return err.Error()
			}
			if f.Kind != nil && *f.Kind != "page" && *f.Kind != "feed" {
				return "bad kind"
			}
			return ""
		},
		Poll: func(ctx context.Context, filter json.RawMessage, cursorRaw *string, _ Task) (PollResult, error) {
			var f WebFilter
			if err := json.Unmarshal(filter, &f); err != nil {
				return PollResult{}, err
			}
			if err := d.Resolve(f.URL); err != nil {
				return PollResult{}, err
			}
			cur := webCursor{}
			if cursorRaw != nil {
				_ = json.Unmarshal([]byte(*cursorRaw), &cur)
			}
			headers := map[string]string{"user-agent": "Nomi-Tasks/1"}
			if cur.Etag != "" {
				headers["if-none-match"] = cur.Etag
			}
			if cur.LastModified != "" {
				headers["if-modified-since"] = cur.LastModified
			}
			res, err := d.Fetch(ctx, f.URL, headers, webMaxBody)
			if err != nil {
				return PollResult{}, err
			}
			if res.Status == 304 {
				return PollResult{Events: []SourceEvent{}, Cursor: cursorRaw}, nil
			}
			if res.Status >= 300 && res.Status < 400 {
				return PollResult{}, fmt.Errorf("redirect not followed: %d", res.Status)
			}
			if res.Status >= 400 {
				return PollResult{}, fmt.Errorf("HTTP %d", res.Status)
			}
			body := res.Body
			if len(body) > webMaxBody {
				body = body[:webMaxBody]
			}
			next := webCursor{Etag: res.Headers.Get("etag"), LastModified: res.Headers.Get("last-modified")}
			events := []SourceEvent{}
			if f.Kind != nil && *f.Kind == "feed" {
				for _, it := range ParseFeed(body) {
					at := it.At
					if at == 0 {
						at = d.Now()
					}
					events = append(events, SourceEvent{
						Key:        "web:" + f.URL + ":" + it.ID,
						OccurredAt: at,
						Summary:    d.T("electron.common.task-event-feed-item", firstNonEmpty(it.Title, it.Link, it.ID)),
						Payload:    map[string]any{"url": f.URL, "title": it.Title, "link": it.Link},
					})
				}
				// 订阅源靠条目 key 去重（hub 的 seen）；第一次拉由 hub 当基线
				return PollResult{Events: events, Cursor: jsonCursor(next)}, nil
			}
			text := PageText(body)
			sum := sha256.Sum256([]byte(text))
			next.Hash = hex.EncodeToString(sum[:])[:32]
			if cur.Hash != "" && cur.Hash != next.Hash {
				events = append(events, SourceEvent{
					Key:        "web:" + f.URL + ":" + next.Hash,
					OccurredAt: d.Now(),
					Summary:    d.T("electron.common.task-event-page-changed", f.URL),
					Payload:    map[string]any{"url": f.URL, "excerpt": runeSlice(text, 4000)},
				})
			}
			return PollResult{Events: events, Cursor: jsonCursor(next)}, nil
		},
	}
}

func jsonCursor(v any) *string {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	s := string(b)
	return &s
}
