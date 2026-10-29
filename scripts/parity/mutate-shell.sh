#!/usr/bin/env bash
# shell.ts 移植的变异检查：逐个对 Go 源码打一处语义变异，shell parity 回放必须失败（存活即退出 1）。
# Usage: bash scripts/parity/mutate-shell.sh   （在仓库根目录；会临时改动并恢复下列文件）
set -euo pipefail
cd "$(dirname "$0")/../../apps/desktop-go"
D=internal/core
# 文件|perl 替换（只替换第一处）
MUTANTS=(
  "$D/diagnostics/service.go|s/v == \"0\"/v == \"1\"/"
  "$D/diagnostics/service.go|s/\"nomi-diagnostics-\"/\"nomi-diagnostic-\"/"
  "$D/diagnostics/bundle.go|s/BundleWindowMs = 24 \*/BundleWindowMs = 25 */"
  "$D/diagnostics/bundle.go|s/\\\\.jsonl\)\\$/\\\\.json)\\$/"
  "$D/appicon/appicon.go|s/Default = \"sunset\"/Default = \"ink\"/"
  "$D/appicon/appicon.go|s/platform == \"win32\" && ico != \"\"/platform == \"linux\" \&\& ico != \"\"/"
  "$D/appicon/appicon.go|s/part := \"window\"/part := \"dock\"/"
  "$D/appicon/appicon.go|s/s.target.SetTrayIcon\(IconFile\(s.assets, s.current, \"tray\"\)\)//"
  "$D/updates/service.go|s/DefaultStallMs     = 90_000/DefaultStallMs     = 60_000/"
  "$D/updates/service.go|s/case \"downloaded\":\n\t\t\tstage = \"install\"/case \"downloaded\":\n\t\t\tstage = \"download\"/"
  "$D/updates/service.go|s/return m\[\"autoCheck\"\] != false/return m[\"autoCheck\"] == true/"
  "$D/updates/service.go|s/s.cancelDownload\(\)\n\ts.patch/s.patch/"
  "$D/updates/service.go|s/st.ReleaseNotes = OptNull/st.ReleaseNotes = Opt{}/"
  "$D/updates/service.go|s/if s.state.Status != \"error\" \{/if false {/"
  "$D/shellhandlers/updates.go|s/s.SetAutoCheck\(on\)/s.SetAutoCheck(!on)/"
  "$D/services/logger.go|s/if level > l.level \{/if level >= l.level {/"
  "$D/services/logger.go|s/level > WARN && l.o.Packaged\(\)/level > INFO \&\& l.o.Packaged()/"
  "$D/services/logger.go|s/ctx = \"\[\" \+ context \+ \"\] \"/ctx = \"[\" + context + \"]\"/"
  "$D/services/logger.go|s/maxLogSize  = 10 \* 1024 \* 1024/maxLogSize  = 10*1024*1024 - 1/"
  "$D/services/logger.go|s/case \"\", \"null\", \"false\", \"0\"/case \"\", \"null\", \"false\"/"
  "$D/services/redact.go|s/const redactMaxDepth = 8/const redactMaxDepth = 9/"
  "$D/services/redact.go|s/\"credential\", \"token\",/\"credential\",/"
  "$D/diagnostics/clitrace.go|s/maxChunkChars = 64 \* 1024/maxChunkChars = 64*1024 + 1/"
  "$D/diagnostics/clitrace.go|s/if pid != 0 \{/if true {/"
  "$D/diagnostics/clitrace.go|s/t.written\+util.UTF16Len\(line\) > maxDayBytes/t.written > maxDayBytes/"
  "$D/diagnostics/clitrace.go|s/ra\[i\] = server.RedactText\(a, nil\)/ra[i] = a/"
  "$D/diagnostics/clitrace.go|s/O_WRONLY, 0o600/O_WRONLY, 0o644/"
  "$D/terminal/service.go|s/writeIfChanged\(tokenFile, \*client.Token, 0o600\)/writeIfChanged(tokenFile, *client.Token, 0o644)/"
  "$D/terminal/service.go|s/kind := \"shell-rc\"/kind := \"user-path\"/"
  "$D/terminal/service.go|s/\"nomi-\"\+kind\+\".ps1\"\), powershellScript/\"nomi-\"+kind+\".ps\"), powershellScript/"
  "$D/terminal/service.go|s/\"fish\", \"config.fish\"\), \"fish\"\}/\"fish\", \"config.fish\"), \"posix\"}/"
  "$D/terminal/terminal.go|s/return \"nomi-\" \+ kind \+ \".cmd\"/return \"nomi-\" + kind + \".bat\"/"
  "$D/terminal/terminal.go|s/# Added by Nomi; removed/# Added by Nomi, removed/"
  "internal/gateway/probe/detect.go|s/gemini = origin \+ \"\/v1beta\"/gemini = origin + \"\/v1\"/"
  "internal/gateway/probe/detect.go|s/\|\| r2.status == 400/|| r2.status == 401/"
  "internal/gateway/probe/detect.go|s/\"messages\": \"x-api-key\", \"responses\"/\"messages\": \"bearer\", \"responses\"/"
  "internal/gateway/probe/detect.go|s/return err.Error\(\)/return \"fetch failed\"/"
  "$D/chatnav/chatnav.go|s/\"providers\": \"providers.openPanel\"/\"providers\": \"providers.open\"/"
  "$D/shellhandlers/gateway.go|s/\"Service 'terminal' is not available\"/\"Service 'gateway' is not available\"/"
  "$D/mascothandlers/register.go|s/chatnav.OpenPanel\\(r, d.OpenChat, \"nav.scheduleRequested\"\\)/chatnav.OpenPanel(r, d.OpenChat, \"nav.desktopPanelRequested\")/"
  "$D/chatnav/chatnav.go|s/map\\[string\\]any\\{\\}, \"chat\"\\)/map[string]any{}, \"\")/"
  "$D/mousetrack/mousetrack.go|s/x <= b.X\+b.Width/x < b.X+b.Width/"
  "$D/mousetrack/mousetrack.go|s/if in != t.in \{/if true {/"
  "$D/mousetrack/mousetrack.go|s/if !ok \{\n\t\treturn/if false {\n\t\treturn/"
  "internal/shell/trash/trash_linux.go|s/run\(\"gio\", \"trash\", p\)/run(\"gio\", \"remove\", p)/"
  "internal/shell/trash/trash.go|s/if _, err := os.Lstat\(abs\); err != nil \{/if false {/"
  "$D/quality/ledger.go|s/t \\+ dayMs \\+ 3_600_000/t + dayMs/"
  "$D/quality/ledger.go|s/\\(retentionDays-1\\)\\*dayMs/retentionDays*dayMs/"
  "$D/quality/ledger.go|s/ts >= from && ts < to/ts >= from \\&\\& ts <= to/"
  "$D/quality/csv.go|s/=\\+\\\\-@/=+\\\\-/"
  "$D/quality/csv.go|s/strings.Repeat\\(\"  \", g.Depth\\)/strings.Repeat(\" \", g.Depth)/"
  "$D/quality/csv.go|s/round\\(out\\/\\(g\\/1000\\), 1\\)/round(out\\/(g\\/1000), 2)/"
  "$D/quality/csv.go|s/numStr\\(s.Get\\(\"vendor\"\\)\\) \\+ \": \"/numStr(s.Get(\"vendor\")) + \":\"/"
  "$D/quality/service.go|s/maxRangeDays = 366/maxRangeDays = 365/"
  "$D/quality/service.go|s/len\\(path\\) > 3/len(path) > 4/"
  "$D/quality/service.go|s/len\\(vals\\) > 50/len(vals) > 1/"
  "$D/quality/service.go|s/Filters: b.Filters, Limit: 100/Filters: b.Filters, Limit: 50/"
  "$D/quality/service.go|s/q.Set\\(\"limit\", 1000.0\\)/q.Set(\"limit\", 100.0)/"
  "$D/quality/service.go|s/from -= q.To - q.From/from -= 0/"
  "$D/quality/service.go|s/fmt.Sprintf\\(\"g-%s-%d\"/fmt.Sprintf(\"g%s-%d\"/"
  "$D/quality/service.go|s/full.Set\\(\"cost\", c\\)/_ = c/"
  "$D/quality/service.go|s/RetentionChoices \\{\\n\\t\\tif c == f/RetentionChoices[:1] {\\n\\t\\tif c == f/"
  "$D/quality/service.go|s/t.Set\\(\"label\", i18n.T\\(\"electron.common.all\"\\)\\)//"
  "$D/quality/handlers.go|s/return validBase\\(o\\) && optOK\\(o, \"filters\", isFilters\\) && optOK\\(o, \"groupBy\", isStr\\)/return validBase(o) \\&\\& optOK(o, \"groupBy\", isStr)/"
  "$D/quality/handlers.go|s/\\(b == \"hour\" \\|\\| b == \"day\"\\)/(b == \"hour\" || b == \"day\" || b == \"week\")/"
  "$D/quality/handlers.go|s/isNum\\(o, \"limit\"\\) &&/true \\&\\&/"
  "$D/quality/fromgateway.go|s/\\b300\\b/301/"
)
killed=0; survived=0
for m in "${MUTANTS[@]}"; do
  f=${m%%|*}; e=${m#*|}
  cp "$f" "$f.mutbak"
  perl -0pi -e "$e" "$f"
  if cmp -s "$f" "$f.mutbak"; then
    mv "$f.mutbak" "$f"; echo "MUTANT NOT APPLIED: $m"; exit 2
  fi
  if go test -count=1 -tags gtk3 ./internal/core/shellhandlers/ ./internal/core/mascothandlers/ ./internal/core/mousetrack/ ./internal/shell/trash/ ./internal/core/quality/ -run 'Parity|Golden|TestQuality|TestWindowRoutes|TestTerminalUnavailable|TestOpenTaskBoard|TestMouseTrack|TestTrashItem' >/dev/null 2>&1; then
    survived=$((survived+1)); echo "SURVIVED: $m"
  else
    killed=$((killed+1)); echo "killed:   $m"
  fi
  mv "$f.mutbak" "$f"
done
echo "mutants: $killed killed, $survived survived"
[ "$survived" -eq 0 ]
