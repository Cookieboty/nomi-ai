package gwstore

// tabtokens.go = TabTokens.ts：第三方标签的进程级路由令牌（先登记、后启动；网关重启后 replay）。

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
)

// BindingAckTimeout = BINDING_ACK_TIMEOUT_MS
const BindingAckTimeout = 3000 * time.Millisecond

// TabTokensDeps = TabTokensDeps
type TabTokensDeps struct {
	Send    func(m route.BindingMessage) bool
	Logger  Logger
	Timeout time.Duration
	Random  func(n int) []byte
}

// TabRegistration = TabRegistration
type TabRegistration struct {
	Token, TokenHash string
	Generation       int
}

type tabPending struct {
	done  chan error
	timer *time.Timer
}

// TabTokens = TabTokens
type TabTokens struct {
	d           TabTokensDeps
	mu          sync.Mutex
	active      map[string]*route.TabBinding
	order       []string
	generations map[string]int
	pending     map[string]*tabPending
	seq         int
}

func NewTabTokens(d TabTokensDeps) *TabTokens {
	return &TabTokens{d: d, active: map[string]*route.TabBinding{}, generations: map[string]int{}, pending: map[string]*tabPending{}}
}

func tabKey(client, tabID string) string { return client + "\x00" + tabID }

func (t *TabTokens) setActive(k string, b *route.TabBinding) {
	if _, ok := t.active[k]; !ok {
		t.order = append(t.order, k)
	}
	t.active[k] = b
}

func (t *TabTokens) delActive(k string) {
	if _, ok := t.active[k]; !ok {
		return
	}
	delete(t.active, k)
	for i, x := range t.order {
		if x == k {
			t.order = append(t.order[:i:i], t.order[i+1:]...)
			break
		}
	}
}

// TabRegisterInput = register 的参数
type TabRegisterInput struct {
	Client, TabID string
	Models        *config.ClientModels
	Effort        string
}

// Register = register(o)：网关确认后才返回
func (t *TabTokens) Register(o TabRegisterInput) (*TabRegistration, error) {
	k := tabKey(o.Client, o.TabID)
	rnd := t.d.Random
	if rnd == nil {
		rnd = func(n int) []byte { b := make([]byte, n); _, _ = rand.Read(b); return b }
	}
	t.mu.Lock()
	gen := t.generations[k] + 1
	t.generations[k] = gen
	token := route.TabTokenPrefix + base64.RawURLEncoding.EncodeToString(rnd(32))
	b := &route.TabBinding{TokenHash: route.HashTabToken(token), Client: o.Client, TabID: o.TabID, Generation: float64(gen), Models: o.Models}
	if o.Effort != "" {
		e := o.Effort
		b.Effort = &e
	}
	old := t.active[k]
	t.setActive(k, b)
	id := t.nextIDLocked()
	t.mu.Unlock()
	if err := t.request(route.BindingMessage{Type: "binding:add", ID: id, Binding: b}); err != nil {
		t.mu.Lock()
		if t.active[k] == b {
			t.delActive(k)
		}
		t.mu.Unlock()
		return nil, err
	}
	if old != nil && old.TokenHash != b.TokenHash {
		t.mu.Lock()
		rid := t.nextIDLocked()
		t.mu.Unlock()
		t.d.Send(route.BindingMessage{Type: "binding:remove", ID: rid, TokenHash: old.TokenHash})
	}
	return &TabRegistration{Token: token, TokenHash: b.TokenHash, Generation: gen}, nil
}

// TabUpdateInput = update 的参数；ClearEffort = effort: null
type TabUpdateInput struct {
	Client, TabID string
	Models        *config.ClientModels
	Effort        string
	ClearEffort   bool
}

// Update = update(o)：没有活着的绑定返回 false
func (t *TabTokens) Update(o TabUpdateInput) (bool, error) {
	k := tabKey(o.Client, o.TabID)
	t.mu.Lock()
	cur := t.active[k]
	if cur == nil {
		t.mu.Unlock()
		return false, nil
	}
	next := *cur
	if o.Models != nil {
		next.Models = o.Models
	}
	if o.ClearEffort {
		next.Effort = nil
	} else if o.Effort != "" {
		e := o.Effort
		next.Effort = &e
	}
	t.setActive(k, &next)
	id := t.nextIDLocked()
	t.mu.Unlock()
	if err := t.request(route.BindingMessage{Type: "binding:update", ID: id, Binding: &next}); err != nil {
		return true, err
	}
	return true, nil
}

// Remove = remove(client, tabId, generation?)；generation<0 = 不指定
func (t *TabTokens) Remove(client, tabID string, generation int) {
	k := tabKey(client, tabID)
	t.mu.Lock()
	cur := t.active[k]
	if cur == nil || (generation >= 0 && int(cur.Generation) != generation) {
		t.mu.Unlock()
		return
	}
	t.delActive(k)
	id := t.nextIDLocked()
	t.mu.Unlock()
	t.d.Send(route.BindingMessage{Type: "binding:remove", ID: id, TokenHash: cur.TokenHash})
}

// Has = has(client, tabId)
func (t *TabTokens) Has(client, tabID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.active[tabKey(client, tabID)]
	return ok
}

// OnAck = onAck(m)
func (t *TabTokens) OnAck(m route.BindingAck) {
	t.mu.Lock()
	p := t.pending[m.ID]
	if p != nil {
		delete(t.pending, m.ID)
		p.timer.Stop()
	}
	t.mu.Unlock()
	if p == nil {
		return
	}
	if m.Type == "binding:ok" {
		p.done <- nil
	} else {
		p.done <- errors.New(i18n.T("electron.common.the-gateway-rejected-the-tab-binding", m.Message))
	}
}

// Replay = replay()：重新登记还活着的绑定，失败只记日志
func (t *TabTokens) Replay() error {
	t.mu.Lock()
	bs := make([]*route.TabBinding, 0, len(t.order))
	for _, k := range t.order {
		bs = append(bs, t.active[k])
	}
	ids := make([]string, len(bs))
	for i := range bs {
		ids[i] = t.nextIDLocked()
	}
	t.mu.Unlock()
	if len(bs) == 0 {
		return nil
	}
	errs := make([]error, len(bs))
	var wg sync.WaitGroup
	for i, b := range bs {
		wg.Add(1)
		go func(i int, b *route.TabBinding) {
			defer wg.Done()
			errs[i] = t.request(route.BindingMessage{Type: "binding:add", ID: ids[i], Binding: b})
		}(i, b)
	}
	wg.Wait()
	failed := 0
	for _, e := range errs {
		if e != nil {
			failed++
		}
	}
	if t.d.Logger != nil {
		if failed > 0 {
			t.d.Logger.Warn("gateway tab bindings replay partial failure", map[string]any{"total": len(bs), "failed": failed})
		} else {
			t.d.Logger.Info("gateway tab bindings replayed", len(bs))
		}
	}
	return nil
}

func (t *TabTokens) nextIDLocked() string {
	t.seq++
	return "b" + strconv.Itoa(t.seq)
}

func (t *TabTokens) request(m route.BindingMessage) error {
	p := &tabPending{done: make(chan error, 1)}
	// 先登记再发：ack 可能在 send 返回前同步到达（同进程网关）
	t.mu.Lock()
	timeout := t.d.Timeout
	if timeout <= 0 {
		timeout = BindingAckTimeout
	}
	p.timer = time.AfterFunc(timeout, func() {
		t.mu.Lock()
		_, still := t.pending[m.ID]
		delete(t.pending, m.ID)
		t.mu.Unlock()
		if still {
			p.done <- errors.New(i18n.T("electron.common.the-gateway-didn-t-confirm-the-tab-binding"))
		}
	})
	t.pending[m.ID] = p
	t.mu.Unlock()
	if !t.d.Send(m) {
		t.mu.Lock()
		delete(t.pending, m.ID)
		p.timer.Stop()
		t.mu.Unlock()
		return errors.New(i18n.T("electron.common.the-gateway-isn-t-running-so-the-third"))
	}
	return <-p.done
}
