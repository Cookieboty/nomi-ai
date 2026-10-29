package clisdk

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const ExternalSpecVersion = 1

var ExternalPlaceholders = []string{"cwd", "home"}

var (
	extIDRe       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	extEnvRe      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	placeholderRe = regexp.MustCompile(`\{([^{}]*)\}`)
	controlRe     = regexp.MustCompile("[\x00-\x1f\x7f]")
)

func isPlainObj(v any) (*util.Obj, bool) { o, ok := v.(*util.Obj); return o, ok }

func isPlaceholder(n string) bool { return n == "cwd" || n == "home" }

func itoa(i int) string { return util.FormatNumber(float64(i)) }

// ValidateExternalSpec mirrors validateExternalSpec。
func ValidateExternalSpec(raw any, reserved []string) []string {
	errs := []string{}
	o, ok := isPlainObj(raw)
	if !ok {
		return []string{"spec must be an object"}
	}
	if v, ok := o.Get("version").(float64); !ok || v != ExternalSpecVersion {
		errs = append(errs, "version must be 1")
	}
	if id, ok := o.Get("id").(string); !ok || !extIDRe.MatchString(id) {
		errs = append(errs, "id must match [a-z0-9][a-z0-9-]{0,39}")
	} else {
		for _, r := range reserved {
			if r == id {
				errs = append(errs, "id "+id+" is reserved by a built-in plugin")
				break
			}
		}
	}
	if dn, ok := o.Get("displayName").(string); !ok || JSTrim(dn) == "" {
		errs = append(errs, "displayName is required")
	} else if Len(dn) > 60 || controlRe.MatchString(dn) {
		errs = append(errs, "displayName must be at most 60 printable characters")
	}
	if c, ok := o.Get("command").(string); !ok || JSTrim(c) == "" {
		errs = append(errs, "command is required")
	} else if Len(c) > 1024 || controlRe.MatchString(c) {
		errs = append(errs, "command must not contain control characters")
	} else if placeholderRe.MatchString(c) {
		errs = append(errs, "command must not contain placeholders")
	}
	if args, ok := o.Get("args").([]any); !ok {
		errs = append(errs, "args must be an array")
	} else {
		if len(args) > 32 {
			errs = append(errs, "at most 32 args")
		}
		for i, a := range args {
			s, ok := a.(string)
			if !ok {
				errs = append(errs, "args["+itoa(i)+"] must be a string")
				continue
			}
			if Len(s) > 512 || controlRe.MatchString(s) {
				errs = append(errs, "args["+itoa(i)+"] must be at most 512 printable characters")
				continue
			}
			for _, m := range placeholderRe.FindAllStringSubmatch(s, -1) {
				if !isPlaceholder(m[1]) {
					errs = append(errs, "args["+itoa(i)+"] uses unknown placeholder {"+m[1]+"}")
				}
			}
		}
	}
	if o.Has("env") {
		if env, ok := o.Get("env").([]any); !ok {
			errs = append(errs, "env must be an array of names")
		} else {
			if len(env) > 16 {
				errs = append(errs, "at most 16 env names")
			}
			for i, n := range env {
				if s, ok := n.(string); !ok || !extEnvRe.MatchString(s) {
					errs = append(errs, "env["+itoa(i)+"] must be an environment variable name (no values)")
				}
			}
		}
	}
	for _, k := range o.Keys() {
		switch k {
		case "version", "id", "displayName", "command", "args", "env":
		default:
			errs = append(errs, "unknown field "+k)
		}
	}
	return errs
}

// NormalizeExternalSpec mirrors normalizeExternalSpec。
func NormalizeExternalSpec(s *util.Obj) *util.Obj {
	args, _ := s.Get("args").([]any)
	r := O("version", float64(1), "id", JSTrim(s.Get("id").(string)), "displayName", JSTrim(s.Get("displayName").(string)),
		"command", JSTrim(s.Get("command").(string)), "args", append([]any{}, args...))
	if env, _ := s.Get("env").([]any); len(env) > 0 {
		seen := map[string]bool{}
		out := []any{}
		for _, n := range env {
			t := JSTrim(n.(string))
			if !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
		r.Set("env", out)
	}
	return r
}

// RenderExternalArgs mirrors renderExternalArgs。
func RenderExternalArgs(args []string, vars map[string]string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = placeholderRe.ReplaceAllStringFunc(a, func(m string) string {
			name := m[1 : len(m)-1]
			if isPlaceholder(name) {
				return vars[name] // JS: vars[name]，缺失时为 "undefined"
			}
			return m
		})
	}
	return out
}

// MissingExternalEnv mirrors missingExternalEnv（env 值空串视为缺）。
func MissingExternalEnv(spec *util.Obj, env map[string]string) []string {
	out := []string{}
	names, _ := spec.Get("env").([]any)
	for _, n := range names {
		s, _ := n.(string)
		if env[s] == "" {
			out = append(out, s)
		}
	}
	return out
}

// ExternalManifest mirrors externalManifest。
func ExternalManifest(s *util.Obj) *util.Obj {
	return O("id", s.Get("id"), "apiVersion", float64(CliAPIVersion), "displayName", s.Get("displayName"), "icon", "",
		"binary", O("names", []any{s.Get("command")}, "versionArgs", []any{"--version"}, "versionPattern", `(\d+\.\d+\.\d+)`),
		"transport", "acp", "ingress", "chat",
		"capabilities", O("officialAccount", false, "thirdParty", false, "images", "native",
			"permissionModes", []any{O("mode", "manual")}, "subagents", false, "slashCommands", true, "resume", true,
			"fork", false, "usageQuota", false, "progressMonitor", false, "terminalCommand", false),
		"modelSwitch", "restart", "clientSpec", O())
}

var _ = strings.TrimSpace
