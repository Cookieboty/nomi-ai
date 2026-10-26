#!/usr/bin/env python3
"""
生成诺米提示语音（预录片段）：packages/renderer/public/voice/nomi/zh/<key>.mp3 + manifest.json。

- 台词文字取自 @nomi-ai/i18n 中文文案（packages/i18n/src/locales/zh/**），key 列表取自现有 manifest；
  带变量的台词用 VARIABLE_LINES 里的固定句。
- 默认用 edge-tts（微软 Edge 在线 Neural 朗读，zh-CN-XiaoyiNeural，语速 -5%，音调 +0Hz）。
  Edge 在线服务输出的再分发许可不明确：正式发布前请用 Azure Speech 订阅（同一音色）重新生成。

用法：
  pip install edge-tts            # 另需 ffprobe（ffmpeg）读取时长
  python3 scripts/voice/gen.py                 # 重新生成 manifest 里的全部片段
  python3 scripts/voice/gen.py --only KEY ...  # 只重新生成指定 key
  python3 scripts/voice/gen.py --add KEY ...   # 新增固定台词（文字取自中文文案）
"""

from __future__ import annotations

import argparse
import asyncio
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(ROOT, "packages/renderer/public/voice/nomi/zh")
LOCALE_GLOB = os.path.join(ROOT, "packages/i18n/src/locales/zh/**/*.json")

VOICE = "zh-CN-XiaoyiNeural"
RATE = "-5%"
PITCH = "+0Hz"
VOLUME = "+0%"
FORMAT = "audio-24khz-48kbitrate-mono-mp3"

# 带变量的台词：气泡显示完整文字，语音只念固定句（key 与 renderer 的 CLIP_HINTS 对应）
VARIABLE_LINES = {
    "ui.voice-mascot.switched-to-mode.fixed": "已切换到固定语音模式",
    "ui.voice-mascot.switched-to-mode.tts": "已切换到实时朗读模式",
    "ui.voice-mascot.couldn-t-open": "打开失败了，请稍后再试",
    "ui.voice-mascot.couldn-t-open-the-microphone": "无法打开麦克风",
    "ui.voice-mascot.you-missed-reminders-while-away": "你不在的时候有错过的提醒哦",
}

# 朗读时的读法替换（气泡文字不变）
SPOKEN_REPLACEMENTS = [(re.compile(r"Nomi"), "诺米")]


def load_zh() -> dict[str, str]:
    zh: dict[str, str] = {}
    for f in glob.glob(LOCALE_GLOB, recursive=True):
        with open(f, encoding="utf-8") as fh:
            zh.update(json.load(fh))
    return zh


def load_manifest() -> dict:
    p = os.path.join(OUT_DIR, "manifest.json")
    if not os.path.exists(p):
        return {"clips": []}
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def spoken(text: str) -> str:
    for pat, rep in SPOKEN_REPLACEMENTS:
        text = pat.sub(rep, text)
    return text


def duration(path: str) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]
    )
    return round(float(out), 2)


async def synth(key: str, text: str, category: str, sem: asyncio.Semaphore) -> dict:
    import edge_tts  # noqa: PLC0415 — 只在真正生成时需要

    say = spoken(text)
    path = os.path.join(OUT_DIR, f"{key}.mp3")
    async with sem:
        for attempt in range(3):
            try:
                await edge_tts.Communicate(say, VOICE, rate=RATE, pitch=PITCH, volume=VOLUME).save(path)
                break
            except Exception as e:  # 网络抖动：重试
                if attempt == 2:
                    raise
                print(f"retry {key}: {e}", file=sys.stderr)
    return {
        "key": key,
        "text": text,
        "spoken_text": say,
        "file": f"{key}.mp3",
        "duration_s": duration(path),
        "size_bytes": os.path.getsize(path),
        "category": category,
    }


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", default=None, help="只重新生成这些 key")
    ap.add_argument("--add", nargs="*", default=[], help="新增固定台词 key")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    zh = load_zh()
    manifest = load_manifest()
    existing = {c["key"]: c for c in manifest.get("clips", [])}

    order = list(existing) + [k for k in args.add if k not in existing]
    order += [k for k in VARIABLE_LINES if k not in order]
    targets = set(args.only) if args.only is not None else set(order)

    jobs = []
    sem = asyncio.Semaphore(6)
    for key in order:
        if key not in targets:
            continue
        if key in VARIABLE_LINES:
            jobs.append(synth(key, VARIABLE_LINES[key], "variable", sem))
            continue
        text = zh.get(key)
        if text is None:
            sys.exit(f"{key}: 中文文案里没有这个 key（台词已删除？先从 manifest 移除）")
        if re.search(r"\{\d+\}", text):
            sys.exit(f"{key}: 台词带变量，请在 VARIABLE_LINES 里给固定句")
        jobs.append(synth(key, text, existing.get(key, {}).get("category", "line"), sem))

    done = {c["key"]: c for c in await asyncio.gather(*jobs)}
    clips = [done.get(k) or existing[k] for k in order if k in done or k in existing]

    out = {
        "voice": VOICE,
        "rate": RATE,
        "pitch": PITCH,
        "volume": VOLUME,
        "format": FORMAT,
        "style": "default",
        "count": len(clips),
        "generator": "scripts/voice/gen.py (edge-tts)",
        "clips": clips,
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    total = sum(c["size_bytes"] for c in clips)
    print(f"{len(done)} generated, {len(clips)} clips, {total / 1024:.0f} KiB")


if __name__ == "__main__":
    asyncio.run(main())
