package tray

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// 与 apps/desktop-electron/tests/unit/core/TrayManager.test.ts 的 gatewayMenuEntries 用例相同
func viewOf(t *testing.T, raw string) View {
	t.Helper()
	var v any
	if err := jsonUnmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return ParseView(v)
}

func TestGatewayMenuEntriesRecent(t *testing.T) {
	v := viewOf(t, `{
	  "providers": [
	    {"id":"ds","name":"DS","enabled":true,"models":[{"id":"flash","enabled":true},{"id":"pro","enabled":true}]},
	    {"id":"kimi","name":"KIMI","enabled":true,"models":[{"id":"k3","enabled":true}]},
	    {"id":"off","name":"OFF","enabled":false,"models":[{"id":"x","enabled":true}]}
	  ],
	  "clients": {"nomi": {"models": {"main": "ds/pro"}}},
	  "recentNomi": ["kimi/k3", "ds/pro", "off/x", "ds/gone", "ds/flash"]
	}`)
	got := GatewayMenuEntries(v, i18n.T)
	want := []Entry{
		{ID: "ds", Label: "DS · pro", Checked: true, Ref: "ds/pro"},
		{ID: "kimi", Label: "KIMI · k3", Ref: "kimi/k3"},
		{ID: "ds", Label: "DS · flash", Ref: "ds/flash"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestGatewayMenuEntriesWithoutHistory(t *testing.T) {
	v := viewOf(t, `{
	  "providers": [
	    {"id":"kimi","name":"KIMI","enabled":true,"models":[{"id":"embed","enabled":true,"toolCalling":false},{"id":"k3","enabled":true}]},
	    {"id":"empty","name":"EMPTY","enabled":true,"models":[{"id":"y","enabled":false}]}
	  ],
	  "clients": {"nomi": {"models": {}}}
	}`)
	got := GatewayMenuEntries(v, i18n.T)
	want := []Entry{{ID: "kimi", Label: "KIMI · k3", Ref: "kimi/k3"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestMenuLayout(t *testing.T) {
	var gestured string
	items := Menu(Deps{
		T: i18n.T, TName: i18n.TName,
		State:         func() any { return map[string]any{} },
		CharacterName: func() string { return "Ab" },
		Gesture:       func(n string) { gestured = n },
	})
	if len(items) != 10 || !items[1].Separator || !items[2].Disabled {
		t.Fatalf("layout: %+v", items)
	}
	motions := items[6]
	if len(motions.Submenu) != len(Motions) {
		t.Fatalf("motions: %+v", motions)
	}
	motions.Submenu[0].Click()
	if gestured != "wave" {
		t.Fatalf("gesture %q", gestured)
	}
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }
