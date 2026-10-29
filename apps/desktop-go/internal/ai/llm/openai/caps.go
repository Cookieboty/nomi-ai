package openai

import (
	"regexp"
	"strconv"
	"strings"
)

// capabilities is getOpenAILanguageModelCapabilities.
type capabilities struct {
	supportsFlexProcessing         bool
	supportsPriorityProcessing     bool
	isReasoningModel               bool
	systemMessageMode              string
	supportsNonReasoningParameters bool
	supportsConfigurationUpdate    bool
	supportsAsyncToolCalling       bool
	supportedReasoningEfforts      []string // nil = undefined
}

var (
	oSeriesRe = regexp.MustCompile(`^o(\d+)(?:-|$)`)
	gptRe     = regexp.MustCompile(`^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$`)
)

func getCapabilities(modelID string) capabilities {
	oMajor := -1
	if m := oSeriesRe.FindStringSubmatch(modelID); m != nil {
		oMajor, _ = strconv.Atoi(m[1])
	}
	gptMajor, gptMinor := -1, -1
	variant, hasVariant := "", false
	if m := gptRe.FindStringSubmatchIndex(modelID); m != nil {
		gptMajor, _ = strconv.Atoi(modelID[m[2]:m[3]])
		if m[4] >= 0 {
			gptMinor, _ = strconv.Atoi(modelID[m[4]:m[5]])
		}
		if m[6] >= 0 {
			variant, hasVariant = modelID[m[6]:m[7]], true
		}
	}
	isO := oMajor >= 0
	isGpt := gptMajor >= 0
	isGptChat := isGpt && gptMinor < 0 && hasVariant && strings.HasPrefix(variant, "chat")
	isNano := hasVariant && strings.HasPrefix(variant, "nano")
	isGpt6Plus := isGpt && gptMajor >= 6
	isSolLuna := modelID == "gpt-6-sol" || modelID == "gpt-6-luna"
	gpt5Plus := isGpt && gptMajor >= 5

	c := capabilities{
		supportsFlexProcessing:     (isO && oMajor >= 3) || (gpt5Plus && !isGptChat),
		supportsPriorityProcessing: strings.HasPrefix(modelID, "gpt-4") || (gpt5Plus && !isNano && !isGptChat) || (isO && oMajor >= 3),
		isReasoningModel:           isO || (gpt5Plus && !isGptChat),
		supportsNonReasoningParameters: isSolLuna ||
			(!isGpt6Plus && isGpt && (gptMajor > 5 || (gptMajor == 5 && gptMinor >= 1))),
		supportsConfigurationUpdate: isGpt6Plus,
		supportsAsyncToolCalling:    isGpt6Plus,
	}
	if c.isReasoningModel {
		c.systemMessageMode = "developer"
	} else {
		c.systemMessageMode = "system"
	}
	switch {
	case isSolLuna:
		c.supportedReasoningEfforts = []string{"none", "low", "medium", "high", "xhigh", "max"}
	case isGpt6Plus:
		c.supportedReasoningEfforts = []string{"low", "medium", "high", "xhigh", "max"}
	}
	return c
}
