#!/usr/bin/env python3
"""2.0.5 Go vs 2.0.4 Electron 同 runner 基准（批次 11）。

  bench.py --label go --exe <已安装的可执行文件> --userdata <dir> [--userdata <dir2>] --out <dir> [--runs 3] [--idle5 300]

每轮（共 --runs 轮，结果取中位数）：
  1. 杀掉残留进程，删 userData（全新用户）；Linux 上 drop_caches、mac 上 purge（尽量“冷”）
  2. 冷启动：启动 → 轮询到看板娘窗口（h/w≈355/330 的可见窗口）出现 = cold_s
  3. 静置 30s → 采样 idle（进程树 USS/RSS 之和、进程数），再采 30s CPU 平均（idle CPU%）
  4. 再启动一次同一可执行文件（单实例 → 把主界面/对话窗带到前台，两版语义相同）→ 15s 后采样 main
  5. 等到启动后 --idle5 秒 → 采样 after5m
  6. 退出 → 立即再启动 → 看板娘窗口出现 = warm_s（userData 保留，文件缓存热）→ 退出
“对话中”需要模型凭据，CI 不测（报告标 N/A）。不点击看板娘、不触发任何动作。
输出 <out>/<label>.json（每轮原始值 + 中位数）。
"""
import argparse, json, os, platform, shutil, statistics, subprocess, sys, time
import psutil

SYS = platform.system()
ASPECT = 355 / 330
HERE = os.path.dirname(os.path.abspath(__file__))


def tree(root_pids, t0):
    """进程树；mac 上 WebKit 子进程由 launchd 拉起，按启动时间 ≥ t0 归入。"""
    seen = {}
    for pid in list(root_pids):
        try:
            p = psutil.Process(pid)
            seen[p.pid] = p
            for c in p.children(recursive=True):
                seen[c.pid] = c
        except psutil.Error:
            pass
    if SYS == "Darwin":
        for p in psutil.process_iter(["name", "create_time"]):
            n = p.info["name"] or ""
            if n.startswith("com.apple.WebKit") and (p.info["create_time"] or 0) >= t0 - 1:
                seen[p.pid] = p
    return list(seen.values())


def roots(name):
    out = []
    for p in psutil.process_iter(["name", "exe"]):
        n = (p.info["name"] or "").lower()
        if n in (name.lower(), name.lower() + ".exe"):
            out.append(p.pid)
    return out


def windows_of(pids):
    pids = set(pids)
    res = []
    if SYS == "Windows":
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        try:
            u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # 每显示器 v2：拿物理像素
        except Exception:
            pass
        CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        def cb(h, _):
            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(h, ctypes.byref(pid))
            if pid.value in pids and u.IsWindowVisible(h):
                r = wintypes.RECT()
                u.GetWindowRect(h, ctypes.byref(r))
                res.append((r.right - r.left, r.bottom - r.top))
            return True
        u.EnumWindows(CB(cb), 0)
    elif SYS == "Darwin":
        out = subprocess.run([os.path.join(HERE, "winlist")], capture_output=True, text=True).stdout
        for line in out.splitlines():
            f = line.split("\t")
            if len(f) >= 3 and int(f[0]) in pids:
                res.append((int(f[1]), int(f[2])))
    else:
        for pid in pids:
            out = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(pid)], capture_output=True, text=True).stdout
            for w in out.split():
                g = subprocess.run(["xdotool", "getwindowgeometry", "--shell", w], capture_output=True, text=True).stdout
                d = dict(x.split("=", 1) for x in g.split() if "=" in x)
                if "WIDTH" in d:
                    res.append((int(d["WIDTH"]), int(d["HEIGHT"])))
    return res


def mascot(ws):
    for w, h in ws:
        if w >= 150 and abs(h / max(w, 1) - ASPECT) < 0.08:
            return (w, h)
    return None


def launch(exe):
    kw = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if SYS == "Windows":
        kw["creationflags"] = 0x00000008  # DETACHED_PROCESS
    else:
        kw["start_new_session"] = True
    return subprocess.Popen([exe], **kw)


def wait_mascot(name, first, t0, timeout=120):
    while time.time() - t0 < timeout:
        rs = set(roots(name)) | {first.pid}
        ps = [p.pid for p in tree(rs, t0)]
        m = mascot(windows_of(ps))
        if m:
            return time.time() - t0, m
        time.sleep(0.1)
    return None, None


def snap(name, first, t0):
    ps = tree(set(roots(name)) | {first.pid}, t0)
    uss = rss = 0
    for p in ps:
        try:
            mi = p.memory_full_info()
            uss += mi.uss
            rss += mi.rss
        except psutil.Error:
            try:
                rss += p.memory_info().rss
            except psutil.Error:
                pass
    return {"uss_mib": round(uss / 2**20, 1), "rss_mib": round(rss / 2**20, 1), "procs": len(ps),
            "names": sorted({(p.name() if p.is_running() else "?") for p in ps})}


def cpu(name, first, t0, secs=30):
    ps = tree(set(roots(name)) | {first.pid}, t0)
    for p in ps:
        try:
            p.cpu_percent(None)
        except psutil.Error:
            pass
    time.sleep(secs)
    tot = 0.0
    for p in ps:
        try:
            tot += p.cpu_percent(None)
        except psutil.Error:
            pass
    return round(tot, 2)  # 100 = 一个逻辑核满载


def kill_all(name, t0=0):
    for _ in range(3):
        rs = roots(name)
        ps = tree(rs, t0 or time.time() + 1e9) if rs else []
        for p in ps:
            try:
                p.kill()
            except psutil.Error:
                pass
        if not rs:
            break
        time.sleep(2)
    if SYS == "Darwin":
        subprocess.run(["pkill", "-f", "com.apple.WebKit.WebContent"], capture_output=True)
    time.sleep(3)


def drop_caches():
    if SYS == "Linux":
        subprocess.run("sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null", shell=True)
    elif SYS == "Darwin":
        subprocess.run(["sudo", "purge"], capture_output=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--exe", required=True)
    ap.add_argument("--name", default="Nomi", help="主进程名（AppImage 解包后仍为 Nomi/nomi）")
    ap.add_argument("--userdata", action="append", default=[])
    ap.add_argument("--out", required=True)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--idle5", type=int, default=300)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    runs = []
    for i in range(a.runs):
        kill_all(a.name)
        for d in a.userdata:
            shutil.rmtree(d, ignore_errors=True)
        drop_caches()
        r = {"run": i + 1}
        t0 = time.time()
        p = launch(a.exe)
        r["cold_s"], r["mascot_px"] = wait_mascot(a.name, p, t0)
        time.sleep(30)
        r["idle"] = snap(a.name, p, t0)
        r["cpu_idle_pct"] = cpu(a.name, p, t0)
        q = launch(a.exe)  # 第二实例 → 主界面
        time.sleep(15)
        r["main"] = snap(a.name, p, t0)
        r["main_windows"] = windows_of([x.pid for x in tree(set(roots(a.name)) | {p.pid}, t0)])
        try:
            q.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        rest = a.idle5 - (time.time() - t0)
        if rest > 0:
            time.sleep(rest)
        r["after5m"] = snap(a.name, p, t0)
        kill_all(a.name, t0)
        t1 = time.time()
        p2 = launch(a.exe)
        r["warm_s"], _ = wait_mascot(a.name, p2, t1)
        time.sleep(5)
        kill_all(a.name, t1)
        print(json.dumps(r, ensure_ascii=False), flush=True)
        runs.append(r)

    def med(get):
        v = [get(r) for r in runs]
        v = [x for x in v if x is not None]
        return round(statistics.median(v), 3) if v else None
    summary = {
        "cold_s": med(lambda r: r["cold_s"]), "warm_s": med(lambda r: r["warm_s"]),
        "idle_uss_mib": med(lambda r: r["idle"]["uss_mib"]), "idle_rss_mib": med(lambda r: r["idle"]["rss_mib"]),
        "main_uss_mib": med(lambda r: r["main"]["uss_mib"]), "main_rss_mib": med(lambda r: r["main"]["rss_mib"]),
        "after5m_uss_mib": med(lambda r: r["after5m"]["uss_mib"]), "after5m_rss_mib": med(lambda r: r["after5m"]["rss_mib"]),
        "procs_idle": med(lambda r: r["idle"]["procs"]), "procs_main": med(lambda r: r["main"]["procs"]),
        "cpu_idle_pct": med(lambda r: r["cpu_idle_pct"]),
    }
    json.dump({"label": a.label, "os": SYS, "exe": a.exe, "runs": runs, "median": summary},
              open(os.path.join(a.out, a.label + ".json"), "w"), indent=2, ensure_ascii=False)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    sys.exit(main())
