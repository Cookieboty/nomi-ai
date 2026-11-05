package assetproto

import (
	"encoding/json"
	"os"
	"testing"
)

// gateway_urls.json：Go GatewayURL 与视图 resolveHostAssetUrl（packages/contract/src/app/index.ts）
// 共用的换址表
func TestGatewayURLTable(t *testing.T) {
	raw, err := os.ReadFile("testdata/gateway_urls.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases [][2]string
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if got := GatewayURL(c[0]); got != c[1] {
			t.Errorf("GatewayURL(%q)=%q want %q", c[0], got, c[1])
		}
	}
}
