#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Web 端音频完整性清单（按解码后的相对路径索引）。

输入是两个已经存在、且互为补充的资产：

- `AntennaPod/app/src/main/assets/yujizi_manifest.json`：专辑 id → 曲目 URL 顺序
- `app/src/main/assets/yujizi_integrity.json`：`专辑id/曲号` → size + sha256

输出 `web/src/core/track-integrity.json`，键是解码后的站点相对路径
（如 `/玉机子/玉机子讲道德经/28416280.m4a`），值是 `{size, sha256}`。
Web 端按 URL 的 pathname 查表，找不到就只做长度校验。

用法：python3 web/scripts/make_track_integrity.py [输出路径]
环境变量可覆盖两个输入路径（YUJIZI_MANIFEST / YUJIZI_INTEGRITY）。
"""
import json
import os
import sys
import urllib.parse

WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(WEB_ROOT)

MANIFEST = os.environ.get(
    "YUJIZI_MANIFEST",
    os.path.join(REPO_ROOT, "..", "AntennaPod", "app", "src", "main", "assets", "yujizi_manifest.json"),
)
INTEGRITY = os.environ.get(
    "YUJIZI_INTEGRITY",
    os.path.join(REPO_ROOT, "app", "src", "main", "assets", "yujizi_integrity.json"),
)
DEFAULT_OUT = os.path.join(WEB_ROOT, "src", "core", "track-integrity.json")


def main(out_path: str) -> None:
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    integrity = json.load(open(INTEGRITY, encoding="utf-8"))["files"]

    files = {}
    missing = []
    for album in manifest["albums"]:
        for index, track in enumerate(album["tracks"]):
            key = "%s/%d" % (album["id"], index)
            expected = integrity.get(key)
            if expected is None:
                missing.append(key)
                continue
            path = urllib.parse.unquote(track["url"])
            if not path.startswith("/"):
                path = "/" + path
            if path in files:
                raise SystemExit("重复的曲目路径：%s" % path)
            files[path] = {"size": int(expected["size"]), "sha256": expected["sha256"].lower()}

    if missing:
        raise SystemExit("清单缺少 %d 条：%s" % (len(missing), missing[:5]))

    payload = {
        "version": 1,
        "comment": "玉机子音频完整性清单：key = 解码后的站点相对路径，由 web/scripts/make_track_integrity.py 生成",
        "files": dict(sorted(files.items())),
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")

    total = sum(entry["size"] for entry in files.values())
    print("写入 %s：%d 首，共 %.1f MB" % (out_path, len(files), total / 1024 / 1024))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT)
