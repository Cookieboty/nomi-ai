package parse

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/jsjson"
)

func jsonMarshal(v any) ([]byte, error) { return []byte(jsjson.Stringify(v)), nil }
