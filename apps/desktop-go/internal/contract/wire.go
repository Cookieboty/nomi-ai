package contract

import (
	"encoding/base64"
	"encoding/json"
)

// Bytes 在线上编成 {"$u8":"<base64>"}（wire.ts）
type Bytes []byte

func (b Bytes) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"$u8": base64.StdEncoding.EncodeToString(b)})
}

func (b *Bytes) UnmarshalJSON(d []byte) error {
	var m map[string]string
	if err := json.Unmarshal(d, &m); err != nil {
		return err
	}
	v, err := base64.StdEncoding.DecodeString(m["$u8"])
	*b = v
	return err
}

func EncodeWire(f ServerFrame) ([]byte, error) { return json.Marshal(f) }
