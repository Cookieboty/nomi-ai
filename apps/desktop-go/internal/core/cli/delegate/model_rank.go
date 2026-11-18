package delegate

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	tierUltra       = 4
	tierFlagship    = 3
	tierSubFlagship = 2
	tierLight       = 1
)

var (
	reModelTag          = regexp.MustCompile(`:[\w.-]+$`)
	reTrailingDate      = regexp.MustCompile(`-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|(?:24|25|26)\d{2}|(?:0[1-9]|1[0-2])\d{2}|(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$`)
	reSizeToken         = regexp.MustCompile(`(?i)\b\d+(?:\.\d+)?[btk]\b`)
	reVersionCandidate  = regexp.MustCompile(`(?i)(?:^|[-vkm.])(\d{1,2})(?:[.-](\d{1,2}))?(?:[.-](\d{1,2}))?`)
	nonCodingSubstrings = []string{
		"embed", "rerank", "tts", "whisper", "audio", "realtime",
		"moderation", "safeguard", "ocr", "lyria", "voxtral", "pixtral",
		"image", "dall-e", "flux", "live-translate", "live-preview",
	}
)

// CliNativeFamily 返回 CLI 对应的原生同族模型家族标识。
func CliNativeFamily(cli string) string {
	switch strings.ToLower(strings.TrimSpace(cli)) {
	case "claude":
		return "claude"
	case "codex":
		return "gpt"
	case "gemini":
		return "gemini"
	case "grok":
		return "grok"
	case "dsh":
		return "deepseek"
	case "kimi":
		return "kimi"
	case "minimax":
		return "minimax"
	default:
		return ""
	}
}

func bareModelLower(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	s = strings.ToLower(s)
	return reModelTag.ReplaceAllString(s, "")
}

func isNonCodingModel(bare string) bool {
	if bare == "" || bare == "default" {
		return true
	}
	for _, sub := range nonCodingSubstrings {
		if strings.Contains(bare, sub) {
			return true
		}
	}
	return false
}

func modelFamilyOf(bare string) string {
	switch {
	case strings.HasPrefix(bare, "claude"),
		bare == "fable", strings.HasPrefix(bare, "fable-"),
		bare == "opus", strings.HasPrefix(bare, "opus-"),
		bare == "sonnet", strings.HasPrefix(bare, "sonnet-"),
		bare == "haiku", strings.HasPrefix(bare, "haiku-"):
		return "claude"
	case strings.HasPrefix(bare, "gpt-"),
		strings.HasPrefix(bare, "chatgpt-"),
		strings.HasPrefix(bare, "o1"),
		strings.HasPrefix(bare, "o3"),
		strings.HasPrefix(bare, "o4"),
		(strings.HasPrefix(bare, "codex") && !strings.HasPrefix(bare, "codestral")):
		return "gpt"
	case strings.HasPrefix(bare, "gemini"):
		return "gemini"
	case strings.HasPrefix(bare, "grok"):
		return "grok"
	case strings.HasPrefix(bare, "deepseek"),
		strings.HasPrefix(bare, "ds-"),
		strings.HasPrefix(bare, "ds4"),
		strings.HasPrefix(bare, "ds3"):
		return "deepseek"
	case strings.HasPrefix(bare, "kimi"), strings.HasPrefix(bare, "moonshot"):
		return "kimi"
	case strings.HasPrefix(bare, "minimax"), strings.HasPrefix(bare, "abab"):
		return "minimax"
	case strings.HasPrefix(bare, "glm"), strings.HasPrefix(bare, "zai-glm"), strings.HasPrefix(bare, "chatglm"):
		return "glm"
	case strings.HasPrefix(bare, "qwen"), strings.HasPrefix(bare, "qwq"), strings.HasPrefix(bare, "qvq"):
		return "qwen"
	case strings.HasPrefix(bare, "devstral"), strings.HasPrefix(bare, "codestral"),
		strings.HasPrefix(bare, "mistral"), strings.HasPrefix(bare, "magistral"), strings.HasPrefix(bare, "ministral"):
		return "mistral"
	default:
		return ""
	}
}

func stripSnapshotSuffixes(bare string) (cleaned string, snapshotPenalty int) {
	s := bare
	for {
		next := reTrailingDate.ReplaceAllString(s, "")
		if next == s {
			break
		}
		snapshotPenalty++
		s = next
	}
	for _, suf := range []string{"-exp", "-preview", "-latest"} {
		if strings.HasSuffix(s, suf) {
			if suf != "-latest" {
				snapshotPenalty++
			}
			s = strings.TrimSuffix(s, suf)
		}
	}
	return s, snapshotPenalty
}

type parsedModel struct {
	ref             string
	bare            string
	family          string
	tier            int
	major           int
	minor           int
	patch           int
	isLatestAlias   bool
	snapshotPenalty int
	order           int
}

func parseVersionTuple(bare string) (major, minor, patch, penalty int, isLatest bool) {
	isLatest = strings.HasSuffix(bare, "-latest")
	cleaned, penalty := stripSnapshotSuffixes(bare)
	// 先移除如 120b / 480b / 32b / 4k 等参数量/上下文数字，以免被误认作版本号
	noSizes := reSizeToken.ReplaceAllString(cleaned, " ")
	for _, m := range reVersionCandidate.FindAllStringSubmatch(noSizes, -1) {
		maj, err := strconv.Atoi(m[1])
		if err != nil || maj > 20 {
			continue
		}
		minV, patV := 0, 0
		if m[2] != "" {
			if v, err := strconv.Atoi(m[2]); err == nil && v <= 99 {
				minV = v
			}
		}
		if m[3] != "" {
			if v, err := strconv.Atoi(m[3]); err == nil && v <= 99 {
				patV = v
			}
		}
		// 取最大主次版本号（如 qwen3.8-max 取 3.8）
		if maj > major || (maj == major && (minV > minor || (minV == minor && patV > patch))) {
			major, minor, patch = maj, minV, patV
		}
	}
	return
}

func modelTierRank(family, bare string) int {
	switch family {
	case "claude":
		switch {
		case strings.Contains(bare, "fable"):
			return tierUltra
		case strings.Contains(bare, "opus"):
			return tierFlagship
		case strings.Contains(bare, "sonnet"):
			return tierSubFlagship
		case strings.Contains(bare, "haiku"):
			return tierLight
		}
	case "gpt":
		switch {
		case strings.HasSuffix(bare, "-pro") || strings.Contains(bare, "-pro-") ||
			strings.Contains(bare, "astra") || strings.Contains(bare, "daybreak-red"):
			return tierUltra
		case (strings.Contains(bare, "-mini") && !strings.Contains(bare, "mini-high")) ||
			strings.Contains(bare, "-nano") || strings.Contains(bare, "luna") ||
			strings.HasPrefix(bare, "gpt-3.5") || strings.HasPrefix(bare, "gpt-oss"):
			return tierLight
		case (strings.Contains(bare, "-sol") && !strings.Contains(bare, "-pro")) ||
			strings.Contains(bare, "codex-max") || strings.Contains(bare, "daybreak-blue") ||
			bare == "o1" || strings.HasPrefix(bare, "gpt-5.5") || strings.HasPrefix(bare, "gpt-5-5") ||
			bare == "gpt-5.6" || bare == "gpt-5-6":
			return tierFlagship
		case strings.Contains(bare, "terra") || strings.Contains(bare, "codex") ||
			strings.Contains(bare, "mini-high") || bare == "o3" ||
			strings.HasPrefix(bare, "gpt-5") || strings.HasPrefix(bare, "gpt-6") ||
			strings.HasPrefix(bare, "gpt-4"):
			return tierSubFlagship
		}
	case "gemini":
		switch {
		case strings.Contains(bare, "deep-research-max"):
			return tierUltra
		case strings.Contains(bare, "pro") || strings.Contains(bare, "argon") ||
			strings.Contains(bare, "carbon") || strings.Contains(bare, "deep-research"):
			return tierFlagship
		case strings.Contains(bare, "flash-lite") || strings.Contains(bare, "lite") ||
			strings.Contains(bare, "2.5-flash") || strings.Contains(bare, "2-5-flash"):
			return tierLight
		case strings.Contains(bare, "hydrogen") || strings.Contains(bare, "flash"):
			return tierSubFlagship
		}
	case "grok":
		switch {
		case strings.HasPrefix(bare, "grok-5") && (strings.Contains(bare, "pro") || strings.Contains(bare, "ultra") || strings.Contains(bare, "heavy")):
			return tierUltra
		case strings.Contains(bare, "non-reasoning") || strings.Contains(bare, "mini") || strings.Contains(bare, "fast"):
			return tierLight
		case strings.Contains(bare, "multi-agent") || strings.HasPrefix(bare, "grok-4.7") ||
			strings.HasPrefix(bare, "grok-4-7") || strings.HasPrefix(bare, "grok-5"):
			return tierFlagship
		case strings.HasPrefix(bare, "grok-4") || strings.HasPrefix(bare, "grok-build") || bare == "grok-latest":
			return tierSubFlagship
		}
	case "deepseek":
		switch {
		case strings.Contains(bare, "flash"):
			return tierLight
		case strings.HasPrefix(bare, "deepseek-v4-pro") || strings.HasPrefix(bare, "deepseek-r1") ||
			strings.Contains(bare, "reasoner"):
			return tierFlagship
		case strings.Contains(bare, "v4.1") || strings.Contains(bare, "v4-1") ||
			strings.Contains(bare, "v3") || strings.Contains(bare, "chat") ||
			strings.Contains(bare, "pro") || strings.Contains(bare, "ds4.1") ||
			strings.Contains(bare, "ds4-1") || strings.Contains(bare, "ds-v4.1"):
			return tierSubFlagship
		}
	case "kimi":
		switch {
		case strings.Contains(bare, "highspeed"):
			return tierUltra
		case strings.HasPrefix(bare, "kimi-k3") && strings.Contains(bare, "pro"):
			return tierFlagship
		case bare == "kimi-k2" || strings.HasPrefix(bare, "kimi-k2-0"):
			return tierLight
		default:
			return tierSubFlagship
		}
	case "minimax":
		switch {
		case strings.Contains(bare, "flash"):
			return tierLight
		case bare == "minimax-m3":
			return tierFlagship
		case strings.HasPrefix(bare, "minimax-m"):
			return tierSubFlagship
		}
	case "glm":
		switch {
		case strings.Contains(bare, "prime"):
			return tierUltra
		case strings.Contains(bare, "flash") || strings.Contains(bare, "air"):
			return tierLight
		case strings.HasPrefix(bare, "glm-5.3") || strings.HasPrefix(bare, "glm-5-3") ||
			strings.HasPrefix(bare, "zai-glm-5-3") || strings.HasPrefix(bare, "zai-glm-5.3") ||
			strings.HasPrefix(bare, "glm-5.2") || strings.HasPrefix(bare, "glm-5-2") ||
			strings.HasPrefix(bare, "zai-glm-5-2") || strings.HasPrefix(bare, "zai-glm-5.2"):
			return tierFlagship
		default:
			return tierSubFlagship
		}
	case "qwen":
		switch {
		case strings.Contains(bare, "max-prime"):
			return tierUltra
		case strings.Contains(bare, "flash") || strings.Contains(bare, "turbo"):
			return tierLight
		case strings.Contains(bare, "max"):
			return tierFlagship
		case strings.Contains(bare, "plus") || strings.Contains(bare, "coder"):
			return tierSubFlagship
		}
	}
	return tierSubFlagship
}

func parseCandidateModels(candidates []string, filterFamily string) []parsedModel {
	out := make([]parsedModel, 0, len(candidates))
	seen := map[string]bool{}
	for idx, raw := range candidates {
		bare := bareModelLower(raw)
		if isNonCodingModel(bare) {
			continue
		}
		fam := modelFamilyOf(bare)
		if filterFamily != "" && fam != filterFamily {
			continue
		}
		key := strings.TrimSpace(raw)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		maj, minV, patV, pen, isLatest := parseVersionTuple(bare)
		out = append(out, parsedModel{
			ref:             key,
			bare:            bare,
			family:          fam,
			tier:            modelTierRank(fam, bare),
			major:           maj,
			minor:           minV,
			patch:           patV,
			isLatestAlias:   isLatest,
			snapshotPenalty: pen,
			order:           idx,
		})
	}
	return out
}

// compareModelQualityDesc 同档内按版本号从新到旧排序（带精确最新版本号的标准名优先于 latest 与快照后缀）。
func compareModelQualityDesc(a, b parsedModel) bool {
	if a.major != b.major {
		return a.major > b.major
	}
	if a.minor != b.minor {
		return a.minor > b.minor
	}
	if a.patch != b.patch {
		return a.patch > b.patch
	}
	if a.isLatestAlias != b.isLatestAlias {
		return !a.isLatestAlias
	}
	if a.snapshotPenalty != b.snapshotPenalty {
		return a.snapshotPenalty < b.snapshotPenalty
	}
	return a.order < b.order
}

func pickSubTopFromParsed(list []parsedModel) string {
	if len(list) == 0 {
		return ""
	}
	byTier := map[int][]parsedModel{}
	for _, m := range list {
		byTier[m.tier] = append(byTier[m.tier], m)
	}
	for t := range byTier {
		sort.SliceStable(byTier[t], func(i, j int) bool {
			return compareModelQualityDesc(byTier[t][i], byTier[t][j])
		})
	}
	// 只把主力层 [4, 3, 2] 纳入次顶级降档序列，避免把 haiku / mini / nano 当作复杂次顶级
	mainTiers := []int{}
	for _, t := range []int{tierUltra, tierFlagship, tierSubFlagship} {
		if len(byTier[t]) > 0 {
			mainTiers = append(mainTiers, t)
		}
	}
	switch {
	case len(mainTiers) >= 2:
		return byTier[mainTiers[1]][0].ref
	case len(mainTiers) == 1:
		t := mainTiers[0]
		arr := byTier[t]
		if t <= tierSubFlagship || len(arr) == 1 {
			return arr[0].ref
		}
		// 只有 Ultra 或 Flagship 档且包含多个不同版本模型时，取版本次高者
		top := arr[0]
		for _, m := range arr[1:] {
			if m.major != top.major || m.minor != top.minor || m.patch != top.patch {
				return m.ref
			}
		}
		return top.ref
	case len(byTier[tierLight]) > 0:
		return byTier[tierLight][0].ref
	default:
		sort.SliceStable(list, func(i, j int) bool {
			return compareModelQualityDesc(list[i], list[j])
		})
		return list[0].ref
	}
}

// PickSubTopModelForCli 在给定候选中为 CLI 匹配原生同族生态的次顶级模型；没有同族时返回 ""。
func PickSubTopModelForCli(cli string, candidates []string) string {
	fam := CliNativeFamily(cli)
	if fam == "" || len(candidates) == 0 {
		return ""
	}
	return pickSubTopFromParsed(parseCandidateModels(candidates, fam))
}

// PickBalancedModelForCli 为日常均衡档挑选匹配 CLI 同族的模型：优先同族 tierSubFlagship，否则同次顶级结果。
func PickBalancedModelForCli(cli string, candidates []string) string {
	fam := CliNativeFamily(cli)
	if fam == "" || len(candidates) == 0 {
		return ""
	}
	parsed := parseCandidateModels(candidates, fam)
	if len(parsed) == 0 {
		return ""
	}
	sub := make([]parsedModel, 0, len(parsed))
	for _, m := range parsed {
		if m.tier == tierSubFlagship {
			sub = append(sub, m)
		}
	}
	if len(sub) > 0 {
		sort.SliceStable(sub, func(i, j int) bool {
			return compareModelQualityDesc(sub[i], sub[j])
		})
		return sub[0].ref
	}
	return pickSubTopFromParsed(parsed)
}

// PickFallbackSubTopModel 当网关完全不含主力 CLI 原生同族模型时，兜底挑出跨家族次顶级强力模型。
func PickFallbackSubTopModel(candidates []string, preferred string) string {
	if p := strings.TrimSpace(preferred); p != "" {
		for _, c := range candidates {
			if c == p {
				return p
			}
		}
	}
	parsed := parseCandidateModels(candidates, "")
	if len(parsed) == 0 {
		for _, c := range candidates {
			if strings.TrimSpace(c) != "" {
				return c
			}
		}
		return ""
	}
	if picked := pickSubTopFromParsed(parsed); picked != "" {
		return picked
	}
	return parsed[0].ref
}

func bestValueSimpleScore(m parsedModel) (tierScore int, preferFlash int) {
	b := m.bare
	switch {
	// 梯队 1：DeepSeek V4.1 系列（ds4.1）
	case (m.family == "deepseek") &&
		(strings.Contains(b, "v4.1") || strings.Contains(b, "v4-1") ||
			strings.Contains(b, "ds4.1") || strings.Contains(b, "ds4-1")):
		if strings.Contains(b, "flash") {
			return 100, 1
		}
		return 100, 0

	// 梯队 2：Kimi 3 / K3 系列（kimi3）
	case (m.family == "kimi") &&
		(strings.HasPrefix(b, "kimi-k3") || strings.HasPrefix(b, "kimi-3") || strings.HasPrefix(b, "kimi3")):
		if !strings.Contains(b, "highspeed") {
			return 95, 1
		}
		return 95, 0

	// 梯队 3：GLM Flash 系列（glm3-flash / glm-5.3-flash / glm-4.7-flash 等）
	case (m.family == "glm") && strings.Contains(b, "flash"):
		if !strings.Contains(b, "flashx") {
			return 90, 1
		}
		return 90, 0

	// 梯队 4：DeepSeek V4 其他型号
	case (m.family == "deepseek") &&
		(strings.Contains(b, "v4") || strings.HasPrefix(b, "deepseek-flash")):
		if strings.Contains(b, "flash") {
			return 85, 1
		}
		return 85, 0

	// 梯队 5：国产新一代高性价比主力轻量（Qwen Flash / MiniMax Flash & M3 / Kimi K2.5-K2.7 / GLM Air）
	case (m.family == "qwen" && (strings.Contains(b, "flash") || strings.Contains(b, "turbo"))) ||
		(m.family == "minimax" && (strings.Contains(b, "flash") || b == "minimax-m3")) ||
		(m.family == "kimi" && (strings.Contains(b, "k2.7") || strings.Contains(b, "k2-7") || strings.Contains(b, "k2.6") || strings.Contains(b, "k2-6") || strings.Contains(b, "k2.5") || strings.Contains(b, "k2-5")) && !strings.Contains(b, "highspeed")) ||
		(m.family == "glm" && strings.Contains(b, "air")):
		if strings.Contains(b, "flash") {
			return 80, 1
		}
		return 80, 0

	// 梯队 6：DeepSeek V3 / Chat
	case (m.family == "deepseek") && (strings.Contains(b, "v3") || strings.Contains(b, "chat")):
		return 70, 0

	// 梯队 7：海外大厂高性价比轻量（Gemini Flash / GPT Luna / Mini / Nano / Haiku）
	case (m.family == "gemini" && strings.Contains(b, "flash")) ||
		(m.family == "gpt" && (strings.Contains(b, "luna") || strings.Contains(b, "-mini") || strings.Contains(b, "-nano"))) ||
		(m.family == "claude" && strings.Contains(b, "haiku")):
		if strings.Contains(b, "flash") || strings.Contains(b, "luna") || strings.Contains(b, "haiku") {
			return 60, 1
		}
		return 60, 0

	default:
		return 0, 0
	}
}

// PickBestValueSimpleModel 在第三方模型目录中为简单任务挑选性价比最高的顶级轻量/高性价比模型（如 ds4.1 / kimi3 / glm-flash）。
func PickBestValueSimpleModel(candidates []string, fallback string) string {
	parsed := parseCandidateModels(candidates, "")
	type ranked struct {
		m           parsedModel
		tierScore   int
		preferFlash int
	}
	matched := make([]ranked, 0, len(parsed))
	for _, m := range parsed {
		ts, pf := bestValueSimpleScore(m)
		if ts > 0 {
			matched = append(matched, ranked{m: m, tierScore: ts, preferFlash: pf})
		}
	}
	if len(matched) > 0 {
		sort.SliceStable(matched, func(i, j int) bool {
			if matched[i].tierScore != matched[j].tierScore {
				return matched[i].tierScore > matched[j].tierScore
			}
			if matched[i].preferFlash != matched[j].preferFlash {
				return matched[i].preferFlash > matched[j].preferFlash
			}
			return compareModelQualityDesc(matched[i].m, matched[j].m)
		})
		return matched[0].m.ref
	}
	if fb := strings.TrimSpace(fallback); fb != "" {
		for _, c := range candidates {
			if c == fb {
				return fb
			}
		}
	}
	if len(parsed) > 0 {
		return parsed[0].ref
	}
	for _, c := range candidates {
		if strings.TrimSpace(c) != "" {
			return c
		}
	}
	return ""
}

// DefaultOfficialSubTopModel 为官方/本机登录状态的 CLI 挑选同族次顶级模型。
// cachedModels 为空时仅在 Claude 已知支持可靠别名 "sonnet" 的情况下给明确次顶级名，其余保留空（走 CLI 默认或等目录缓存后刷新）。
func DefaultOfficialSubTopModel(cli string, cachedModels []string) string {
	if len(cachedModels) > 0 {
		if picked := PickSubTopModelForCli(cli, cachedModels); picked != "" {
			return picked
		}
	}
	if strings.EqualFold(strings.TrimSpace(cli), "claude") {
		return "sonnet"
	}
	return ""
}

// DefaultOfficialLightModel 当官方/本机 CLI 需兜底低成本预设时，挑选同族轻量/均衡模型。
func DefaultOfficialLightModel(cli string, cachedModels []string) string {
	if len(cachedModels) > 0 {
		fam := CliNativeFamily(cli)
		parsed := parseCandidateModels(cachedModels, fam)
		light := []parsedModel{}
		for _, m := range parsed {
			if m.tier == tierLight {
				light = append(light, m)
			}
		}
		if len(light) > 0 {
			sort.SliceStable(light, func(i, j int) bool {
				return compareModelQualityDesc(light[i], light[j])
			})
			return light[0].ref
		}
		if picked := PickBalancedModelForCli(cli, cachedModels); picked != "" {
			return picked
		}
	}
	if strings.EqualFold(strings.TrimSpace(cli), "claude") {
		return "sonnet"
	}
	return ""
}
