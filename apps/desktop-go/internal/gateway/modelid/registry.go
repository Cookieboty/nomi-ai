package modelid

import "sync"

// Sample is one upstream response's model, plus the names we asked for.
type Sample struct {
	Response  string
	Requested []string
	At        int64 // unix milliseconds
}

var (
	regMu sync.Mutex
	reg   = map[string]Sample{}
	regQ  []string
)

const regCap = 256

// Note remembers the latest response model for a turn or tab. Later samples
// replace earlier ones. Empty responses are ignored.
func Note(key string, s Sample) {
	if key == "" {
		return
	}
	s.Response = Clip(s.Response, 200)
	if s.Response == "" {
		return
	}
	regMu.Lock()
	defer regMu.Unlock()
	if _, ok := reg[key]; ok {
		for i, k := range regQ {
			if k == key {
				regQ = append(regQ[:i], regQ[i+1:]...)
				break
			}
		}
	}
	reg[key] = s
	regQ = append(regQ, key)
	for len(regQ) > regCap {
		delete(reg, regQ[0])
		regQ = regQ[1:]
	}
}

// Latest returns the newest sample for key.
func Latest(key string) (Sample, bool) {
	regMu.Lock()
	defer regMu.Unlock()
	s, ok := reg[key]
	return s, ok
}
