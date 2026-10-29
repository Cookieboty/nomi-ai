package llm

import (
	"encoding/base64"
	"math"
	"strings"
)

// Ports of provider-utils detect-media-type.ts / resolve-full-media-type.ts /
// uint8-utils.ts.

type sig struct {
	mt     string
	prefix []int // -1 = any byte
}

var (
	imageSigs = []sig{
		{"image/gif", []int{0x47, 0x49, 0x46, 0x38, 0x37, 0x61}},
		{"image/gif", []int{0x47, 0x49, 0x46, 0x38, 0x39, 0x61}},
		{"image/png", []int{0x89, 0x50, 0x4e, 0x47}},
		{"image/jpeg", []int{0xff, 0xd8}},
		{"image/webp", []int{0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50}},
		{"image/bmp", []int{0x42, 0x4d, -1, -1, -1, -1, 0, 0, 0, 0}},
		{"image/tiff", []int{0x49, 0x49, 0x2a, 0}},
		{"image/tiff", []int{0x4d, 0x4d, 0, 0x2a}},
		{"image/avif", []int{0, 0, 0, -1, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66}},
		{"image/heic", []int{0, 0, 0, -1, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63}},
	}
	docSigs        = []sig{{"application/pdf", []int{0x25, 0x50, 0x44, 0x46}}}
	audioSigsNoMp4 = []sig{
		{"audio/aac", []int{0xff, 0xf0}}, {"audio/aac", []int{0xff, 0xf1}},
		{"audio/aac", []int{0xff, 0xf8}}, {"audio/aac", []int{0xff, 0xf9}},
		{"audio/mpeg", []int{0xff, 0xfb}}, {"audio/mpeg", []int{0xff, 0xfa}},
		{"audio/mpeg", []int{0xff, 0xf3}}, {"audio/mpeg", []int{0xff, 0xf2}},
		{"audio/mpeg", []int{0xff, 0xe3}}, {"audio/mpeg", []int{0xff, 0xe2}},
		{"audio/wav", []int{0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x41, 0x56, 0x45}},
		{"audio/ogg", []int{0x4f, 0x67, 0x67, 0x53}},
		{"audio/flac", []int{0x66, 0x4c, 0x61, 0x43}},
		{"audio/aac", []int{0x40, 0x15, 0, 0}},
		{"audio/webm", []int{0x1a, 0x45, 0xdf, 0xa3}},
	}
	audioSigs = append(append([]sig{}, audioSigsNoMp4...), sig{"audio/mp4", []int{0, 0, 0, -1, 0x66, 0x74, 0x79, 0x70}})
	videoSigs = []sig{
		{"video/mp4", []int{0, 0, 0, -1, 0x66, 0x74, 0x79, 0x70}},
		{"video/webm", []int{0x1a, 0x45, 0xdf, 0xa3}},
		{"video/quicktime", []int{0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74}},
		{"video/x-msvideo", []int{0x52, 0x49, 0x46, 0x46}},
	}
)

// Base64ToBytes is convertBase64ToUint8Array (base64url tolerated).
func Base64ToBytes(s string) []byte {
	s = strings.NewReplacer("-", "+", "_", "/").Replace(s)
	s = strings.TrimRight(s, "=")
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return nil
	}
	return b
}

// ToBase64 is convertToBase64 (strings pass through).
func ToBase64(d FileData) string {
	if d.IsString {
		return d.Base64
	}
	return base64.StdEncoding.EncodeToString(d.Bytes)
}

func decodePrefix(d FileData, max int) []byte {
	if !d.IsString {
		if len(d.Bytes) > max {
			return d.Bytes[:max]
		}
		return d.Bytes
	}
	n := int(math.Ceil(float64(max)/3)) * 4
	s := d.Base64
	if len(s) > n {
		s = s[:n]
	}
	b := Base64ToBytes(s)
	if len(b) > max {
		b = b[:max]
	}
	return b
}

func detectBySigs(d FileData, sigs []sig) string {
	b := decodePrefix(d, 18)
	if len(b) > 10 && b[0] == 0x49 && b[1] == 0x44 && b[2] == 0x33 {
		full := decodePrefix(d, 128*1024+12)
		size := int(full[6]&0x7f)<<21 | int(full[7]&0x7f)<<14 | int(full[8]&0x7f)<<7 | int(full[9]&0x7f)
		if size+10 <= len(full) {
			b = full[size+10:]
		} else {
			b = nil
		}
	}
	for _, s := range sigs {
		if len(b) < len(s.prefix) {
			continue
		}
		ok := true
		for i, p := range s.prefix {
			if p >= 0 && int(b[i]) != p {
				ok = false
				break
			}
		}
		if ok {
			return s.mt
		}
	}
	return ""
}

// DetectMediaType is detectMediaType ("" = undefined).
func DetectMediaType(d FileData, topLevel *string) string {
	if topLevel == nil {
		all := append(append(append(append([]sig{}, imageSigs...), docSigs...), audioSigsNoMp4...), videoSigs...)
		return detectBySigs(d, all)
	}
	switch *topLevel {
	case "image":
		return detectBySigs(d, imageSigs)
	case "audio":
		return detectBySigs(d, audioSigs)
	case "video":
		return detectBySigs(d, videoSigs)
	case "application":
		return detectBySigs(d, docSigs)
	}
	return ""
}

// TopLevelMediaType is getTopLevelMediaType.
func TopLevelMediaType(mt string) string {
	if i := strings.IndexByte(mt, '/'); i >= 0 {
		return mt[:i]
	}
	return mt
}

// IsFullMediaType is isFullMediaType.
func IsFullMediaType(mt string) bool {
	i := strings.IndexByte(mt, '/')
	if i < 0 {
		return false
	}
	sub := mt[i+1:]
	return sub != "" && sub != "*"
}

// ResolveFullMediaType is resolveFullMediaType.
func ResolveFullMediaType(p Part) (string, error) {
	if IsFullMediaType(p.MediaType) {
		return p.MediaType, nil
	}
	if p.Data.Type == "data" {
		tl := TopLevelMediaType(p.MediaType)
		if mt := DetectMediaType(p.Data, &tl); mt != "" {
			return mt, nil
		}
		return "", NewUnsupported(`file of media type "` + p.MediaType + `" must specify subtype since it could not be auto-detected`)
	}
	return "", NewUnsupported(`file of media type "` + p.MediaType + `" must specify subtype since it is not passed as inline bytes`)
}
