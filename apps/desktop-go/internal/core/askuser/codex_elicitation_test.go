package askuser

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestCodexUserInputRoundTrip(t *testing.T) {
	raw := util.NewObj("threadId", "th", "questions", []any{
		util.NewObj("id", "confirm_path", "header", "Confirm", "question", "Proceed?", "options", []any{
			util.NewObj("label", "Yes", "description", "Go on"),
			util.NewObj("label", "No", "description", "Stop"),
		}),
		util.NewObj("id", "secret_one", "question", "口令？", "isSecret", true),
		util.NewObj("id", "note", "header", "Note", "question", "Anything else?"),
	})
	in, ok := QuestionsFromCodex(raw)
	if !ok || len(in.Questions) != 2 || in.IDs[0] != "confirm_path" || in.IDs[1] != "note" {
		t.Fatalf("parsed = %+v %+v ok=%v", in.Questions, in.IDs, ok)
	}
	if in.Questions[0].Header != "Confirm" || in.Questions[0].Options[0].ID != "a" || in.Questions[0].Options[0].Label != "Yes" {
		t.Fatalf("question = %+v", in.Questions[0])
	}
	if len(in.Questions[1].Options) != 0 {
		t.Fatal("freeform question should have no options")
	}
	if _, ok := QuestionsFromCodex(util.NewObj("command", "ls")); ok {
		t.Fatal("a command approval is not a question")
	}

	body, cancel := CodexUserInputResult(in, Result{
		Action: ActionAnswer,
		Answers: []Answer{
			{QuestionID: "q1", Selected: []string{"a"}},
			{QuestionID: "q2", Custom: "ship it"},
		},
		Details: "after lunch",
	})
	if cancel {
		t.Fatal("an answer is not a cancel")
	}
	if util.Stringify(body) != `{"answers":{"confirm_path":{"answers":["Yes","user_note: after lunch"]},"note":{"answers":["ship it"]}}}` {
		t.Fatal(util.Stringify(body))
	}

	skipped, cancel := CodexUserInputResult(in, Result{Action: ActionSkip})
	if cancel || util.Stringify(skipped) != `{"answers":{}}` {
		t.Fatalf("skip = %s cancel=%v", util.Stringify(skipped), cancel)
	}
	timed, cancel := CodexUserInputResult(in, Result{Action: ActionTimeout})
	if cancel || util.Stringify(timed) != `{"answers":{}}` {
		t.Fatalf("timeout = %s cancel=%v", util.Stringify(timed), cancel)
	}
	if _, cancel := CodexUserInputResult(in, Result{Action: ActionCancel}); !cancel {
		t.Fatal("cancel should not submit answers")
	}
}

func TestElicitationFormRoundTrip(t *testing.T) {
	schema := util.NewObj("type", "object", "required", []any{"strategy", "count"}, "properties", util.NewObj(
		"strategy", util.NewObj("type", "string", "title", "Strategy", "enum", []any{"conservative", "balanced"}),
		"count", util.NewObj("type", "integer", "title", "Count", "description", "How many"),
		"tags", util.NewObj("type", "array", "title", "Tags", "items", util.NewObj("type", "string", "enum", []any{"a", "b"})),
		"note", util.NewObj("type", "string", "title", "Note"),
	))
	params := util.NewObj("sessionId", "s1", "mode", "form", "message", "How should I refactor?", "requestedSchema", schema)
	form, ok := QuestionsFromElicitation(params)
	if !ok || len(form.Questions) != 4 {
		t.Fatalf("form %+v ok=%v", form.Questions, ok)
	}
	if form.Questions[0].ID != "q1" || form.Questions[0].Prompt != "How should I refactor?\nStrategy" {
		t.Fatalf("first = %+v", form.Questions[0])
	}
	if form.Questions[0].Options[1].Label != "balanced" || form.fields[0].values[1] != "balanced" {
		t.Fatalf("strategy = %+v values=%v", form.Questions[0], form.fields[0].values)
	}
	byName := map[string]int{}
	for i, f := range form.fields {
		byName[f.name] = i
	}
	count := form.Questions[byName["count"]]
	if count.Header != "Count" || count.Prompt == "" || len(count.Options) != 0 {
		t.Fatalf("count = %+v", count)
	}

	res := Result{Action: ActionAnswer, Answers: []Answer{
		{QuestionID: form.Questions[byName["strategy"]].ID, Selected: []string{"b"}},
		{QuestionID: form.Questions[byName["count"]].ID, Custom: "3"},
		{QuestionID: form.Questions[byName["tags"]].ID, Selected: []string{"a", "b"}},
		{QuestionID: form.Questions[byName["note"]].ID, Custom: "later"},
	}, Details: "please"}
	body := ElicitationResult(form, res)
	if util.Stringify(body) != `{"action":"accept","content":{"strategy":"balanced","count":3,"tags":["a","b"],"note":"later\n补充：please"}}` {
		t.Fatal(util.Stringify(body))
	}
	if got := util.Stringify(ElicitationResult(form, Result{Action: ActionSkip})); got != `{"action":"decline","content":null}` {
		t.Fatal("skip", got)
	}
	if got := util.Stringify(ElicitationResult(form, Result{Action: ActionCancel})); got != `{"action":"cancel","content":null}` {
		t.Fatal("cancel", got)
	}
	if got := util.Stringify(ElicitationResult(form, Result{Action: ActionTimeout})); got != `{"action":"cancel","content":null}` {
		t.Fatal("timeout", got)
	}

	wrapped := util.NewObj("threadId", "th", "serverName", "tools", "request", params)
	if _, ok := QuestionsFromElicitation(wrapped); !ok {
		t.Fatal("codex wraps the form in request")
	}
	approval := util.NewObj("request", util.NewObj("mode", "form", "message", "Allow?", "meta", util.NewObj("codex_approval_kind", "mcp_tool_call"), "requestedSchema", schema))
	if !ElicitationIsApproval(approval) {
		t.Fatal("tool approval should be detected")
	}
	if _, ok := QuestionsFromElicitation(approval); ok {
		t.Fatal("tool approval is not a question card")
	}
	if _, ok := QuestionsFromElicitation(util.NewObj("mode", "url", "url", "https://example.com", "message", "Sign in")); ok {
		t.Fatal("url mode is not a form")
	}
	bad := util.NewObj("mode", "form", "requestedSchema", util.NewObj("type", "object", "required", []any{"token"}, "properties", util.NewObj(
		"token", util.NewObj("type", "object"),
	)))
	if _, ok := QuestionsFromElicitation(bad); ok {
		t.Fatal("a required unknown type cannot be rendered")
	}

	oneOf := util.NewObj("mode", "form", "message", "Pick", "requestedSchema", util.NewObj(
		"type", "object", "properties", util.NewObj("style", util.NewObj("type", "string", "oneOf", []any{
			util.NewObj("const", "plain", "title", "Plain"),
			util.NewObj("const", "rich", "title", "Rich"),
		})),
	))
	picked, ok := QuestionsFromElicitation(oneOf)
	if !ok || picked.Questions[0].Options[0].Label != "Plain" || picked.fields[0].values[0] != "plain" {
		t.Fatalf("oneOf = %+v values=%v ok=%v", picked.Questions, picked.fields, ok)
	}
	got := ElicitationResult(picked, Result{Action: ActionAnswer, Answers: []Answer{{QuestionID: "q1", Selected: []string{"a"}}}})
	if util.Stringify(got) != `{"action":"accept","content":{"style":"plain"}}` {
		t.Fatal(util.Stringify(got))
	}
	flag, ok := QuestionsFromElicitation(util.NewObj("mode", "form", "requestedSchema", util.NewObj(
		"type", "object", "properties", util.NewObj("ok", util.NewObj("type", "boolean", "title", "Proceed")),
	)))
	if !ok {
		t.Fatal("bool field")
	}
	yes := ElicitationResult(flag, Result{Action: ActionAnswer, Answers: []Answer{{QuestionID: "q1", Selected: []string{"a"}}}})
	if util.Stringify(yes) != `{"action":"accept","content":{"ok":true}}` {
		t.Fatal(util.Stringify(yes))
	}
}

// enum 原值（首尾空白、超长）必须原样回传，只有显示标签被修整（#359）
func TestElicitationEnumKeepsRawValues(t *testing.T) {
	long := strings.Repeat("x", maxLabel+50)
	params := util.NewObj("mode", "form", "message", "Pick", "requestedSchema", util.NewObj(
		"type", "object", "properties", util.NewObj(
			"mode", util.NewObj("type", "string", "enum", []any{" padded ", long}),
			"tags", util.NewObj("type", "array", "items", util.NewObj("type", "string", "enum", []any{"  a", long})),
		),
	))
	form, ok := QuestionsFromElicitation(params)
	if !ok || len(form.Questions) != 2 {
		t.Fatalf("form %+v ok=%v", form.Questions, ok)
	}
	byName := map[string]int{}
	for i, f := range form.fields {
		byName[f.name] = i
	}
	mq := form.Questions[byName["mode"]]
	if mq.Options[0].Label != "padded" || len([]rune(mq.Options[1].Label)) > maxLabel {
		t.Fatalf("labels = %+v", mq.Options)
	}
	res := Result{Action: ActionAnswer, Answers: []Answer{
		{QuestionID: mq.ID, Selected: []string{"a"}},
		{QuestionID: form.Questions[byName["tags"]].ID, Selected: []string{"a", "b"}},
	}}
	content, _ := ElicitationResult(form, res).Get("content").(*util.Obj)
	if content == nil || content.Get("mode") != " padded " {
		t.Fatalf("mode = %q", util.Stringify(content))
	}
	tags, _ := content.Get("tags").([]any)
	if len(tags) != 2 || tags[0] != "  a" || tags[1] != long {
		t.Fatalf("tags = %v", tags)
	}
	res.Answers[0].Selected = []string{"b"}
	content, _ = ElicitationResult(form, res).Get("content").(*util.Obj)
	if content.Get("mode") != long {
		t.Fatal("long enum value was clipped")
	}
}
