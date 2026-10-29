package knowledge

import (
	"bytes"
	"io"
	"strconv"
)

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func strconvItoa(i int) string { return strconv.Itoa(i) }
