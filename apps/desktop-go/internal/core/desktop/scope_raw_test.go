package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

// Node 直接沿用 JSON.parse 出来的 scope 对象：未知字段、键序、原始值写回时保持不变
func TestScopeUnknownFieldsRoundTrip(t *testing.T) {
	f := filepath.Join(t.TempDir(), "settings.json")
	in := `{"scopes":[{"path":"/tmp/x","note":"keep","id":"a","grantedAt":"1","mode":"read","kind":"folder"}],"policies":{},"localOnly":false,"cloudAcked":[]}`
	_ = os.WriteFile(f, []byte(in), 0o600)
	b := NewPermissionBroker(f, GuardEnv{Platform: "linux"}, BrokerOpts{})
	b.Grant("/tmp/x", "read-write", "folder", false)
	got, _ := os.ReadFile(f)
	want := "{\n  \"scopes\": [\n    {\n      \"path\": \"/tmp/x\",\n      \"note\": \"keep\",\n      \"id\": \"a\",\n      \"grantedAt\": \"1\",\n      \"mode\": \"read-write\",\n      \"kind\": \"folder\"\n    }\n  ],\n  \"policies\": {},\n  \"localOnly\": false,\n  \"cloudAcked\": []\n}"
	if string(got) != want {
		t.Fatalf("got\n%s", got)
	}
}
