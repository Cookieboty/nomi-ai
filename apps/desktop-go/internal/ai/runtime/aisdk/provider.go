package aisdk

import (
	"context"
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Provider：AiSdkLlmProvider
type Provider struct {
	ID           string
	opts         Options
	modelFactory ModelFactory
	mu           sync.Mutex
	aborts       map[string]context.CancelFunc
	// inbox：正在跑工具循环的流式请求 → 用户插入、还没并进上下文的消息（steer）
	inbox map[string][]string
}

// DefaultMaxSteps：工具循环每轮最多几步（DEFAULT_MAX_STEPS）
const DefaultMaxSteps = 20

// NewProvider：constructor（modelFactory 由协议层注入，见 buildModelFactory）
func NewProvider(opts Options, factory ModelFactory) (*Provider, error) {
	if strings.TrimSpace(opts.BaseURL) == "" {
		return nil, fmt.Errorf("[%s] baseURL is required", opts.ID)
	}
	if factory == nil {
		factory = BuildModelFactory(opts)
	}
	return &Provider{ID: opts.ID, opts: opts, modelFactory: factory, aborts: map[string]context.CancelFunc{}, inbox: map[string][]string{}}, nil
}

/* ------------------------------- helpers ------------------------------- */

// toolOutputMax：stringifyToolOutput 的默认 max（变量仅供变异测试）
var toolOutputMax = 6000

const (
	maxImages      = 6
	maxImageBase64 = 16 * 1024 * 1024
)

var imageMime = regexp.MustCompile(`^image/(png|jpeg|webp|gif)$`)

// DropHistoryReasoning：历史消息（都是之前几轮的）里助手消息的 reasoning 部分去掉；不改原对象，没有时原样返回
func DropHistoryReasoning(msgs []*u.Obj) []*u.Obj {
	var out []*u.Obj
	for i, m := range msgs {
		parts, ok := m.Get("content").([]any)
		if !ok || m.Get("role") != "assistant" {
			continue
		}
		kept := make([]any, 0, len(parts))
		for _, x := range parts {
			if o, ok := x.(*u.Obj); ok && o.Get("type") == "reasoning" {
				continue
			}
			kept = append(kept, x)
		}
		if len(kept) == len(parts) {
			continue
		}
		if out == nil {
			out = append([]*u.Obj{}, msgs...)
		}
		out[i] = m.Clone().Set("content", kept)
	}
	if out == nil {
		return msgs
	}
	return out
}

// SplitPrompt：splitPrompt
func SplitPrompt(messages []llm.ChatMessage) (*string, []*u.Obj) {
	var systems []string
	rest := []*u.Obj{}
	for _, m := range messages {
		switch m.Role {
		case "system":
			systems = append(systems, m.Content)
			continue
		case "tool":
			id, name := "unknown", "tool"
			if m.ToolCallID != nil {
				id = *m.ToolCallID
			}
			if m.Name != nil {
				name = *m.Name
			}
			rest = append(rest, u.NewObj("role", "tool", "content", []any{u.NewObj("type", "tool-result", "toolCallId", id, "toolName", name, "output", u.NewObj("type", "text", "value", m.Content))}))
			continue
		case "assistant":
			// 上一轮工具循环的原样记录（含工具调用与结果）：照发，前缀与上一轮最后一次请求一致
			if steps := parseSteps(m.Steps); steps != nil {
				rest = append(rest, steps...)
				continue
			}
			rest = append(rest, u.NewObj("role", "assistant", "content", m.Content))
			continue
		}
		text := m.Content
		if c := strings.TrimSpace(m.Context); c != "" {
			text = c + "\n\n" + m.Content
		}
		var images []llm.ChatImage
		for _, i := range m.Images {
			if _, ok := i.Data.(string); ok && imageMime.MatchString(i.Mime) {
				images = append(images, i)
			}
		}
		if len(images) > 0 {
			budget := maxImageBase64
			parts := []any{}
			if len(images) > maxImages {
				images = images[:maxImages]
			}
			for _, i := range images {
				d := i.Data.(string)
				n := len(utf16.Encode([]rune(d)))
				if n > budget {
					break
				}
				budget -= n
				parts = append(parts, u.NewObj("type", "image", "image", d, "mediaType", i.Mime))
			}
			parts = append(parts, u.NewObj("type", "text", "text", text))
			rest = append(rest, u.NewObj("role", "user", "content", parts))
			continue
		}
		rest = append(rest, u.NewObj("role", "user", "content", text))
	}
	if len(systems) == 0 {
		return nil, rest
	}
	s := strings.Join(systems, "\n\n")
	return &s, rest
}

// parseSteps：ChatMessage.Steps → ModelMessage[]（按键序解析，工具参数原样）；空、坏的或含非法消息时 nil（退回按正文发）
func parseSteps(raw string) []*u.Obj {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	v, err := u.ParseString(raw)
	if err != nil {
		return nil
	}
	arr, ok := v.([]any)
	if !ok || len(arr) == 0 {
		return nil
	}
	out := make([]*u.Obj, 0, len(arr))
	for _, x := range arr {
		m, ok := x.(*u.Obj)
		if !ok {
			return nil
		}
		switch m.Get("role") {
		case "user", "assistant":
			switch m.Get("content").(type) {
			case string, []any:
			default:
				return nil
			}
		case "tool":
			if _, ok := m.Get("content").([]any); !ok {
				return nil
			}
		default:
			return nil
		}
		out = append(out, m)
	}
	return out
}

// StepsJSON：这一轮工具循环发给模型的消息 → ChatMessage.Steps；没有工具调用（只有一条回复）时 ""
func StepsJSON(msgs []*u.Obj) string {
	tool := false
	for _, m := range msgs {
		if m != nil && m.Get("role") != "assistant" {
			tool = true
			break
		}
	}
	if !tool {
		return ""
	}
	arr := make([]any, len(msgs))
	for i, m := range msgs {
		arr[i] = m
	}
	return u.Stringify(arr)
}

// usageOf：LanguageModelUsage → ChatUsage（u 恒存在：streamText/generateText 总会给出 usage 对象）
func usageOf(x Usage) *llm.ChatUsage {
	val := func(p *float64) float64 {
		if p == nil {
			return 0
		}
		return *p
	}
	r := &llm.ChatUsage{PromptTokens: val(x.InputTokens), CompletionTokens: val(x.OutputTokens)}
	if x.TotalTokens != nil {
		r.TotalTokens = *x.TotalTokens
	} else {
		r.TotalTokens = r.PromptTokens + r.CompletionTokens
	}
	if x.CacheReadTokens != nil && *x.CacheReadTokens != 0 && !math.IsNaN(*x.CacheReadTokens) {
		v := *x.CacheReadTokens
		r.CacheReadTokens = &v
	}
	if x.CacheWriteTokens != nil && *x.CacheWriteTokens != 0 && !math.IsNaN(*x.CacheWriteTokens) {
		v := *x.CacheWriteTokens
		r.CacheWriteTokens = &v
	}
	return r
}

func withRedacted(c *llm.ChatUsage, redacted int) *llm.ChatUsage {
	if c == nil || redacted == 0 {
		return c
	}
	cp := *c
	r := float64(redacted)
	cp.Redacted = &r
	return &cp
}

// StringifyToolOutput：stringifyToolOutput（max 6000，按 UTF-16 码元截断）
func StringifyToolOutput(v any, max int) *string {
	if v == nil {
		return nil
	}
	if _, ok := v.(u.JSUndefined); ok {
		return nil
	}
	var s string
	if str, ok := v.(string); ok {
		s = str
	} else {
		s = u.Stringify(v)
		if s == "" {
			s = jsString(v)
		}
	}
	units := utf16.Encode([]rune(s))
	if len(units) > max {
		s = string(utf16.Decode(units[:max])) + "\n… (+" + strconv.Itoa(len(units)-max) + ")"
	}
	return &s
}

func finishOf(raw string) string {
	switch raw {
	case "length":
		return "length"
	case "content-filter":
		return "content_filter"
	case "tool-calls":
		return "tool_calls"
	case "error":
		return "error"
	}
	return "stop"
}

// ThinkingOptions：thinkingOptions
func (p *Provider) thinkingOptions() *u.Obj {
	if p.opts.Thinking == nil || !*p.opts.Thinking {
		return nil
	}
	switch p.protocol() {
	case "anthropic":
		return u.NewObj("anthropic", u.NewObj("thinking", u.NewObj("type", "enabled", "budgetTokens", float64(2048))))
	case "openai-responses":
		return u.NewObj("openai", u.NewObj("reasoningEffort", "medium"))
	}
	return u.NewObj(p.ID, u.NewObj("reasoningEffort", "medium"))
}

// cacheOptions：同一会话的请求带同一个 prompt_cache_key（OpenAI 系按它把请求落到同一份前缀缓存；
// 网关也按它认会话）。没有会话 id（后台任务等）不带；上游不认这个参数时网关会学到并去掉
func (p *Provider) cacheOptions(po *u.Obj, r *llm.ChatRequest) *u.Obj {
	conv, _ := r.Extra["conversationId"].(string)
	if conv = strings.TrimSpace(conv); conv == "" {
		return po
	}
	key := "nomi-" + conv
	ns, field := p.ID, "prompt_cache_key"
	switch p.protocol() {
	case "anthropic":
		return po
	case "openai-responses":
		ns, field = "openai", "promptCacheKey"
	}
	if po == nil {
		po = u.NewObj()
	} else {
		po = po.Clone()
	}
	inner, _ := po.Get(ns).(*u.Obj)
	if inner == nil {
		inner = u.NewObj()
	} else {
		inner = inner.Clone()
	}
	inner.Set(field, key)
	po.Set(ns, inner)
	return po
}

func (p *Provider) protocol() string {
	if p.opts.Protocol == "" {
		return "openai-chat"
	}
	return p.opts.Protocol
}

func (p *Provider) redacted(h map[string]string) int {
	name := p.opts.RedactedHeader
	if name == "" || h == nil {
		return 0
	}
	v, ok := h[strings.ToLower(name)]
	if !ok {
		return 0
	}
	f := jsNumber(v)
	if f > 0 && f == math.Trunc(f) && !math.IsInf(f, 0) {
		return int(f)
	}
	return 0
}

// jsNumber：Number(string)
func jsNumber(s string) float64 {
	t := u.JSTrim(s)
	if t == "" {
		return 0
	}
	if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
		if n, err := strconv.ParseUint(t[2:], 16, 64); err == nil {
			return float64(n)
		}
		return math.NaN()
	}
	if t == "Infinity" || t == "+Infinity" {
		return math.Inf(1)
	}
	if t == "-Infinity" {
		return math.Inf(-1)
	}
	if strings.ContainsAny(t, "_xXpPnN") && !strings.Contains(t, "e") {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

func (p *Provider) servedModel(h map[string]string) *string {
	name := p.opts.ServedModelHeader
	if name == "" || h == nil {
		return nil
	}
	v, ok := h[strings.ToLower(name)]
	if !ok {
		return nil
	}
	v = u.JSTrim(v)
	if v == "" {
		return nil
	}
	return &v
}

func (p *Provider) resolveModel(r *llm.ChatRequest) string {
	asked := r.Model
	if asked == "" || asked == "default" {
		asked = p.opts.DefaultModel
		if asked == "" {
			asked = "default"
		}
	}
	return protocol.MapModel(asked, p.opts.ModelMap)
}

func (p *Provider) assertKey() error {
	if (p.opts.RequiresAPIKey == nil || *p.opts.RequiresAPIKey) && u.JSTrim(p.opts.APIKey) == "" {
		return fmt.Errorf("[%s] API key is not configured", p.ID)
	}
	return nil
}

func (p *Provider) bindAbort(ctx context.Context, r *llm.ChatRequest) (context.Context, func()) {
	c, cancel := context.WithCancel(ctx)
	p.mu.Lock()
	p.aborts[r.ReqID] = cancel
	p.mu.Unlock()
	if r.Signal != nil {
		go func() {
			select {
			case <-r.Signal:
				cancel()
			case <-c.Done():
			}
		}()
	}
	return c, func() {
		p.mu.Lock()
		delete(p.aborts, r.ReqID)
		p.mu.Unlock()
		cancel()
	}
}

// Abort：abort(reqId)
func (p *Provider) Abort(reqID string) {
	p.mu.Lock()
	c := p.aborts[reqID]
	delete(p.aborts, reqID)
	p.mu.Unlock()
	if c != nil {
		c()
	}
}

// Steer = steer(reqId, text)：一轮进行中插入用户消息，只收正在跑工具循环的流式请求，下一步（PrepareStep）并进上下文
func (p *Provider) Steer(reqID, text string) bool {
	body := u.JSTrim(text)
	p.mu.Lock()
	defer p.mu.Unlock()
	q, ok := p.inbox[reqID]
	if !ok || body == "" {
		return false
	}
	p.inbox[reqID] = append(q, body)
	return true
}

// takeInbox = q.splice(0)：取走并清空收到的插入消息
func (p *Provider) takeInbox(reqID string) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	q := p.inbox[reqID]
	if len(q) == 0 {
		return nil
	}
	p.inbox[reqID] = []string{}
	return q
}

// MaxSteerRounds = MAX_STEER_ROUNDS：最后一步才收到插入消息时，最多续跑几轮
const MaxSteerRounds = 3

// MaxAutoRounds：一轮的工具步数用完、模型还要接着调工具时，自动再续几轮（每轮 StepCount 步）。
// 复杂任务（读代码 → 改 → 跑测试 → 再改）常要上百步，不让用户反复说「继续」；
// 上限只是兜底（防止原地打转），用户随时可以停止，后台任务另有预算。
var MaxAutoRounds = 20

// MaxAutoContinueTokens：自动续跑的累计 token 上限（输入 + 输出，所有轮次合计）。每一步都重发整段历史，
// 不设上限时前台一次长任务能烧掉上千万 token；超了就停下，告诉用户说「继续」接着做。后台任务另有按次预算。
var MaxAutoContinueTokens = 3_000_000

// deniedTool：工具结果 / 错误是「用户拒绝 / 权限模式不允许」——这时不自动续跑，免得模型换个方式反复弹确认
func deniedTool(s string) bool {
	if s == "" {
		return false
	}
	return strings.Contains(s, "user_denied") || strings.Contains(s, "mode_blocked")
}

// autoStoppedNotice：自动续跑到上限 / 被拒绝后停下时补在回复末尾的一句（不是静默结束）
func autoStoppedNotice(reason string, rounds int) string {
	switch reason {
	case "denied":
		return "\n\n" + i18n.T("electron.common.auto-continue-stopped-denied")
	case "tokens":
		return "\n\n" + i18n.T("electron.common.auto-continue-stopped-budget", rounds)
	case "no-progress":
		return "\n\n" + i18n.T("electron.common.auto-continue-stopped-no-progress")
	}
	return "\n\n" + i18n.T("electron.common.auto-continue-stopped-rounds", rounds)
}

// addChatUsage = addUsage：两段用量相加（续跑轮次合并成一轮的用量）
func addChatUsage(a, b *llm.ChatUsage) *llm.ChatUsage {
	if a == nil || b == nil {
		if a != nil {
			return a
		}
		return b
	}
	opt := func(x, y *float64) *float64 {
		if x == nil && y == nil {
			return nil
		}
		v := 0.0
		if x != nil {
			v += *x
		}
		if y != nil {
			v += *y
		}
		return &v
	}
	r := *a
	r.PromptTokens = a.PromptTokens + b.PromptTokens
	r.CompletionTokens = a.CompletionTokens + b.CompletionTokens
	r.TotalTokens = a.TotalTokens + b.TotalTokens
	if v := opt(a.CacheReadTokens, b.CacheReadTokens); v != nil {
		r.CacheReadTokens = v
	}
	if v := opt(a.CacheWriteTokens, b.CacheWriteTokens); v != nil {
		r.CacheWriteTokens = v
	}
	return &r
}

// SteerInsert：一轮里用户插入的消息，放在第 At 条消息之前（At = 收到时 SDK 消息列表的长度）
type SteerInsert struct {
	At   int
	Text string
}

// SteerPrefix = STEER_PREFIX：插入消息的前缀，与 Claude Code 中途消息的写法一致，模型据此知道这是用户本人后来补充的
const SteerPrefix = "The user sent a new message while you were working:"

// WithSteerInserts = withSteerInserts：把插入消息按位置放回这一步的消息列表（同一位置的按收到顺序）
func WithSteerInserts(messages []*u.Obj, inserts []SteerInsert) []*u.Obj {
	out := append([]*u.Obj{}, messages...)
	// 稳定排序：位置小的在前，同一位置保持收到的先后；每插一条，后面的位置顺延一格
	sorted := append([]SteerInsert{}, inserts...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At < sorted[j].At })
	for offset, ins := range sorted {
		at := ins.At + offset
		if at > len(out) {
			at = len(out)
		}
		msg := u.NewObj("role", "user", "content", SteerPrefix+"\n"+ins.Text)
		out = append(out[:at], append([]*u.Obj{msg}, out[at:]...)...)
	}
	return out
}

/* ------------------------------- tools ------------------------------- */

// LastUserText = lastUserText：本轮用户最后说的话（截断到 2000 字），给工具做命令自动审核
func LastUserText(msgs []llm.ChatMessage) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role != "user" {
			continue
		}
		t := []rune(strings.TrimSpace(msgs[i].Content))
		if len(t) > 2000 {
			t = t[:2000]
		}
		return string(t)
	}
	return ""
}

// ConversationText = conversationText：整段对话里用户与助手说过的话（不含系统提示与工具结果，
// 小写，最多 20000 字），按需提供工具用
func ConversationText(msgs []llm.ChatMessage) string {
	parts := []string{}
	for _, m := range msgs {
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		if t := strings.TrimSpace(m.Content); t != "" {
			parts = append(parts, t)
		}
	}
	r := []rune(strings.Join(parts, "\n"))
	if len(r) > 20000 {
		r = r[len(r)-20000:]
	}
	return strings.ToLower(string(r))
}

// modelSchema：发给模型的 schema 去掉 $schema（每个工具省十几个 token，模型用不上）
func modelSchema(d tools.Definition) *u.Obj {
	s := tools.SchemaOf(d)
	if !s.Has("$schema") {
		return s
	}
	c := s.Clone()
	c.Delete("$schema")
	return c
}

// ToolSet：withTools 为一次请求生成的工具集（toAiSdkToolSet）
func (p *Provider) toolsFor(defs []tools.Definition, r *llm.ChatRequest) []Tool {
	recv := p.opts.Receiver
	if recv == nil {
		recv = &tools.ToolCallProvider{ID: p.ID, BaseURL: p.opts.BaseURL}
	}
	str := func(k string) string {
		s, _ := r.Extra[k].(string)
		return s
	}
	callerSet := false
	if v, ok := r.Extra["callerTabId"]; ok && v != nil {
		callerSet = true
	}
	caller, conv, cwd := str("callerTabId"), str("conversationId"), str("cwd")
	// 暂存的大段输出按对话隔离；后台任务按任务
	spillKey := conv
	if t := str("taskId"); t != "" {
		spillKey = "task:" + t
	}
	userText := LastUserText(r.Messages)
	turn := tools.Turn{UserText: userText, ConvoText: ConversationText(r.Messages), Cwd: cwd}
	out := []Tool{}
	for _, d := range defs {
		if d.RequiresWorkspace && cwd == "" {
			continue
		}
		if !tools.IsAvailable(d) {
			continue
		}
		// 后台任务的执行（extra.taskId）：工具已按任务授权给出白名单，不再按对话文字做按需门控。
		// 对话里开过的工具一直提供（tools.Sticky）：对话文字滑出 2 万字窗口、压缩后，工具定义不变，前缀缓存不断
		if str("taskId") == "" && !tools.Sticky(conv, d.Name, tools.IsRelevant(d, turn)) {
			continue
		}
		d := d
		var desc *string
		if !d.NoDescription {
			s := d.Description
			desc = &s
		}
		out = append(out, Tool{
			Name: d.Name, Description: desc, InputSchema: modelSchema(d),
			Execute: func(ctx context.Context, input any, id string) (any, error) {
				// callerTabId ?? getToolCallerTabId()
				caller := caller
				if !callerSet {
					caller, _ = tools.GetToolCallerTabID(ctx)
				}
				// 权限按对话记授权（desktop.PermissionBroker）：把对话 id 带进 ctx
				ctx = tools.WithConversation(ctx, conv)
				res, err := d.Execute(ctx, input, tools.ExecContext{ToolCallID: id, Provider: recv, ReqID: r.ReqID, CallerTabID: caller, ConversationID: conv, Cwd: cwd, UserText: userText})
				if err != nil {
					return res, err
				}
				// 大段输出先暂存，模型看开头和结尾、需要时分页读（spill.go）
				return spillOutput(d.Name, spillKey, res), nil
			},
		})
	}
	if len(out) > 0 {
		out = append(out, outputReadTool(spillKey, recv))
	}
	return out
}

// Bound：withTools(defs) 的 { chat, stream }
type Bound struct {
	p    *Provider
	defs []tools.Definition
}

func (p *Provider) WithTools(defs []tools.Definition) llm.ToolRunner { return Bound{p, defs} }

// ProviderID：LLMProvider.id
func (p *Provider) ProviderID() string { return p.ID }

func (b Bound) Chat(ctx context.Context, r *llm.ChatRequest) (*llm.ChatResponse, error) {
	t := b.p.toolsFor(b.defs, r)
	return b.p.runChat(ctx, r, t, true)
}

func (b Bound) Stream(ctx context.Context, r *llm.ChatRequest, emit func(llm.ChatChunk)) error {
	t := b.p.toolsFor(b.defs, r)
	return b.p.runStream(ctx, r, t, true, emit)
}

func (p *Provider) Chat(ctx context.Context, r *llm.ChatRequest) (*llm.ChatResponse, error) {
	return p.runChat(ctx, r, nil, false)
}

func (p *Provider) Stream(ctx context.Context, r *llm.ChatRequest, emit func(llm.ChatChunk)) error {
	return p.runStream(ctx, r, nil, false, emit)
}

func (p *Provider) params(r *llm.ChatRequest, ts []Tool, hasTools bool) *TextParams {
	instr, msgs := SplitPrompt(r.Messages)
	// 前几轮工具记录里的思考内容：OpenAI 兼容协议会作为 reasoning_content 每轮全量重发、按输入计费，
	// 对这一轮没有用（DeepSeek / Kimi 等只要求同一轮工具循环里带回）。Anthropic 由上游自己剥掉、不计入上下文，
	// 原样保留（剥了反而改变前缀、断缓存）
	if p.protocol() != "anthropic" {
		msgs = DropHistoryReasoning(msgs)
	}
	tp := &TextParams{
		Model: p.modelFactory(p.resolveModel(r)), Instructions: instr, Messages: msgs,
		Temperature: r.Temperature, TopP: r.TopP, MaxOutputTokens: r.MaxTokens,
		ProviderOptions: p.cacheOptions(p.thinkingOptions(), r), MaxRetries: p.opts.MaxRetries,
		CacheBreakpoints: p.protocol() == "anthropic",
	}
	if hasTools {
		tp.Tools, tp.HasTools = ts, true
		tp.StepCount = DefaultMaxSteps
		if p.opts.MaxSteps != nil {
			tp.StepCount = *p.opts.MaxSteps
		}
	}
	return tp
}

func (p *Provider) runChat(ctx context.Context, r *llm.ChatRequest, ts []Tool, hasTools bool) (*llm.ChatResponse, error) {
	if err := p.assertKey(); err != nil {
		return nil, err
	}
	c, done := p.bindAbort(ctx, r)
	defer done()
	res, err := GenerateText(c, p.params(r, ts, hasTools))
	if err != nil {
		return nil, err
	}
	var calls []llm.ToolCallOut
	if len(res.ToolCalls) > 0 {
		for _, t := range res.ToolCalls {
			calls = append(calls, llm.ToolCallOut{ID: t.ToolCallID, Name: t.ToolName, ArgumentsJSON: argsJSON(t.Input)})
		}
	}
	model := p.resolveModel(r)
	if s := p.servedModel(res.Headers); s != nil {
		model = *s
	}
	return &llm.ChatResponse{
		ReqID: r.ReqID, Provider: p.ID, Model: model, Content: res.Text, ToolCalls: calls,
		FinishReason: finishOf(res.FinishReason), Usage: withRedacted(usageOf(res.Usage), p.redacted(res.Headers)),
	}, nil
}

// argsJSON：JSON.stringify(input ?? {})
func argsJSON(in any) string {
	if in == nil {
		return "{}"
	}
	if _, ok := in.(u.JSUndefined); ok {
		return "{}"
	}
	return u.Stringify(in)
}

func (p *Provider) runStream(ctx context.Context, r *llm.ChatRequest, ts []Tool, hasTools bool, emit func(llm.ChatChunk)) error {
	if err := p.assertKey(); err != nil {
		// async generator：assertKey 的异常在首次迭代时抛出（不经 catch，不产出 error 块）
		return err
	}
	c, done := p.bindAbort(ctx, r)
	defer done()
	tp := p.params(r, ts, hasTools)
	// 有工具循环才能中途插入：每一步开始前把收到的插入消息放到当时的位置，之后每一步都带着
	if hasTools {
		p.mu.Lock()
		p.inbox[r.ReqID] = []string{}
		p.mu.Unlock()
		defer func() {
			p.mu.Lock()
			delete(p.inbox, r.ReqID)
			p.mu.Unlock()
		}()
	}
	messages := tp.Messages
	var served *string
	// 每一步都是一次网关请求，都会带上整段历史：取各步的最大值
	redacted := 0
	// 最后一步的用量 = 当前上下文（finish 的 totalUsage 是各步累加）
	var lastStep *llm.ChatUsage
	// firstPrompt：这一轮第一次请求的真实输入（校准上下文分项的固定部分，见 breakdown.go）
	firstPrompt := 0.0
	// 跨续跑轮次累加的用量
	var total *llm.ChatUsage
	// steerRounds：为最后一步才到的插入消息续跑的轮数；autoRounds：步数用完自动续跑的轮数；
	// planNudges：计划没做完就收尾时提醒的次数（autoprogress.go）；sinceNudge：上次提醒之后有没有实际动作
	steerRounds, autoRounds, planNudges := 0, 0, 0
	sinceNudge := true
	// 上下文守护（contextguard.go）：跨续跑轮次共用，按上一步的真实输入用量判断
	var guard *contextGuard
	if hasTools {
		// 跨轮状态按对话记；后台任务按任务记（同一来源对话里的多个任务互不影响）
		key, _ := r.Extra["taskId"].(string)
		if key == "" {
			key, _ = r.Extra["conversationId"].(string)
		}
		guard = newContextGuard(r.ContextBudget, key)
		defer guard.finish()
		if guard != nil {
			guard.turnBase = len(tp.Messages)
			if r.Summarize != nil {
				guard.summarize = func(system, transcript string) (string, error) { return r.Summarize(c, system, transcript) }
				guard.sendCheck = func() error { return tools.CheckDataSend(c, nil, "summary") }
			}
		}
	}
	for {
		var inserts []SteerInsert
		rp := *tp
		rp.Messages = messages
		if hasTools {
			rp.PrepareStep = func(step []*u.Obj) []*u.Obj {
				if q := p.takeInbox(r.ReqID); len(q) > 0 {
					inserts = append(inserts, SteerInsert{At: len(step), Text: strings.Join(q, "\n\n")})
				}
				if len(inserts) == 0 && guard == nil {
					return nil
				}
				out := step
				if len(inserts) > 0 {
					out = WithSteerInserts(step, inserts)
				}
				return guard.prepare(out)
			}
			if guard != nil {
				rp.RetryOverflow = func(err error, sent []*u.Obj) []*u.Obj {
					if !IsContextOverflow(err) {
						return nil
					}
					return guard.overflow(sent)
				}
			}
		}
		var finish *string
		var resMsgs []*u.Obj
		stepLimit, denied := false, false
		StreamText(c, &rp, func(part Part) {
			switch part.Type {
			case "finish-step":
				if s := p.servedModel(part.Headers); s != nil {
					served = s
				}
				if n := p.redacted(part.Headers); n > redacted {
					redacted = n
				}
				lastStep = usageOf(part.Usage)
				if lastStep != nil {
					guard.observe(lastStep.PromptTokens)
				}
				if firstPrompt == 0 && lastStep != nil {
					firstPrompt = lastStep.PromptTokens
				}
			case "text-delta":
				emit(llm.ChatChunk{Type: "delta", Content: part.Text})
			case "reasoning-start":
				emit(llm.ChatChunk{Type: "reasoning", Phase: "start"})
			case "reasoning-end":
				emit(llm.ChatChunk{Type: "reasoning", Phase: "end"})
			case "reasoning-delta":
				if part.Text != "" {
					emit(llm.ChatChunk{Type: "reasoning", Content: part.Text})
				}
			case "tool-call":
				emit(llm.ChatChunk{Type: "tool_call.delta", Index: 0, Name: llm.Str(part.ToolName), ArgumentsJSON: llm.Str(argsJSON(part.Input)), ID: llm.Str(part.ToolCallID)})
			case "tool-result":
				out := StringifyToolOutput(part.Output, toolOutputMax)
				if out != nil && deniedTool(*out) {
					denied = true
				}
				emit(llm.ChatChunk{Type: "tool_call.result", ID: llm.Str(part.ToolCallID), Name: llm.Str(part.ToolName), Output: out})
			case "tool-error":
				var msg string
				switch e := part.Error.(type) {
				case *ValueError:
					msg = jsString(e.Value)
				case error:
					msg = e.Error()
				default:
					msg = jsString(e)
				}
				if deniedTool(msg) || toolErrorCodeDenied(part.Error) {
					denied = true
				}
				emit(llm.ChatChunk{Type: "tool_call.result", ID: llm.Str(part.ToolCallID), Name: llm.Str(part.ToolName), Error: &msg})
			case "finish":
				total = addChatUsage(total, usageOf(part.TotalUsage))
				f := finishOf(part.FinishReason)
				finish = &f
				resMsgs = part.ResponseMessages
				stepLimit = part.StepLimit
			case "error":
				s := DescribeStreamError(part.Error)
				emit(llm.ChatChunk{Type: "error", Error: &s})
			}
		})
		if finish == nil {
			break
		}
		// 最后一步才收到的插入消息（没有下一步可并进去）：带上它再跑一轮，仍算这一轮；
		// 要结束时先关掉收件箱（取走与关闭在同一把锁里），之后再来的插入返回 false（视图改为排队），不会悄悄丢掉
		p.mu.Lock()
		left := p.inbox[r.ReqID]
		if _, ok := p.inbox[r.ReqID]; ok {
			p.inbox[r.ReqID] = []string{}
		}
		// 步数用完时最后一步的工具已经执行、结果模型还没看到：接着跑一轮
		auto := hasTools && stepLimit && autoRounds < MaxAutoRounds
		progress := madeProgress(messages[len(tp.Messages):], resMsgs)
		sinceNudge = sinceNudge || progress
		stopReason := ""
		if hasTools && stepLimit {
			switch {
			case denied:
				auto, stopReason = false, "denied"
			case total != nil && total.PromptTokens+total.CompletionTokens > float64(MaxAutoContinueTokens):
				auto, stopReason = false, "tokens"
			case autoRounds >= MaxAutoRounds:
				stopReason = "rounds"
			case !progress:
				// 这一轮除了改计划什么也没做：不再空转
				auto, stopReason = false, "no-progress"
			}
		}
		steer := len(left) > 0 && steerRounds < MaxSteerRounds
		// 计划没做完就收尾：提醒接着做（autoprogress.go）
		var nudge string
		if hasTools && !stepLimit && !denied && !steer && *finish == "stop" && planNudges < MaxPlanNudges && sinceNudge {
			if open := unfinishedPlan(append(append([]*u.Obj{}, messages[len(tp.Messages):]...), resMsgs...)); len(open) > 0 {
				nudge = planNudge(open)
			}
		}
		stop := c.Err() != nil || (!auto && !steer && nudge == "")
		if stop {
			delete(p.inbox, r.ReqID)
		}
		p.mu.Unlock()
		if stop {
			if stopReason != "" && c.Err() == nil {
				emit(llm.ChatChunk{Type: "delta", Content: autoStoppedNotice(stopReason, autoRounds)})
			}
			// 这一轮实际发出的消息（含中途插入、换轮缩短过的工具结果）+ 最后的回复
			all := WithSteerInserts(append(append([]*u.Obj{}, messages...), resMsgs...), inserts)
			from := len(tp.Messages)
			if from > len(all) {
				from = len(all)
			}
			uu := total
			if total != nil && lastStep != nil {
				cp := *total
				ct := lastStep.PromptTokens + lastStep.CompletionTokens
				cp.ContextTokens = &ct
				growth := breakdown{}
				growth.addMessages(all[from:])
				cp.Breakdown = contextBreakdown(inputBreakdown(tp.Instructions, tp.Tools, tp.Messages, memoryTokens(r.Messages)),
					growth, firstPrompt, ct)
				uu = &cp
			}
			if uu != nil {
				model := p.resolveModel(r)
				if served != nil {
					model = *served
				}
				emit(llm.ChatChunk{Type: "usage", Usage: withRedacted(uu, redacted), Model: &model})
			}
			// 下一轮原样带上
			if hasTools && c.Err() == nil {
				// 这一轮里做过摘要的：记录与最后一次请求一致（摘要 + 之后的步骤），下一轮照发不会又撑满
				if s := StepsJSON(guard.condense(all)[from:]); s != "" {
					emit(llm.ChatChunk{Type: "steps", Steps: s})
				}
			}
			emit(llm.ChatChunk{Type: "done", FinishReason: *finish})
			break
		}
		full := append(append([]*u.Obj{}, messages...), resMsgs...)
		if len(left) > 0 {
			inserts = append(inserts, SteerInsert{At: len(full), Text: strings.Join(left, "\n\n")})
		} else if nudge != "" {
			inserts = append(inserts, SteerInsert{At: len(full), Text: nudge})
		}
		messages = WithSteerInserts(full, inserts)
		if nudge != "" && len(left) == 0 {
			planNudges++
			sinceNudge = false
		} else if auto {
			autoRounds++
			// 换轮时把这一轮里较早的大段工具输出缩短（只在换轮时改一次，前缀缓存每轮只断一次）
			messages = CompactToolResults(messages, len(tp.Messages), compactKeepRecent)
		} else {
			steerRounds++
		}
	}
	return nil
}

// toolErrorCodeDenied：工具体返回的结构化错误（desktop.ToolError 等带 Code 的）是拒绝类
func toolErrorCodeDenied(err any) bool {
	if c, ok := err.(interface{ ToolErrorCode() string }); ok {
		return deniedTool(c.ToolErrorCode())
	}
	return false
}
