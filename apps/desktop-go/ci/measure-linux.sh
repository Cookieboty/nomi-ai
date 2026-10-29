#!/usr/bin/env bash
# Linux 内存实测（与 POC 同口径）：USS = Private_Clean + Private_Dirty（/proc/PID/smaps_rollup），
# 整个进程树（nomi-poc 及全部子孙，含 WebKitWebProcess / NetworkProcess）求和。
# 用法：[NOMI_POC_CTL=… STEPS="close-chat renderer=rive …"] measure-linux.sh <bin> <label> [wait=45]；输出一行：label total_MiB  per-process...
set -u
BIN=$1; LABEL=$2; WAIT=${3:-45}
tree() { local p=$1; echo "$p"; for c in $(pgrep -P "$p"); do tree "$c"; done; }
uss() { awk '/^Private_(Clean|Dirty):/{s+=$2} END{print s+0}' /proc/$1/smaps_rollup 2>/dev/null; }
snap() {
  local t=0 parts=""
  for p in $(tree "$ROOT"); do
    u=$(uss "$p"); [ -z "$u" ] && continue
    t=$((t+u)); parts="$parts $(ps -o comm= -p "$p")=$((u/1024))"
  done
  echo "$LABEL $((t/1024))$parts"
}
"$BIN" > "/tmp/measure-$LABEL.log" 2>&1 & ROOT=$!
sleep "$WAIT"; snap
if [ -n "${STEPS:-}" ]; then # STEPS="renderer=rive renderer=svg ..."，每步后等 15 s 测一次
  for s in $STEPS; do
    q="op=$s"; case $s in *=*) q="op=${s%%=*}&v=${s#*=}";; esac
    curl -s "http://$NOMI_POC_CTL/ctl?$q" >/dev/null; sleep "${STEP_WAIT:-15}"; LABEL="$2:$s" snap
  done
fi
kill "$ROOT"; wait "$ROOT" 2>/dev/null; sleep 2
