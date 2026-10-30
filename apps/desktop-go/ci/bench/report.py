#!/usr/bin/env python3
"""bench 输出 → markdown 表。用法：report.py <out 目录> <平台> <运行链接>"""
import glob, json, os, sys
out, plat, link = sys.argv[1:4]
print(f"### {plat} — 2.0.5 Go vs 2.0.4 Electron（3 轮中位数，[run]({link})）\n")
p = os.path.join(out, "sizes.tsv")
if os.path.exists(p):
    print("| 版本 | 项 | 值 |\n|---|---|---|")
    for line in open(p, encoding="utf-8-sig"):
        f = line.rstrip("\n").split("\t")
        if len(f) != 3:
            continue
        v = f[2]
        if f[1] == "installed":
            v = f"{int(v)/1024:.1f} MiB"
        elif f[1] != "install_seconds":
            v = f"{int(v):,} B ({int(v)/2**20:.1f} MiB)"
        print(f"| {f[0]} | {f[1]} | {v} |")
    print()
keys = ["cold_s", "warm_s", "idle_uss_mib", "idle_rss_mib", "main_uss_mib", "main_rss_mib",
        "after5m_uss_mib", "after5m_rss_mib", "procs_idle", "procs_main", "cpu_idle_pct"]
res = {os.path.basename(f)[:-5]: json.load(open(f)) for f in sorted(glob.glob(os.path.join(out, "*.json")))}
if res:
    print("| 指标 | " + " | ".join(res) + " |\n|---|" + "---|" * len(res))
    for k in keys:
        print(f"| {k} | " + " | ".join(str(r["median"].get(k)) for r in res.values()) + " |")
    print("| mascot_px | " + " | ".join(str([x.get('mascot_px') for x in r['runs']][0]) for r in res.values()) + " |")
    print("| during chat | " + " | ".join("N/A（需模型凭据）" for _ in res) + " |")
    for lab, r in res.items():
        st = r["runs"][0].get("stages_ms")
        if st:
            print(f"\n{lab} 启动阶段（run1，相对 t0 ms）：" + "，".join(f"{k}={v}" for k, v in st.items()))
        by = r["runs"][0]["idle"].get("by_name_mib")
        if by:
            print(f"\n{lab} idle 分进程 MiB：" + "，".join(f"{k}={v}" for k, v in sorted(by.items(), key=lambda x: -x[1])))
