package hostports

import (
	"reflect"
	"testing"
)

func TestEnvLanguages(t *testing.T) {
	t.Setenv("LANGUAGE", "en_GB:fr")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "zh_CN.UTF-8")
	if got := envLanguages(); !reflect.DeepEqual(got, []string{"en-GB", "fr", "zh-CN"}) {
		t.Fatalf("got %v", got)
	}
	t.Setenv("LANGUAGE", "")
	t.Setenv("LANG", "C.UTF-8")
	if got := envLanguages(); len(got) != 0 {
		t.Fatalf("C locale should be ignored, got %v", got)
	}
}

func TestSystemLanguagesHonorsCDLocale(t *testing.T) {
	t.Setenv("CD_LOCALE", "en")
	if got := SystemLanguages(); !reflect.DeepEqual(got, []string{"en"}) {
		t.Fatalf("got %v", got)
	}
}
