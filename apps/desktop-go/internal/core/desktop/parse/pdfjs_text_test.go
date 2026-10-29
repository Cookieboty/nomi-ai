package parse

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// testdata/pdf/expected.json 由 Node 侧 unpdf（pdf.js v6.1.200）extractText 逐页生成，
// 再经 Node 的 trim 处理；Go 端必须逐字节一致（D-B6-8）。
func TestExtractPdfMatchesPdfjs(t *testing.T) {
	raw, err := os.ReadFile("testdata/pdf/expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var want map[string][]string
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	for name, pages := range want {
		b, err := os.ReadFile(filepath.Join("testdata/pdf", name))
		if err != nil {
			t.Fatal(err)
		}
		got := ExtractPdf(b).PageTexts
		if !reflect.DeepEqual(got, pages) {
			t.Errorf("%s: got %q want %q", name, got, pages)
		}
	}
}

func TestPdfjsHelpers(t *testing.T) {
	if got := pdfjsNormalizeUnicode("ﬁ\u00a0x\ufb05\ufb05"); got != "fi xundefined" {
		t.Errorf("normalize %q", got)
	}
	if got := pdfjsBidi("שלום", false); got != "םולש" {
		t.Errorf("bidi %q", got)
	}
	if c := pdfjsCharCategory("a\u0301"); !c.isZeroWidthDiacritic {
		t.Error("diacritic")
	}
	if c := pdfjsCharCategory("\u00a0"); !c.isWhitespace {
		t.Error("ws")
	}
}
