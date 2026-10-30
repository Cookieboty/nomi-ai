package gwstore

// service_helper.go = GatewayService 的 servedSession / servedSessionRef / sessionOwner / helperRoute / helperComplete
// （apps/desktop-electron/internal/core/src/gateway/GatewayService.ts）。golden：scripts/parity/record-gwcli.mjs「helpers」场景。

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ServedSession = servedSession(kind, sessionId)
func (s *Service) ServedSession(kind, sessionID string) bool {
	_, ok := s.sessionOwner(kind, sessionID)
	return ok
}

// ServedSessionRef = servedSessionRef(kind, sessionId)；"" = undefined
func (s *Service) ServedSessionRef(kind, sessionID string) string {
	owner, ok := s.sessionOwner(kind, sessionID)
	if !ok {
		return ""
	}
	if o, isObj := owner.(*u.Obj); isObj {
		if m, isStr := o.Get("model").(string); isStr && strings.Contains(m, "/") {
			return m
		}
	}
	return ""
}

// sessionOwner：ok=false 即 Node 的 null
func (s *Service) sessionOwner(kind, sessionID string) (any, bool) {
	if kind != "claude" || sessionID == "" {
		return nil, false
	}
	b, err := os.ReadFile(filepath.Join(s.rt.d.Root, "sessions.json"))
	if err != nil {
		return nil, false
	}
	raw, err := u.Parse(jsText(b))
	if err != nil {
		return nil, false
	}
	ro, isObj := raw.(*u.Obj)
	if raw == nil {
		return nil, false // null.sessions 抛错
	}
	var list any
	if isObj {
		list = ro.Get("sessions")
	}
	if list == nil {
		list = []any{}
	}
	arr, isArr := list.([]any)
	if !isArr {
		return nil, false // .find 不是函数
	}
	key := "claude:cc:" + sessionID
	for _, el := range arr {
		switch e := el.(type) {
		case []any:
			if len(e) > 0 && e[0] == key {
				if len(e) > 1 && e[1] != nil {
					return e[1], true
				}
				return u.NewObj(), true
			}
		case string:
			// 字符串可解构：k 是首个码点，长度 1 永远不等于 key
		default:
			return nil, false // 解构非可迭代值抛错
		}
	}
	return nil, false
}

// jsText = Response.text()/readFileSync(utf8) 的解码：去掉开头 BOM（仅 res.text()），非法字节换成 U+FFFD
func jsText(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	var out bytes.Buffer
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		out.WriteRune(r)
		b = b[n:]
	}
	return out.Bytes()
}

// HelperReceiver = helperRoute(...).receiver
type HelperReceiver struct {
	ID, Name string
	Local    bool
}

// HelperRoute = helperRoute 的返回值
type HelperRoute struct {
	Model    string
	Receiver HelperReceiver
}

// Obj：与 Node 返回值同形
func (h *HelperRoute) Obj() *u.Obj {
	if h == nil {
		return nil
	}
	return u.NewObj("model", h.Model, "receiver", u.NewObj("id", h.Receiver.ID, "name", h.Receiver.Name, "local", h.Receiver.Local))
}

// HelperRoute = helperRoute(kind, tabModel)；tabModel "" = null；nil = null
func (s *Service) HelperRoute(kind, tabModel string) *HelperRoute {
	if s.address("nomi", false) == nil {
		return nil
	}
	m := asObj(objGet(s.Store.Snapshot(), "clients", kind, "models"))
	cfg := s.gatewayConfig()
	refs := []any{m.Get("summary"), objGet(m, "tiers", "haiku"), m.Get("small"), tabModel, m.Get("main")}
	for _, r := range refs {
		if !u.Truthy(r) {
			continue
		}
		ref, isStr := r.(string)
		if !isStr {
			continue // 非字符串引用路由不到
		}
		picked := route.PreferredWire(cfg, "nomi", ref)
		if picked == nil || len(picked.Upstreams) == 0 {
			continue
		}
		up, cloud := picked.Upstreams[0], false
		for _, x := range picked.Upstreams {
			if !privateURL(x.URL) {
				up, cloud = x, true
				break
			}
		}
		return &HelperRoute{Model: picked.PublicModel, Receiver: HelperReceiver{ID: up.ProviderID, Name: up.Name, Local: !cloud}}
	}
	return nil
}

// HelperMessage = helperComplete 的 messages 条目
type HelperMessage struct{ Role, Content string }

// HelperComplete = helperComplete(model, messages, signal)
func (s *Service) HelperComplete(ctx context.Context, model string, messages []HelperMessage) (string, error) {
	ep := s.address("nomi", false)
	if ep == nil {
		return "", errors.New(i18n.T("electron.common.ai-service-not-ready"))
	}
	ms := make([]any, 0, len(messages))
	for _, m := range messages {
		ms = append(ms, u.NewObj("role", m.Role, "content", m.Content))
	}
	body := u.Stringify(u.NewObj("model", model, "messages", ms, "stream", false))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.URL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("authorization", "Bearer "+ep.Token)
	req.Header.Set("content-type", "application/json")
	res, err := s.rt.httpc.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	text := string(bytes.TrimPrefix(jsText(raw), []byte("\xef\xbb\xbf")))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", errors.New(strconv.Itoa(res.StatusCode) + " " + u.UTF16Slice0(text, 500))
	}
	j, err := u.ParseString(text)
	if err != nil {
		return "", nil
	}
	// j.choices?.[0]?.message?.content：null/undefined 短路，其它非对象取属性得 undefined
	jo, _ := j.(*u.Obj)
	var choices any
	if jo != nil {
		choices = jo.Get("choices")
	}
	var first any
	switch c := choices.(type) {
	case []any:
		if len(c) > 0 {
			first = c[0]
		}
	case *u.Obj:
		first = c.Get("0")
	}
	if fo, ok := first.(*u.Obj); ok {
		if msg, ok := fo.Get("message").(*u.Obj); ok {
			if c, ok := msg.Get("content").(string); ok {
				return c, nil
			}
		}
	}
	return "", nil
}
