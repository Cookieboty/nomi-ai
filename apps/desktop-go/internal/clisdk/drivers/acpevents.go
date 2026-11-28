package drivers

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type Json = *util.Obj

var kindTool = map[string]string{
	"read": "read_file", "edit": "edit", "delete": "delete_file", "move": "move_file",
	"search": "search", "execute": "run_shell_command", "fetch": "web_fetch", "switch_mode": "exit_plan_mode",
}

func clip(s string, n int) string {
	if clisdk.Len(s) > n {
		return clisdk.Slice0(s, n) + "…"
	}
	return s
}

// strQ = String(v ?? ”)。
func strQ(v any) string {
	if v == nil {
		return ""
	}
	return util.JSString(v)
}

func getp(v any, k string) any {
	if o, ok := v.(*util.Obj); ok {
		return o.Get(k)
	}
	return nil
}

func isSafeLinkScheme(rawURI string) bool {
	u, err := url.Parse(strings.TrimSpace(rawURI))
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "file", "mcp":
		return true
	default:
		return false
	}
}

func formatResourceLinkText(uri, label, desc string) string {
	uri = strings.TrimSpace(uri)
	label = strings.TrimSpace(label)
	desc = strings.TrimSpace(desc)
	if label == "" {
		label = uri
	}
	var out string
	if uri != "" && isSafeLinkScheme(uri) && !strings.ContainsAny(uri, "\r\n") {
		safeLabel := strings.NewReplacer("[", "\\[", "]", "\\]", "\r", " ", "\n", " ").Replace(label)
		safeURI := strings.ReplaceAll(strings.ReplaceAll(uri, " ", "%20"), ")", "%29")
		out = fmt.Sprintf("[%s](%s)", safeLabel, safeURI)
	} else if uri != "" {
		if label != uri {
			out = fmt.Sprintf("`%s (%s)`", label, uri)
		} else {
			out = fmt.Sprintf("`%s`", uri)
		}
	} else {
		out = label
	}
	if desc != "" {
		out += " — " + clip(desc, 300)
	}
	return out
}

func formatSingleContentBlock(b any) (text string, isImage bool) {
	typ := strings.ToLower(strings.TrimSpace(strQ(getp(b, "type"))))
	switch typ {
	case "text":
		if t, ok := getp(b, "text").(string); ok && t != "" {
			return t, false
		}
	case "image":
		return "", true
	case "resource_link":
		uri := firstNonEmptyStr(getp(b, "uri"))
		label := firstNonEmptyStr(getp(b, "name"), getp(b, "title"))
		desc := firstNonEmptyStr(getp(b, "description"))
		return formatResourceLinkText(uri, label, desc), false
	case "resource":
		res := getp(b, "resource")
		if res == nil {
			res = b
		}
		uri := firstNonEmptyStr(getp(res, "uri"), getp(b, "uri"))
		mime := firstNonEmptyStr(getp(res, "mimeType"), getp(b, "mimeType"))
		if txt, ok := getp(res, "text").(string); ok && txt != "" {
			clipped := clip(txt, 4000)
			if uri != "" {
				return fmt.Sprintf("\n```text\n// %s\n%s\n```\n", uri, clipped), false
			}
			return clipped, false
		}
		if uri != "" || mime != "" {
			if mime != "" && uri != "" {
				return fmt.Sprintf("[resource: %s (%s)]", uri, mime), false
			}
			if uri != "" {
				return fmt.Sprintf("[resource: %s]", uri), false
			}
			return fmt.Sprintf("[resource: (%s)]", mime), false
		}
	case "audio":
		mime := firstNonEmptyStr(getp(b, "mimeType"), getp(getp(b, "audio"), "mimeType"))
		if mime != "" {
			return fmt.Sprintf("[audio: %s]", mime), false
		}
		return "[audio]", false
	case "content":
		inner := getp(b, "content")
		if inner != nil {
			return formatSingleContentBlock(inner)
		}
	}
	return "", false
}

func extractContentBlocks(raw any) (text string, imagesMarkdown string) {
	if raw == nil {
		return "", ""
	}
	var items []any
	switch v := raw.(type) {
	case []any:
		items = v
	case []*util.Obj:
		for _, o := range v {
			items = append(items, o)
		}
	case *util.Obj:
		items = []any{v}
	default:
		return "", ""
	}
	var parts []string
	for _, item := range items {
		t, _ := formatSingleContentBlock(item)
		if t != "" {
			parts = append(parts, t)
		}
	}
	text = strings.Join(parts, "")
	if imgs := clisdk.MessageImages(raw); len(imgs) > 0 {
		imagesMarkdown = clisdk.ImageReferenceMarkdown(imgs)
	}
	return text, imagesMarkdown
}

func splitDiffLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func formatUnifiedDiff(path, oldText, newText string, hasOld bool) string {
	path = strings.TrimSpace(path)
	if path == "" {
		path = "file"
	}
	if !hasOld {
		newLines := splitDiffLines(newText)
		var b strings.Builder
		fmt.Fprintf(&b, "--- %s\n+++ %s\n@@ -0,0 +1,%d @@", path, path, len(newLines))
		for _, l := range newLines {
			b.WriteString("\n+")
			b.WriteString(l)
		}
		return b.String()
	}
	oldLines := splitDiffLines(oldText)
	newLines := splitDiffLines(newText)
	pre := 0
	for pre < len(oldLines) && pre < len(newLines) && oldLines[pre] == newLines[pre] {
		pre++
	}
	suf := 0
	for suf < len(oldLines)-pre && suf < len(newLines)-pre &&
		oldLines[len(oldLines)-1-suf] == newLines[len(newLines)-1-suf] {
		suf++
	}
	ctxBefore := pre
	if ctxBefore > 2 {
		ctxBefore = 2
	}
	ctxAfter := suf
	if ctxAfter > 2 {
		ctxAfter = 2
	}
	midOld := oldLines[pre : len(oldLines)-suf]
	midNew := newLines[pre : len(newLines)-suf]
	oldCount := ctxBefore + len(midOld) + ctxAfter
	newCount := ctxBefore + len(midNew) + ctxAfter
	oldStart := pre - ctxBefore + 1
	newStart := pre - ctxBefore + 1
	if oldCount == 0 {
		oldStart = 0
	}
	if newCount == 0 {
		newStart = 0
	}
	var b strings.Builder
	fmt.Fprintf(&b, "--- %s\n+++ %s\n@@ -%d,%d +%d,%d @@", path, path, oldStart, oldCount, newStart, newCount)
	for _, l := range oldLines[pre-ctxBefore : pre] {
		b.WriteString("\n ")
		b.WriteString(l)
	}
	for _, l := range midOld {
		b.WriteString("\n-")
		b.WriteString(l)
	}
	for _, l := range midNew {
		b.WriteString("\n+")
		b.WriteString(l)
	}
	if ctxAfter > 0 {
		sufStart := len(oldLines) - suf
		for _, l := range oldLines[sufStart : sufStart+ctxAfter] {
			b.WriteString("\n ")
			b.WriteString(l)
		}
	}
	return b.String()
}

func contentText(content any) string {
	arr, ok := content.([]any)
	if !ok {
		return ""
	}
	var out []string
	for _, c := range arr {
		switch getp(c, "type") {
		case "content":
			inner := getp(c, "content")
			if t, _ := formatSingleContentBlock(inner); t != "" {
				out = append(out, t)
			}
		case "diff":
			if p, ok := getp(c, "path").(string); ok {
				nt, _ := getp(c, "newText").(string)
				ot, hasOld := getp(c, "oldText").(string)
				if !hasOld {
					ot, hasOld = getp(c, "old_text").(string)
				}
				if nt == "" {
					if v, ok2 := getp(c, "new_text").(string); ok2 {
						nt = v
					}
				}
				out = append(out, formatUnifiedDiff(p, ot, nt, hasOld))
			}
		case "terminal":
			tid := firstNonEmptyStr(getp(c, "terminalId"), getp(c, "id"))
			cmd := firstNonEmptyStr(getp(c, "command"))
			txt := firstNonEmptyStr(getp(c, "output"), getp(c, "text"))
			var header []string
			if cmd != "" {
				header = append(header, "$ "+cmd)
			} else if tid != "" {
				header = append(header, "[terminal "+tid+"]")
			}
			if code, ok := getp(c, "exitCode").(float64); ok {
				header = append(header, fmt.Sprintf("(exit %d)", int(code)))
			}
			var seg string
			if len(header) > 0 {
				seg = strings.Join(header, " ")
			}
			if txt != "" {
				if seg != "" {
					seg += "\n" + txt
				} else {
					seg = txt
				}
			}
			if seg != "" {
				out = append(out, seg)
			}
		default:
			if t, _ := formatSingleContentBlock(c); t != "" {
				out = append(out, t)
			}
		}
	}
	return strings.Join(out, "\n")
}

func rawOutputText(raw any) string {
	if raw == nil {
		return ""
	}
	switch v := raw.(type) {
	case string:
		return v
	case []any:
		return contentText(v)
	case *util.Obj:
		for _, k := range []string{"output", "text", "error"} {
			if s, ok := v.Get(k).(string); ok && s != "" {
				return s
			}
		}
		if c := v.Get("content"); c != nil {
			switch cv := c.(type) {
			case string:
				if cv != "" {
					return cv
				}
			case []any:
				if s := contentText(cv); s != "" {
					return s
				}
			}
		}
		stdout, _ := v.Get("stdout").(string)
		stderr, _ := v.Get("stderr").(string)
		if stdout != "" && stderr != "" {
			return stdout + "\n" + stderr
		}
		if stdout != "" {
			return stdout
		}
		return stderr
	}
	return ""
}

func isWriteFileToolName(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "write_file", "create_file":
		return true
	default:
		return false
	}
}

var (
	agentTitle   = regexp.MustCompile(`(?i)agent|subagent|delegat`)
	identPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,48}$`)
)

func firstWord(title string) string {
	// title.split(/\s/)[0]
	for i, r := range title {
		if isJSSpace(r) {
			return title[:i]
		}
	}
	return title
}

func isJSSpace(r rune) bool { return clisdk.JSTrim(string(r)) == "" }

func normalizeToolIdent(s string) string {
	n := strings.ToLower(strings.TrimSpace(s))
	return strings.NewReplacer("-", "_", " ", "_", "\t", "_").Replace(n)
}

func isFocusToolRawName(name string) bool {
	n := normalizeToolIdent(name)
	return n == "update_focus" || n == "updatefocus"
}

func isFocusToolInput(raw any) bool {
	o, ok := raw.(*util.Obj)
	if !ok || o == nil {
		return false
	}
	return firstNonEmptyStr(o.Get("focus"), o.Get("Focus")) != "" &&
		o.Get("thought") == nil && o.Get("CommandLine") == nil && o.Get("command") == nil &&
		o.Get("Path") == nil && o.Get("path") == nil
}

func isFocusToolCall(rawName, title string, raw any) bool {
	if isFocusToolRawName(rawName) {
		return true
	}
	if rawName == "" {
		if isFocusToolRawName(title) || isFocusToolRawName(firstWord(title)) || isFocusToolInput(raw) {
			return true
		}
	}
	return false
}

func parseUpdateStepsInput(rawName, title string, raw any) ([]any, bool) {
	isSteps := normalizeToolIdent(rawName) == "update_steps"
	o, ok := raw.(*util.Obj)
	if !isSteps && rawName == "" {
		if normalizeToolIdent(title) == "update_steps" {
			isSteps = true
		} else if ok && o != nil {
			if _, isArr := o.Get("steps").([]any); isArr && o.Get("CommandLine") == nil && o.Get("command") == nil {
				isSteps = true
			}
		}
	}
	if !isSteps {
		return nil, false
	}
	if ok && o != nil {
		return parsePlanEntries(o.Get("steps")), true
	}
	return nil, true
}

func isDirOnlyRawInput(raw any) bool {
	o, ok := raw.(*util.Obj)
	if !ok || o == nil {
		return false
	}
	if firstNonEmptyStr(o.Get("DirectoryPath"), o.Get("directoryPath")) == "" {
		return false
	}
	for _, k := range []string{"Path", "path", "file_path", "targetFile", "target_file", "absolutePath", "AbsolutePath"} {
		if firstNonEmptyStr(o.Get(k)) != "" {
			return false
		}
	}
	return true
}

func isWriteFileRawInput(raw any) bool {
	o, ok := raw.(*util.Obj)
	if !ok || o == nil {
		return false
	}
	hasContent := o.Get("Content") != nil || o.Get("CodeContent") != nil || o.Get("file_text") != nil
	if !hasContent {
		return false
	}
	for _, k := range []string{"Target", "TargetContent", "ReplacementChunks", "old_string", "OldString", "edits", "oldText"} {
		if o.Has(k) {
			return false
		}
	}
	return true
}

func isSubagentRawInput(raw any) bool {
	o, ok := raw.(*util.Obj)
	if !ok || o == nil {
		return false
	}
	return firstNonEmptyStr(o.Get("Prompt"), o.Get("prompt")) != "" &&
		firstNonEmptyStr(o.Get("TypeName"), o.Get("Role"), o.Get("subagent_type")) != ""
}

func inferAcpToolName(tcKind, rawName, title string, raw any) string {
	if isFocusToolCall(rawName, title, raw) {
		return "update_focus"
	}
	if rawName != "" {
		if tcKind == "edit" && isWriteFileToolName(rawName) {
			return "write_file"
		}
		if _, mapped := kindTool[tcKind]; !mapped && tcKind != "think" {
			return rawName
		}
		if tcKind == "think" && rawName != "think" {
			if agentTitle.MatchString(rawName) {
				return "invoke_agent"
			}
			return rawName
		}
		return toolName(tcKind, title)
	}
	switch tcKind {
	case "read":
		if strings.HasPrefix(title, "Directory ") || isDirOnlyRawInput(raw) {
			return "list_dir"
		}
		return "read_file"
	case "search":
		if strings.HasSuffix(title, " on Web") {
			return "web_search"
		}
		return "search"
	case "edit":
		if isWriteFileRawInput(raw) {
			return "write_file"
		}
		return "edit"
	case "execute":
		if o, ok := raw.(*util.Obj); ok && o != nil {
			if tn := firstNonEmptyStr(o.Get("tool_name"), o.Get("toolName")); tn != "" {
				return tn
			}
		}
		return "run_shell_command"
	case "switch_mode":
		return "exit_plan_mode"
	default:
		if isSubagentRawInput(raw) || (tcKind == "think" && agentTitle.MatchString(title)) {
			return "invoke_agent"
		}
		if ident := normalizeToolIdent(title); identPattern.MatchString(ident) {
			return ident
		}
		return toolName(tcKind, title)
	}
}

func toolName(kind, title string) string {
	if isFocusToolRawName(firstWord(title)) {
		return "update_focus"
	}
	if kind == "think" && agentTitle.MatchString(title) {
		return "invoke_agent"
	}
	if t, ok := kindTool[kind]; ok {
		return t
	}
	if kind == "think" {
		return "think"
	}
	if w := firstWord(title); w != "" {
		return w
	}
	return "tool"
}

// AcpMapper：ACP 更新 → 事件的映射器。
type AcpMapper interface {
	Update(u Json) []Ev
	Flush() []Ev
	Context() Json
}

type acpMapper struct {
	userText    string
	userImages  []any
	userID      string
	thoughtLen  int
	context     Json
	names       map[string]string
	outputs     map[string]string
	termOutputs map[string]string
	termMeta    map[string]*util.Obj
	msgText     map[string]string
	thoughtText map[string]string
	subagents   map[string]bool
	// inputs：进行中的工具调用最近一次带来的参数（rawInput / 标题 / 位置），做完时 update 里没有就用它。
	// Kimi Code 先用第一段流式参数建 tool_call（只有工具名），开始执行时才用 tool_call_update 补上 rawInput，
	// 做完的那条又只带结果；不记下来，命令就丢了
	inputs          map[string]acpInput
	extractToolName func(u *util.Obj) string
}

type acpInput struct {
	raw   any
	title string
	loc   any
}

// NewAcpMapper：新建 AcpMapper（Gemini 也用它）。
func NewAcpMapper() AcpMapper {
	return NewAcpMapperWithOptions(nil)
}

// NewAcpMapperWithOptions：新建带可选工具名提取钩子的 AcpMapper。
func NewAcpMapperWithOptions(extractToolName func(u *util.Obj) string) AcpMapper {
	return &acpMapper{
		context:         O(),
		names:           map[string]string{},
		outputs:         map[string]string{},
		termOutputs:     map[string]string{},
		termMeta:        map[string]*util.Obj{},
		msgText:         map[string]string{},
		thoughtText:     map[string]string{},
		subagents:       map[string]bool{},
		inputs:          map[string]acpInput{},
		extractToolName: extractToolName,
	}
}

const maxAcpThoughtLen = 20_000

func (m *acpMapper) Flush() []Ev {
	m.thoughtLen = 0
	return []Ev{}
}

func (m *acpMapper) Context() Json { return m.context }

func posNum(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f > 0
}

func nonNegNum(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0
}

// compactTokensAfter：auto_compact_completed 的 tokens_after（兼容驼峰）。
func compactTokensAfter(u Json) (float64, bool) {
	v := u.Get("tokens_after")
	if v == nil {
		v = u.Get("tokensAfter")
	}
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0
}

func normalizePlanStatus(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "in_progress", "inprogress", "in-progress", "running", "active":
		return "in_progress"
	case "completed", "complete", "done":
		return "completed"
	case "failed", "error":
		return "failed"
	case "skipped", "cancelled", "canceled":
		return "skipped"
	default:
		return "pending"
	}
}

func normalizePlanPriority(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "high", "medium", "low":
		return strings.ToLower(strings.TrimSpace(s))
	default:
		return ""
	}
}

func parsePlanEntries(raw any) []any {
	arr, ok := raw.([]any)
	if !ok || len(arr) == 0 {
		return nil
	}
	out := make([]any, 0, len(arr))
	for _, item := range arr {
		var content string
		for _, k := range []string{"content", "title", "step", "text", "description"} {
			if s, ok := getp(item, k).(string); ok {
				if trimmed := strings.TrimSpace(s); trimmed != "" {
					content = trimmed
					break
				}
			}
		}
		if content == "" {
			continue
		}
		entry := O("content", content, "status", normalizePlanStatus(strQ(getp(item, "status"))))
		if prio := normalizePlanPriority(strQ(getp(item, "priority"))); prio != "" {
			entry.Set("priority", prio)
		}
		out = append(out, entry)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func firstNonEmptyStr(vals ...any) string {
	for _, v := range vals {
		if s, ok := v.(string); ok {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func parsePlanUpdate(kind string, u Json) (entries []any, planID, markdown, uri string) {
	if kind == "plan" {
		entries = parsePlanEntries(u.Get("entries"))
		planID = firstNonEmptyStr(u.Get("planId"), u.Get("id"))
		return
	}
	planObj := util.AsObj(u.Get("plan"))
	if planObj != nil {
		planID = firstNonEmptyStr(planObj.Get("planId"), u.Get("planId"), planObj.Get("id"), u.Get("id"))
		entries = parsePlanEntries(planObj.Get("entries"))
		planType := strings.ToLower(strings.TrimSpace(strQ(planObj.Get("type"))))
		if planType == "markdown" || (planType == "" && planObj.Has("content")) {
			markdown = firstNonEmptyStr(planObj.Get("content"), planObj.Get("markdown"))
		} else if planObj.Has("markdown") {
			markdown = firstNonEmptyStr(planObj.Get("markdown"))
		}
		if planType == "file" || (planType == "" && planObj.Has("uri")) {
			uri = firstNonEmptyStr(planObj.Get("uri"))
		}
		return
	}
	planID = firstNonEmptyStr(u.Get("planId"), u.Get("id"))
	entries = parsePlanEntries(u.Get("entries"))
	markdown = firstNonEmptyStr(u.Get("markdown"))
	uri = firstNonEmptyStr(u.Get("uri"))
	return
}

func appendClipped(prev, delta string, limit int) string {
	if delta == "" {
		return prev
	}
	combined := prev + delta
	if clisdk.Len(combined) > limit {
		return clip(combined, limit)
	}
	return combined
}

func (m *acpMapper) appendThought(t string) []Ev {
	if t == "" || m.thoughtLen >= maxAcpThoughtLen {
		return []Ev{}
	}
	rem := maxAcpThoughtLen - m.thoughtLen
	if clisdk.Len(t) > rem {
		t = clisdk.Slice0(t, rem) + "…"
		m.thoughtLen = maxAcpThoughtLen
	} else {
		m.thoughtLen += clisdk.Len(t)
	}
	return []Ev{O("type", "thinking", "text", t)}
}

func parseConfigOptionsDelta(u Json) (model, effort string, optsAny any, has bool) {
	rawOpts := u.Get("configOptions")
	if rawOpts == nil {
		rawOpts = u.Get("config_options")
	}
	var list []any
	if arr, ok := rawOpts.([]any); ok {
		list = arr
	} else if single := util.AsObj(u.Get("configOption")); single != nil {
		list = []any{single}
	} else if u.Has("configId") || u.Has("id") {
		list = []any{u}
	}
	if len(list) == 0 {
		return "", "", nil, false
	}
	for _, item := range list {
		o := util.AsObj(item)
		if o == nil {
			continue
		}
		id := strings.ToLower(strings.TrimSpace(firstNonEmptyStr(o.Get("id"), o.Get("configId"))))
		cat := strings.ToLower(strings.TrimSpace(strQ(o.Get("category"))))
		val := firstNonEmptyStr(o.Get("currentValue"), o.Get("current_value"), o.Get("value"))
		if val == "" {
			continue
		}
		if id == "model" || cat == "model" {
			model = val
		} else if id == "reasoning_effort" || id == "thought_level" || cat == "thought_level" || cat == "reasoning_effort" {
			effort = val
		}
	}
	if model == "" && effort == "" {
		return "", "", nil, false
	}
	return model, effort, list, true
}

func normalizeSubagentStatus(raw string) (terminal bool, status string) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "completed", "complete", "done", "succeeded":
		return true, "completed"
	case "failed", "error":
		return true, "failed"
	case "stopped", "cancelled", "canceled", "aborted":
		return true, "stopped"
	default:
		return false, "running"
	}
}

func (m *acpMapper) Update(u Json) []Ev {
	kind := strQ(u.Get("sessionUpdate"))
	if kind == "user_message_chunk" || kind == "user_message" {
		if m.userID == "" {
			m.userID = clisdk.RandomUUID()
		}
		content := u.Get("content")
		if txt, _ := extractContentBlocks(content); txt != "" {
			m.userText += txt
		}
		m.userImages = append(m.userImages, clisdk.MessageImages(content)...)
		if len(m.userImages) > clisdk.MaxMessageImages {
			m.userImages = m.userImages[:clisdk.MaxMessageImages]
		}
		if len(m.userImages) > 0 {
			return []Ev{O("type", "user-message", "text", m.userText, "images", m.userImages, "sourceId", m.userID)}
		}
		return nil
	}
	if kind == "agent_message_chunk" || kind == "agent_thought_chunk" || kind == "agent_message" || kind == "agent_thought" {
		m.userID = ""
		m.userText = ""
		m.userImages = nil
	}

	// Grok 自动压缩（x.ai 扩展通知）：started → 压缩中；completed → 清状态 + 压缩后的占用；
	// failed / cancelled → 只清状态
	if strings.HasPrefix(kind, "auto_compact_") {
		if kind == "auto_compact_started" {
			return []Ev{O("type", "status", "kind", "compact")}
		}
		if kind != "auto_compact_completed" {
			return []Ev{O("type", "status", "kind", "clear")}
		}
		after, ok := compactTokensAfter(u)
		next := O()
		if ok {
			next = m.context.Clone()
			next.Set("contextTokens", after)
		} else if w := m.context.Get("contextWindow"); w != nil {
			// 没给压缩后的大小：旧占用作废，只留窗口
			next.Set("contextWindow", w)
		}
		m.context = next
		var tok any
		if ok {
			tok = after
		}
		return []Ev{O("type", "status", "kind", "clear"), O("type", "context", "tokens", tok)}
	}
	if kind == "compaction_update" {
		st := strings.ToLower(strings.TrimSpace(firstNonEmptyStr(u.Get("status"), u.Get("state"))))
		msg := firstNonEmptyStr(u.Get("summary"), u.Get("message"), u.Get("text"), u.Get("error"))
		switch st {
		case "started", "in_progress", "running":
			ev := O("type", "status", "kind", "compact")
			if msg != "" {
				ev.Set("text", clip(msg, 200))
			}
			return []Ev{ev}
		case "completed", "complete", "done":
			after, ok := compactTokensAfter(u)
			if !ok {
				after, ok = nonNegNum(u.Get("used"))
			}
			next := O()
			if ok {
				next = m.context.Clone()
				next.Set("contextTokens", after)
			} else if w := m.context.Get("contextWindow"); w != nil {
				next.Set("contextWindow", w)
			}
			m.context = next
			var tok any
			if ok {
				tok = after
			}
			evs := []Ev{O("type", "status", "kind", "clear"), O("type", "context", "tokens", tok)}
			if msg != "" {
				evs = append(evs, O("type", "notice", "tag", "compaction", "text", clip(msg, 1000)))
			}
			return evs
		default:
			evs := []Ev{O("type", "status", "kind", "clear")}
			if msg != "" {
				evs = append(evs, O("type", "notice", "tag", "error", "text", clip(msg, 1000)))
			}
			return evs
		}
	}
	if kind == "agent_thought_chunk" {
		txt, _ := extractContentBlocks(u.Get("content"))
		return m.appendThought(txt)
	}
	if kind == "agent_thought" {
		txt, _ := extractContentBlocks(u.Get("content"))
		if txt == "" {
			return []Ev{}
		}
		msgID := firstNonEmptyStr(u.Get("messageId"), u.Get("id"))
		delta := txt
		if msgID != "" {
			prev := m.thoughtText[msgID]
			if prev != "" && strings.HasPrefix(txt, prev) {
				delta = txt[len(prev):]
			}
			m.thoughtText[msgID] = txt
		}
		return m.appendThought(delta)
	}
	if kind == "usage_update" {
		used, okU := nonNegNum(u.Get("used"))
		size, okS := posNum(u.Get("size"))
		costAmt, okC := nonNegNum(getp(u.Get("cost"), "amount"))
		costCur := strings.TrimSpace(strQ(getp(u.Get("cost"), "currency")))
		hasUsdCost := okC && (costCur == "" || strings.EqualFold(costCur, "USD"))
		m.context = O()
		if okU {
			m.context.Set("contextTokens", used)
		}
		if okS {
			m.context.Set("contextWindow", size)
		}
		if hasUsdCost {
			m.context.Set("costUsd", costAmt)
		}
		if !okU {
			return []Ev{}
		}
		ev := O("type", "context", "tokens", used)
		if okS {
			ev.Set("window", size)
		}
		if hasUsdCost {
			ev.Set("costUsd", costAmt)
		}
		return []Ev{ev}
	}
	if kind == "current_mode_update" {
		modeID := strQ(u.Get("currentModeId"))
		if modeID == "" {
			modeID = strQ(u.Get("modeId"))
		}
		if modeID != "" {
			return []Ev{O("type", "status", "permissionMode", modeID)}
		}
		return []Ev{}
	}
	if kind == "session_info_update" {
		ev := O("type", "session-info")
		if t, ok := u.Get("title").(string); ok {
			if trimmed := strings.TrimSpace(t); trimmed != "" {
				ev.Set("title", trimmed)
			}
		}
		if len(ev.Keys()) > 1 {
			return []Ev{ev}
		}
		return []Ev{}
	}
	if kind == "config_option_update" || kind == "config_options_update" {
		model, effort, optsAny, ok := parseConfigOptionsDelta(u)
		if !ok {
			return []Ev{}
		}
		ev := O("type", "config-update")
		if model != "" {
			ev.Set("model", model)
		}
		if effort != "" {
			ev.Set("effort", effort)
		}
		if optsAny != nil {
			ev.Set("configOptions", optsAny)
		}
		return []Ev{ev}
	}
	if kind == "notice" {
		text := firstNonEmptyStr(u.Get("message"), u.Get("text"))
		if text == "" && u.Get("content") != nil {
			text, _ = extractContentBlocks(u.Get("content"))
		}
		if text == "" {
			return []Ev{}
		}
		tag := firstNonEmptyStr(u.Get("level"), u.Get("severity"), u.Get("tag"))
		if tag == "" {
			tag = "info"
		}
		return []Ev{O("type", "notice", "tag", tag, "text", clip(text, 1000))}
	}
	if kind == "state_update" {
		st := strings.ToLower(strings.TrimSpace(firstNonEmptyStr(u.Get("state"), u.Get("status"))))
		msg := firstNonEmptyStr(u.Get("message"), u.Get("detail"), u.Get("text"))
		switch st {
		case "":
			return []Ev{}
		case "idle":
			return []Ev{O("type", "status", "kind", "clear")}
		case "working", "busy", "running", "waiting":
			if msg != "" {
				return []Ev{O("type", "status", "kind", "working", "text", clip(msg, 200))}
			}
			return []Ev{O("type", "agent-state", "state", st)}
		default:
			ev := O("type", "agent-state", "state", st)
			if msg != "" {
				ev.Set("text", clip(msg, 200))
			}
			return []Ev{ev}
		}
	}
	if kind == "plan" || kind == "plan_update" {
		entries, planID, markdown, uri := parsePlanUpdate(kind, u)
		if len(entries) == 0 && markdown == "" && uri == "" {
			return []Ev{}
		}
		if entries == nil {
			entries = []any{}
		}
		ev := O("type", "plan", "entries", entries)
		if planID != "" {
			ev.Set("planId", planID)
		}
		if markdown != "" {
			ev.Set("markdown", markdown)
		}
		if uri != "" {
			ev.Set("uri", uri)
		}
		return []Ev{ev}
	}
	if kind == "plan_removed" {
		ev := O("type", "plan-removed")
		if planID := firstNonEmptyStr(u.Get("planId"), u.Get("id")); planID != "" {
			ev.Set("planId", planID)
		}
		return []Ev{ev}
	}
	if kind == "subagent_update" {
		sid := firstNonEmptyStr(u.Get("subagentId"), u.Get("agentId"), u.Get("id"))
		if sid == "" {
			return []Ev{}
		}
		terminal, st := normalizeSubagentStatus(firstNonEmptyStr(u.Get("status"), u.Get("state")))
		op := "progress"
		if terminal {
			op = "end"
			delete(m.subagents, sid)
		} else if !m.subagents[sid] {
			op = "start"
			m.subagents[sid] = true
		}
		ev := O("type", "agent", "op", op, "id", sid)
		if terminal {
			ev.Set("status", st)
		}
		if cid := firstNonEmptyStr(u.Get("toolCallId"), u.Get("callId")); cid != "" {
			ev.Set("callId", cid)
		}
		if lbl := firstNonEmptyStr(u.Get("label"), u.Get("title"), u.Get("name")); lbl != "" {
			ev.Set("label", lbl)
		}
		if at := firstNonEmptyStr(u.Get("agentType"), u.Get("role")); at != "" {
			ev.Set("agentType", at)
		}
		if bg, ok := u.Get("background").(bool); ok {
			ev.Set("background", bg)
		}
		if prog := firstNonEmptyStr(u.Get("progress"), u.Get("message")); prog != "" {
			ev.Set("progress", clip(prog, 500))
		}
		if sum := firstNonEmptyStr(u.Get("summary")); sum != "" {
			ev.Set("summary", clip(sum, 2000))
		}
		if uo := util.AsObj(u.Get("usage")); uo != nil {
			usageObj := O()
			if v, ok := nonNegNum(uo.Get("toolUses")); ok {
				usageObj.Set("toolUses", v)
			} else if v, ok := nonNegNum(uo.Get("tool_uses")); ok {
				usageObj.Set("toolUses", v)
			}
			if v, ok := nonNegNum(uo.Get("tokens")); ok {
				usageObj.Set("tokens", v)
			} else if v, ok := nonNegNum(uo.Get("totalTokens")); ok {
				usageObj.Set("tokens", v)
			} else if v, ok := nonNegNum(uo.Get("total_tokens")); ok {
				usageObj.Set("tokens", v)
			}
			if v, ok := nonNegNum(uo.Get("durationMs")); ok {
				usageObj.Set("durationMs", v)
			} else if v, ok := nonNegNum(uo.Get("duration_ms")); ok {
				usageObj.Set("durationMs", v)
			}
			if usageObj.Len() > 0 {
				ev.Set("usage", usageObj)
			}
		}
		return []Ev{ev}
	}
	if kind == "session_message_chunk" || kind == "session_message" {
		pid := firstNonEmptyStr(u.Get("sessionId"), u.Get("subagentId"), u.Get("parentId"))
		if pid == "" {
			return []Ev{}
		}
		txt, imgs := extractContentBlocks(u.Get("content"))
		if txt == "" {
			txt = firstNonEmptyStr(u.Get("text"))
		}
		if imgs != "" {
			if txt != "" {
				txt += "\n\n" + imgs + "\n\n"
			} else {
				txt = imgs + "\n\n"
			}
		}
		if txt == "" {
			return []Ev{}
		}
		itemID := firstNonEmptyStr(u.Get("messageId"), u.Get("itemId"))
		if itemID == "" {
			itemID = pid
		}
		if kind == "session_message_chunk" {
			return []Ev{O("type", "agent-text-delta", "parentId", pid, "itemId", itemID, "text", txt)}
		}
		return []Ev{O("type", "agent-text", "parentId", pid, "itemId", itemID, "text", txt)}
	}

	out := m.Flush()
	if kind == "agent_message_chunk" || kind == "agent_message" {
		txt, images := extractContentBlocks(u.Get("content"))
		if kind == "agent_message" {
			msgID := firstNonEmptyStr(u.Get("messageId"), u.Get("id"))
			if msgID != "" {
				prev := m.msgText[msgID]
				delta := txt
				if prev != "" && strings.HasPrefix(txt, prev) {
					delta = txt[len(prev):]
				}
				m.msgText[msgID] = txt
				txt = delta
			}
		}
		if txt != "" {
			out = append(out, O("type", "text-delta", "text", txt))
		}
		if images != "" {
			out = append(out, O("type", "text-delta", "text", images+"\n\n"))
		}
		return out
	}
	if kind == "tool_call_content_chunk" {
		id := firstNonEmptyStr(u.Get("toolCallId"), u.Get("id"))
		if id == "" {
			return out
		}
		delta := contentText(u.Get("content"))
		if delta == "" && u.Get("content") != nil {
			delta, _ = extractContentBlocks(u.Get("content"))
		}
		if delta == "" {
			delta = firstNonEmptyStr(u.Get("delta"), u.Get("chunk"), u.Get("text"))
		}
		if delta == "" {
			return out
		}
		mergedOut := appendClipped(m.outputs[id], delta, 20_000)
		m.outputs[id] = mergedOut
		name := m.names[id]
		if name == "" {
			name = "tool"
			m.names[id] = name
		}
		ev := O("type", "tool", "name", name, "status", "start", "detail", id, "output", mergedOut)
		if prev, ok := m.inputs[id]; ok {
			if prev.title != "" {
				ev.Set("title", prev.title)
			}
			if prev.raw != nil {
				ev.Set("input", util.Stringify(prev.raw))
			} else if prev.title != "" || prev.loc != nil {
				o := O()
				if prev.title != "" {
					o.Set("description", prev.title)
				}
				if p, ok := getp(prev.loc, "path").(string); ok {
					o.Set("path", p)
				}
				ev.Set("input", util.Stringify(o))
			}
		}
		out = append(out, ev)
		return out
	}
	if kind == "terminal_update" || kind == "terminal_output_chunk" {
		tid := firstNonEmptyStr(u.Get("terminalId"), u.Get("id"))
		if tid == "" {
			return out
		}
		meta := m.termMeta[tid]
		if meta == nil {
			meta = O()
		}
		if cmd := firstNonEmptyStr(u.Get("command")); cmd != "" {
			meta.Set("command", cmd)
		}
		if cwd := firstNonEmptyStr(u.Get("cwd")); cwd != "" {
			meta.Set("cwd", cwd)
		}
		m.termMeta[tid] = meta
		input := util.Stringify(meta)

		if kind == "terminal_output_chunk" {
			delta := firstNonEmptyStr(u.Get("output"), u.Get("chunk"), u.Get("text"), u.Get("data"))
			if delta == "" {
				return out
			}
			mergedOut := appendClipped(m.termOutputs[tid], delta, 20_000)
			m.termOutputs[tid] = mergedOut
			ev := O("type", "tool", "name", "terminal", "status", "start", "detail", "term:"+tid, "output", mergedOut)
			if input != "{}" {
				ev.Set("input", input)
			}
			out = append(out, ev)
			return out
		}

		if chunk := firstNonEmptyStr(u.Get("output"), u.Get("text")); chunk != "" {
			if prev := m.termOutputs[tid]; prev != "" && !strings.HasPrefix(chunk, prev) {
				m.termOutputs[tid] = appendClipped(prev, "\n"+chunk, 20_000)
			} else {
				m.termOutputs[tid] = clip(chunk, 20_000)
			}
		}
		stRaw := strings.ToLower(strings.TrimSpace(strQ(u.Get("status"))))
		st := "start"
		terminal := false
		switch stRaw {
		case "completed", "done", "exited":
			terminal = true
			st = "done"
			if code, ok := u.Get("exitCode").(float64); ok && code != 0 {
				st = "error"
			}
		case "failed", "killed", "error":
			terminal = true
			st = "error"
		}
		ev := O("type", "tool", "name", "terminal", "status", st, "detail", "term:"+tid)
		if input != "{}" {
			ev.Set("input", input)
		}
		if curOut := m.termOutputs[tid]; curOut != "" {
			ev.Set("output", curOut)
		}
		if terminal {
			delete(m.termMeta, tid)
			delete(m.termOutputs, tid)
		}
		out = append(out, ev)
		return out
	}
	if kind == "tool_call" || kind == "tool_call_update" {
		id := strQ(u.Get("toolCallId"))
		if id == "" {
			return out
		}
		title, _ := u.Get("title").(string)
		status := strQ(u.Get("status"))
		terminal := status == "completed" || status == "failed" || status == "cancelled" || status == "canceled"
		var loc any
		if arr, ok := u.Get("locations").([]any); ok && len(arr) > 0 {
			loc = arr[0]
		}
		// 记下这次带来的参数（后来的覆盖先前的），做完时没带就用它
		prev := m.inputs[id]
		if raw := u.Get("rawInput"); isStructured(raw) {
			prev.raw = raw
		}
		if title != "" {
			prev.title = title
		}
		if loc != nil {
			prev.loc = loc
		}
		m.inputs[id] = prev

		chunkOut := contentText(u.Get("content"))
		if chunkOut == "" {
			chunkOut = rawOutputText(u.Get("rawOutput"))
		}
		rawName := strings.TrimSpace(strQ(u.Get("name")))
		if entries, isSteps := parseUpdateStepsInput(rawName, prev.title, prev.raw); isSteps || m.names[id] == "update_steps" {
			m.names[id] = "update_steps"
			if len(entries) > 0 {
				out = append(out, O("type", "plan", "planId", "steps", "entries", entries))
			}
			if terminal {
				delete(m.names, id)
				delete(m.inputs, id)
				delete(m.outputs, id)
			}
			return out
		}
		if !terminal && kind == "tool_call_update" {
			if _, has := m.names[id]; has {
				if chunkOut == "" {
					return out
				}
				m.outputs[id] = clip(chunkOut, 20_000)
			}
		} else if chunkOut != "" && !terminal {
			m.outputs[id] = clip(chunkOut, 20_000)
		}

		name, has := m.names[id]
		if !has {
			tcKind := strQ(u.Get("kind"))
			if m.extractToolName != nil {
				if n := m.extractToolName(u); n != "" {
					name = n
				}
			}
			if name == "" {
				name = inferAcpToolName(tcKind, rawName, title, prev.raw)
			}
		}
		m.names[id] = name
		var input string
		if prev.raw != nil {
			input = util.Stringify(prev.raw)
		} else {
			o := O()
			if prev.title != "" {
				o.Set("description", prev.title)
			}
			if p, ok := getp(prev.loc, "path").(string); ok {
				o.Set("path", p)
			}
			input = util.Stringify(o)
		}
		if terminal {
			prevOut := m.outputs[id]
			delete(m.names, id)
			delete(m.inputs, id)
			delete(m.outputs, id)
			st := "done"
			if status == "failed" || status == "cancelled" || status == "canceled" {
				st = "error"
			}
			ev := O("type", "tool", "name", name, "status", st, "detail", id, "input", input)
			if prev.title != "" {
				ev.Set("title", prev.title)
			}
			outText := chunkOut
			if outText == "" {
				outText = prevOut
			}
			if o := clip(outText, 20_000); o != "" {
				ev.Set("output", o)
			}
			out = append(out, ev)
			if images := clisdk.ImageReferenceMarkdown(clisdk.MessageImages(u.Get("content"))); images != "" {
				out = append(out, O("type", "text-delta", "text", images+"\n\n"))
			}
		} else {
			ev := O("type", "tool", "name", name, "status", "start", "detail", id, "input", input)
			if prev.title != "" {
				ev.Set("title", prev.title)
			}
			if curOut := m.outputs[id]; curOut != "" {
				ev.Set("output", curOut)
			}
			out = append(out, ev)
		}
		return out
	}
	return out
}

// isStructured：rawInput 是对象 / 数组（字符串等不算参数）
func isStructured(v any) bool {
	switch v.(type) {
	case *util.Obj, []any:
		return true
	}
	return false
}

// PickPermissionOption：按允许 / 拒绝选权限选项（"" + false = null）。
func PickPermissionOption(options any, allow bool) (string, bool) {
	list, ok := options.([]any)
	if !ok {
		return "", false
	}
	want := []string{"reject_once", "reject_always"}
	if allow {
		want = []string{"allow_once", "allow_always"}
	}
	for _, k := range want {
		for _, o := range list {
			if o == nil { // JS：null/undefined 元素上读 .kind 抛 TypeError
				panic(clisdk.JSThrow{Name: "TypeError", Message: "Cannot read properties of " + nullName(o) + " (reading 'kind')"})
			}
			if getp(o, "kind") == k {
				if id, ok := getp(o, "optionId").(string); ok {
					return id, true
				}
			}
		}
	}
	return "", false
}

// PermissionSummary：权限请求的摘要文案。
func PermissionSummary(params Json) string {
	call := params.Get("toolCall")
	title, ok := getp(call, "title").(string)
	if !ok {
		title = "tool"
	}
	var loc any
	if arr, ok := getp(call, "locations").([]any); ok && len(arr) > 0 {
		loc = arr[0]
	}
	if p, ok := getp(loc, "path").(string); ok {
		return clip(title+": "+p, 200)
	}
	return clip(title, 200)
}

var NewGeminiMapper = NewAcpMapper

// nullName：Go nil 无法区分 null/undefined；JSON 来源的数组元素只可能是 null。
func nullName(any) string { return "null" }
