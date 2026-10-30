#!/usr/bin/env python3
"""生成 Go 版更新元数据（替代 electron-builder 的 latest*.yml + blockmap）。

  python3 update-manifest.py <version> <artifact-dir> [--tag v2.0.5] [--repo Cookieboty/nomi-ai]

写出 <artifact-dir>/latest-go.json、SHA256SUMS，以及给 2.0.4（Electron，electron-updater 6.8.9）用的
latest.yml / latest-mac.yml / latest-linux.yml：格式与 electron-builder 生成的相同（url 相对 Release、sha512 为
base64、size），2.0.4 据此下载 Go 版安装包（Windows 跑 NSIS 安装器 --updated --force-run 覆盖升级；mac 经
Squirrel.Mac 替换 Nomi.app，要求与 2.0.4 同一签名身份；Linux 替换 AppImage）。不出 blockmap：electron-updater
取不到 blockmap 时整包下载（Electron 与 Go 的包也没有可复用的块）。2.0.5+ 的 Go 版更新检查读取
https://github.com/<repo>/releases/latest/download/latest-go.json，比较 version，按当前平台挑出
platforms[<os>-<arch>] 的安装包，弹窗引导下载（不自动替换，见 docs/design/migrate-2.0.5-go.md 批次 11）。
schema（schemaVersion=1）：
  {schemaVersion, version, tag, releaseDate, releaseUrl,
   platforms: {"darwin-arm64"|"darwin-amd64"|"windows-amd64"|"linux-amd64"|"linux-amd64-deb":
               {file, url, size, sha256}}}
"""
import argparse, base64, datetime, hashlib, json, os, sys

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()

def sha512_b64(p):
    h = hashlib.sha512()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return base64.b64encode(h.digest()).decode()

def write_yml(path, version, names, d, release_date):
    """electron-builder 的 UpdateInfo（latest*.yml）：files 列表 + 首个文件的 path / sha512（旧字段，旧版 updater 读）"""
    files = [(n, sha512_b64(os.path.join(d, n)), os.path.getsize(os.path.join(d, n))) for n in names]
    lines = [f"version: {version}", "files:"]
    for n, h, size in files:
        lines += [f"  - url: {n}", f"    sha512: {h}", f"    size: {size}"]
    lines += [f"path: {files[0][0]}", f"sha512: {files[0][1]}", f"releaseDate: '{release_date}'"]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")

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
    # 2.0.4 → 2.0.5：electron-updater 的更新元数据。mac 的 zip 排在前面（MacUpdater 只挑 zip，按文件名里的 arm64 分架构）
    rd = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    write_yml(os.path.join(a.dir, "latest.yml"), v, [want["windows-amd64"]], a.dir, rd)
    write_yml(os.path.join(a.dir, "latest-mac.yml"), v,
              [f"Nomi-{v}-arm64-mac.zip", want["darwin-arm64"], f"Nomi-{v}-mac.zip", want["darwin-amd64"]], a.dir, rd)
    write_yml(os.path.join(a.dir, "latest-linux.yml"), v, [want["linux-amd64"]], a.dir, rd)
    with open(os.path.join(a.dir, "latest-go.json"), "w") as f:
        json.dump(out, f, indent=2); f.write("\n")
    with open(os.path.join(a.dir, "SHA256SUMS"), "w") as f:
        for d, n in sorted(sums, key=lambda t: t[1]): f.write(f"{d}  {n}\n")
    print(json.dumps(out, indent=2))

if __name__ == "__main__":
    main()
