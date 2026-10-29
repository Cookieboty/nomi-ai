package edge

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ChromiumFullVersion = CHROMIUM_FULL_VERSION
const ChromiumFullVersion = "143.0.3650.75"

var major = strings.Split(ChromiumFullVersion, ".")[0]

// SecMsGecVersion = SEC_MS_GEC_VERSION
var SecMsGecVersion = "2-" + ChromiumFullVersion

// OutputFormat = OUTPUT_FORMAT
const OutputFormat = "audio-24khz-48kbitrate-mono-mp3"

const base = "speech.platform.bing.com/consumer/speech/synthesize/readaloud"

var userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/" + major + ".0.0.0 Safari/537.36 Edg/" + major + ".0.0.0"

// 测试可替换：randomUUID / randomBytes(16)
var (
	RandomUUID = func() string {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		b[6] = b[6]&0x0f | 0x40
		b[8] = b[8]&0x3f | 0x80
		h := hex.EncodeToString(b)
		return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
	}
	RandomBytes16 = func() []byte {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		return b
	}
)

func hexID() string { return strings.ReplaceAll(RandomUUID(), "-", "") }
func muidCookie() string {
	return "muid=" + strings.ToUpper(hex.EncodeToString(RandomBytes16())) + ";"
}

// SynthesisURL = synthesisUrl(unixSeconds)
func SynthesisURL(unixSeconds float64) string {
	return "wss://" + base + "/edge/v1?TrustedClientToken=" + TrustedClientToken +
		"&ConnectionId=" + hexID() + "&Sec-MS-GEC=" + SecMsGec(unixSeconds) +
		"&Sec-MS-GEC-Version=" + SecMsGecVersion
}

// VoicesURL = voicesUrl(unixSeconds)
func VoicesURL(unixSeconds float64) string {
	return "https://" + base + "/voices/list?trustedclienttoken=" + TrustedClientToken +
		"&Sec-MS-GEC=" + SecMsGec(unixSeconds) + "&Sec-MS-GEC-Version=" + SecMsGecVersion
}

// Header 是有序的头列表（与 Node 对象字面量顺序一致）
type Header [][2]string

// SocketHeaders = socketHeaders()
func SocketHeaders() Header {
	return Header{
		{"User-Agent", userAgent},
		{"Accept-Encoding", "gzip, deflate, br, zstd"},
		{"Accept-Language", "en-US,en;q=0.9"},
		{"Pragma", "no-cache"},
		{"Cache-Control", "no-cache"},
		{"Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"},
		{"Cookie", muidCookie()},
	}
}

// HTTPHeaders = httpHeaders()
func HTTPHeaders() Header {
	return Header{
		{"User-Agent", userAgent},
		{"Accept-Language", "en-US,en;q=0.9"},
		{"Accept", "*/*"},
		{"Sec-CH-UA", `" Not;A Brand";v="99", "Microsoft Edge";v="` + major + `", "Chromium";v="` + major + `"`},
		{"Sec-CH-UA-Mobile", "?0"},
		{"Sec-Fetch-Site", "none"},
		{"Sec-Fetch-Mode", "cors"},
		{"Sec-Fetch-Dest", "empty"},
		{"Cookie", muidCookie()},
	}
}

// JSDateString = new Date(t).toString()（V8：`Thu Oct 29 2026 09:30:00 GMT+0800 (China Standard Time)`）。
// 括号里的时区长名来自 ICU；Go 没有 ICU，按 IANA 名查表，查不到用 ICU 的回退写法 `GMT+08:00`（D-B9-4）。
func JSDateString(t time.Time) string {
	t = t.In(time.Local)
	_, off := t.Zone()
	sign := '+'
	if off < 0 {
		sign = '-'
		off = -off
	}
	gmt := fmt.Sprintf("GMT%c%02d%02d", sign, off/3600, off/60%60)
	return t.Format("Mon Jan 02 2006 15:04:05 ") + gmt + " (" + zoneLongName(t) + ")"
}

// zoneNames 见 zonenames_gen.go（scripts/parity/gen-tz-names.mjs 由 Node Intl 生成）

func localZoneName() string {
	if tz := os.Getenv("TZ"); tz != "" {
		return strings.TrimPrefix(tz, ":")
	}
	if p, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if i := strings.Index(p, "zoneinfo/"); i >= 0 {
			return p[i+len("zoneinfo/"):]
		}
	}
	return ""
}

func zoneLongName(t time.Time) string {
	if n, ok := zoneNames[localZoneName()]; ok {
		name := n[0]
		if t.IsDST() {
			name = n[1]
		}
		if name != "" {
			return name
		}
	}
	_, off := t.Zone()
	if off == 0 {
		return "GMT"
	}
	sign := '+'
	if off < 0 {
		sign = '-'
		off = -off
	}
	return fmt.Sprintf("GMT%c%02d:%02d", sign, off/3600, off/60%60)
}

func stamp() string { return JSDateString(Now()) }

// ConfigFrame = configFrame()
func ConfigFrame() string {
	body := `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"` + OutputFormat + `"}}}}`
	return "X-Timestamp:" + stamp() + "\r\nContent-Type:application/json; charset=utf-8\r\n" +
		"Path:speech.config\r\n\r\n" + body
}

var xmlEsc = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")

// EscapeXML = escapeXml(s)
func EscapeXML(s string) string { return xmlEsc.Replace(s) }

// VoiceNameRe = VOICE_NAME_RE
var VoiceNameRe = regexp.MustCompile(`^[a-z]{2,3}-[A-Za-z0-9-]+Neural$`)

// jsRound = Math.round
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// FormatRate = formatRate(percent)；非有限数（NaN/±Inf）按 0
func FormatRate(percent float64) string {
	if math.IsNaN(percent) || math.IsInf(percent, 0) {
		percent = 0
	}
	r := jsRound(math.Max(-50, math.Min(50, percent)))
	if r == 0 {
		r = 0 // -0 → "+0%"（JS：-0 >= 0，`${-0}` = "0"）
	}
	s := fmt.Sprintf("%d%%", int(r))
	if r >= 0 {
		s = "+" + s
	}
	return s
}

// SSMLFrame = ssmlFrame(text, voice, ratePercent)
func SSMLFrame(text, voice string, ratePercent float64) string {
	ssml := `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
		`<voice name='` + EscapeXML(voice) + `'><prosody pitch='+0Hz' rate='` + FormatRate(ratePercent) + `' volume='+0%'>` +
		EscapeXML(text) + `</prosody></voice></speak>`
	return "X-RequestId:" + hexID() + "\r\nContent-Type:application/ssml+xml\r\n" +
		"X-Timestamp:" + stamp() + "Z\r\nPath:ssml\r\n\r\n" + ssml
}

func parseHeaders(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\r\n") {
		if i := strings.Index(line, ":"); i > 0 {
			out[line[:i]] = jsTrim(line[i+1:])
		}
	}
	return out
}

// jsTrim = String.prototype.trim（JS 空白含 U+FEFF 等）
func jsTrim(s string) string {
	return strings.TrimFunc(s, IsJSSpace)
}

// IsJSSpace：JS \s / trim 的空白集合
func IsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// TextFramePath = textFramePath(frame)；没有 Path 时 ok=false
func TextFramePath(frame string) (string, bool) {
	if end := strings.Index(frame, "\r\n\r\n"); end >= 0 {
		frame = frame[:end]
	}
	p, ok := parseHeaders(frame)["Path"]
	return p, ok
}

// BinaryFrameAudio = binaryFrameAudio(frame)；不是音频帧时 nil
func BinaryFrameAudio(frame []byte) []byte {
	if len(frame) < 2 {
		return nil
	}
	hl := int(binary.BigEndian.Uint16(frame))
	if hl+2 > len(frame) {
		return nil
	}
	if parseHeaders(strings.ToValidUTF8(string(frame[2:2+hl]), "\uFFFD"))["Path"] != "audio" {
		return nil
	}
	return frame[2+hl:]
}
