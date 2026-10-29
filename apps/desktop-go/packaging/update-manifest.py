#!/usr/bin/env python3
"""生成 Go 版更新元数据（替代 electron-builder 的 latest*.yml + blockmap）。

  python3 update-manifest.py <version> <artifact-dir> [--tag v2.0.5] [--repo Cookieboty/nomi-ai]

写出 <artifact-dir>/latest-go.json 与 SHA256SUMS。2.0.5+ 的 Go 版更新检查读取
https://github.com/<repo>/releases/latest/download/latest-go.json，比较 version，按当前平台挑出
platforms[<os>-<arch>] 的安装包，弹窗引导下载（不自动替换，见 docs/design/migrate-2.0.5-go.md 批次 11）。
schema（schemaVersion=1）：
  {schemaVersion, version, tag, releaseDate, releaseUrl,
   platforms: {"darwin-arm64"|"darwin-amd64"|"windows-amd64"|"linux-amd64"|"linux-amd64-deb":
               {file, url, size, sha256}}}
"""
import argparse, datetime, hashlib, json, os, sys

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version"); ap.add_argument("dir")
    ap.add_argument("--tag"); ap.add_argument("--repo", default="Cookieboty/nomi-ai")
    a = ap.parse_args()
    v, tag = a.version, a.tag or f"v{a.version}"
    want = {
        "darwin-arm64": f"Nomi-{v}-arm64.dmg",
        "darwin-amd64": f"Nomi-{v}.dmg",
        "windows-amd64": f"Nomi-Setup-{v}.exe",
        "linux-amd64": f"Nomi-{v}.AppImage",
        "linux-amd64-deb": f"nomi_{v}_amd64.deb",
    }
    extra = [f"Nomi-{v}-arm64-mac.zip", f"Nomi-{v}-mac.zip"]
    base = f"https://github.com/{a.repo}/releases/download/{tag}"
    plats, sums, missing = {}, [], []
    for key, name in want.items():
        p = os.path.join(a.dir, name)
        if not os.path.isfile(p):
            missing.append(name); continue
        d = sha256(p)
        plats[key] = {"file": name, "url": f"{base}/{name}", "size": os.path.getsize(p), "sha256": d}
    for name in extra:
        p = os.path.join(a.dir, name)
        if os.path.isfile(p): sums.append((sha256(p), name))
        else: missing.append(name)
    if missing:
        print("missing artifacts: " + ", ".join(missing), file=sys.stderr); sys.exit(1)
    sums += [(x["sha256"], x["file"]) for x in plats.values()]
    out = {
        "schemaVersion": 1, "version": v, "tag": tag,
        "releaseDate": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "releaseUrl": f"https://github.com/{a.repo}/releases/tag/{tag}",
        "platforms": plats,
    }
    with open(os.path.join(a.dir, "latest-go.json"), "w") as f:
        json.dump(out, f, indent=2); f.write("\n")
    with open(os.path.join(a.dir, "SHA256SUMS"), "w") as f:
        for d, n in sorted(sums, key=lambda t: t[1]): f.write(f"{d}  {n}\n")
    print(json.dumps(out, indent=2))

if __name__ == "__main__":
    main()
