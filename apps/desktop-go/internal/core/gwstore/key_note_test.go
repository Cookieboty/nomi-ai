package gwstore

import (
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Key 备注：有 note 才动；去首尾空白，空串清除，超长截断；没带 note 时保留原来的
func TestKeyNote(t *testing.T) {
	key := u.NewObj("id", "k1", "note", "旧备注")
	if got := withLimits(key, u.NewObj()).Get("note"); got != "旧备注" {
		t.Fatalf("note kept when absent: %v", got)
	}
	if got := withLimits(key, u.NewObj("note", "  公司账号，月底到期  ")).Get("note"); got != "公司账号，月底到期" {
		t.Fatalf("trimmed note: %v", got)
	}
	if withLimits(key, u.NewObj("note", "   ")).Has("note") {
		t.Fatal("blank note clears it")
	}
	long := strings.Repeat("备", maxKeyNote+10)
	if got, _ := withLimits(key, u.NewObj("note", long)).Get("note").(string); len([]rune(got)) != maxKeyNote {
		t.Fatalf("note capped at %d runes, got %d", maxKeyNote, len([]rune(got)))
	}
	if key.Get("note") != "旧备注" {
		t.Fatal("input key must not be mutated")
	}
}
