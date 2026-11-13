package models

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func objOf(js string) *u.Obj {
	v, err := u.ParseString(js)
	if err != nil {
		panic(err)
	}
	return v.(*u.Obj)
}

func TestStandardOf(t *testing.T) {
	// 成本分档里的标准窗口优先（Claude 200K、GPT 272K），不改成通用 256K
	claude := objOf(`{"limit":{"context":1000000},"cost":{"tiers":[{"tier":{"type":"context","size":200000}}]}}`)
	if s, ok := standardOf(claude); !ok || s != 200_000 {
		t.Fatalf("claude tier %v %v", s, ok)
	}
	gpt := objOf(`{"limit":{"context":1050000,"input":922000},"cost":{"tiers":[{"tier":{"type":"context","size":272000}}]}}`)
	if s, ok := standardOf(gpt); !ok || s != 272_000 {
		t.Fatalf("gpt tier %v %v", s, ok)
	}
	// 窗口大于 256K 且没有分档：通用标准档
	big := objOf(`{"limit":{"context":1048576,"output":393216}}`)
	if s, ok := standardOf(big); !ok || s != GenericStandard {
		t.Fatalf("generic %v %v", s, ok)
	}
	// 真实窗口不大于 256K：不分档
	small := objOf(`{"limit":{"context":163840,"output":16000}}`)
	if s, ok := standardOf(small); ok || s != 0 {
		t.Fatalf("small %v %v", s, ok)
	}
	// input 优先于 context，且 input 本身不超过 256K 时不补通用档
	inputSmall := objOf(`{"limit":{"context":1000000,"input":128000}}`)
	if s, ok := standardOf(inputSmall); ok || s != 0 {
		t.Fatalf("input small %v %v", s, ok)
	}
}
