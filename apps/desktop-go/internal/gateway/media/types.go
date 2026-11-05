// Package media：生图的「适配器 + 端点」两层。
// 适配器（adapters.go）只做纯函数的拼请求 / 解析响应；端点（endpoints.go）是数据化的规则表，
// 按供应商预设 / 地址 / 上游模型名选适配器与供应商的哪个协议地址。发请求、放 Key、轮询、下载在 core。
// 新增一家 = 写一个适配器 + 在规则表里加一行。
package media

// Aspect：与厂商无关的画幅
type Aspect = string

var Aspects = []Aspect{"auto", "1:1", "3:2", "2:3", "16:9", "9:16"}

// Auth：Key 放在哪
type Auth = string

const (
	AuthBearer = "bearer"
	AuthKey    = "key"
	AuthGoog   = "x-goog-api-key"
	AuthXAPI   = "x-api-key"
)

// Ref：带图（改图 / 参考图）的图片，主进程从本地读出来；只发给图片模型，不进对话上下文
type Ref struct {
	Mime string
	B64  string
}

type GenInput struct {
	BaseURL string
	Model   string
	Prompt  string
	Aspect  Aspect
	// Refs：待修改的图片或参考图；空 = 文生图（只有 Edit 的适配器会收到）
	Refs []Ref
	// RefMode：edit = 在 Refs[0] 上修改；reference = 以 Refs 为参考生成新图
	RefMode string
}

// MultipartFile / Multipart：multipart 表单（OpenAI /images/edits）
type MultipartFile struct {
	Field, Name, Mime, B64 string
}

type Multipart struct {
	Fields map[string]string
	Files  []MultipartFile
}

// HTTPRequest：拼好的请求（不含 Key）；Body 发 JSON，Multipart 发表单，二选一；都为 nil 时不发正文
type HTTPRequest struct {
	Method    string
	URL       string
	Headers   map[string]string
	Body      map[string]any
	Multipart *Multipart
}

type Image struct {
	B64  string
	URL  string
	Mime string
}

// Parse：Kind = "images" | "poll" | "failed"
type Parse struct {
	Kind          string
	Images        []Image
	RevisedPrompt string
	Next          *HTTPRequest
	AfterMs       int
	Message       string
}

type Adapter struct {
	ID        string
	Auth      Auth
	TimeoutMs int
	// Edit：支持带图（改图 / 参考图）；文生图与带图常是不同的接口，由适配器自己分
	Edit  bool
	Build func(GenInput) HTTPRequest
	Parse func(body any, in GenInput) Parse
}

// ProviderInfo：端点判断要用的供应商信息（不含 Key）
type ProviderInfo struct {
	ID       string
	PresetID string
	URLs     map[string]string
	// Auth：各协议探测到的鉴权方式
	Auth map[string]string
}

type Endpoint struct {
	Adapter *Adapter
	BaseURL string
	Wire    string
	Auth    Auth
}
