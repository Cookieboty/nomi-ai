package privacy

import (
	"encoding/json"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Goldens from Node: [units(raw), units(JSON.parse('"'+raw+'"')) | null].
const unescapeGoldens = `[[[97,92,117,100,56,48,48,98],[97,55296,98]],[[92,117,100,101,48,48,92,117,100,56,51,100],[56832,55357]],[[55296,92,110],[55296,10]],[[120,92,113],null],[[120,92,117,49,50,103,52],null],[[97,34,98],null],[[116,97,98,9,92,110],null],[[92,117,48,48,101,57,92,47],[233,47]],[[92],null],[[92,117,68,56,51,68,92,117,68,69,48,48],[55357,56832]]]`

func TestJSONStringUnitsGoldens(t *testing.T) {
	var cases [][2][]uint16
	if err := json.Unmarshal([]byte(unescapeGoldens), &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		got, ok := jsonStringUnits(u.Units(c[0]))
		if (c[1] == nil) == ok || (ok && u.FromUnits(got) != u.FromUnits(u.Units(c[1]))) {
			t.Errorf("case %d: got %v %v want %v", i, got, ok, c[1])
		}
	}
}
