#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为玉机子全部曲目生成完整性清单（字节数 + sha256）。

**优先读本机网站仓库里的源文件**（`~/work/yujizi/`，音频的真正出处），
本机没有的曲目再回退到 HTTP 下载。产物 `yujizi_integrity.json` 随 App 一起打包，
下载完一章后用它校验：长度不符或 sha256 不符就丢弃重下。

2026-10-13 实测：146 首本机源文件与从 www.yujizi.org 下载的内容**逐字节一致**，
所以按本机文件算出来的清单可以直接用于校验服务端下载。

用法：python3 scripts/make_yujizi_integrity.py [输出路径]
"""
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

MANIFEST = "/Users/guci/work/AntennaPod/app/src/main/assets/yujizi_manifest.json"
DEFAULT_OUT = "/Users/guci/work/Timbre/app/src/main/assets/yujizi_integrity.json"

# 网站仓库根目录：音频源文件就在它的 <专辑目录>/ 下
SITE_DIR = "/Users/guci/work/yujizi"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124 Safari/537.36")
CHUNK = 1 << 20


def sha256_file(path: str):
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
            n += len(block)
    return h.hexdigest(), n


def content_length(url: str):
    """HEAD 取服务端声明的字节数；取不到返回 None。"""
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            cl = r.headers.get("Content-Length")
            return int(cl) if cl else None
    except Exception as e:
        print("  HEAD 失败 %s" % e, flush=True)
        return None


def sha256_remote(url: str, expect_size: int, attempts: int = 3):
    """下载并算 sha256；长度不符就重试（这正是要防的那个问题）。"""
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            h = hashlib.sha256()
            n = 0
            with urllib.request.urlopen(req, timeout=120) as r:
                while True:
                    b = r.read(CHUNK)
                    if not b:
                        break
                    h.update(b)
                    n += len(b)
            if n != expect_size:
                print("  长度不符 %d != %d，重试 %d" % (n, expect_size, i + 1), flush=True)
                continue
            return h.hexdigest(), n
        except Exception as e:
            print("  下载失败 %s，重试 %d" % (e, i + 1), flush=True)
            time.sleep(2)
    return None, 0


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    d = json.load(open(MANIFEST))
    base = d["baseUrl"].rstrip("/")

    result = {}
    local_hits = 0
    remote_hits = 0
    failed = []
    total = sum(len(a["tracks"]) for a in d["albums"])
    done = 0

    for a in d["albums"]:
        for idx, t in enumerate(a["tracks"]):
            key = "%s/%d" % (a["id"], idx)
            rel = t["url"].lstrip("/")
            local = os.path.join(SITE_DIR, rel)
            done += 1

            if os.path.exists(local):
                digest, got = sha256_file(local)
                local_hits += 1
                src = "本机"
            else:
                url = base + "/".join(urllib.parse.quote(s) for s in t["url"].split("/"))
                size = content_length(url)
                digest, got = sha256_remote(url, size) if size else (None, 0)
                remote_hits += 1
                src = "网络"

            if digest:
                result[key] = {"size": got, "sha256": digest}
                print("[%d/%d] %s %s %s %.1f MB" % (done, total, src, a["id"], t["name"], got / 1048576), flush=True)
            else:
                failed.append(key)
                print("!! 失败 %s %s" % (key, t["name"]), flush=True)

            json.dump(result, open(out + ".partial", "w"), ensure_ascii=False, indent=1)

    if failed:
        print("有 %d 首失败：%s（先不覆盖正式清单）" % (len(failed), failed), flush=True)
        return 1

    payload = {
        "version": 1,
        "comment": "玉机子曲目完整性清单：key = 专辑id/曲目序号，由 scripts/make_yujizi_integrity.py 生成",
        "files": dict(sorted(result.items())),
    }
    json.dump(payload, open(out, "w"), ensure_ascii=False, indent=1)
    if os.path.exists(out + ".partial"):
        os.remove(out + ".partial")
    total_bytes = sum(v["size"] for v in result.values())
    print("完成：%d 首（本机 %d / 网络 %d），共 %.2f GB -> %s"
          % (len(result), local_hits, remote_hits, total_bytes / 1073741824, out))
    return 0


if __name__ == "__main__":
    sys.exit(main())

