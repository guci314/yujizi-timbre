#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为玉机子全部曲目生成完整性清单（字节数 + sha256）。

产物 `yujizi_integrity.json` 随 App 一起打包，下载完一章后用它校验：
长度不符或 sha256 不符就丢弃重下。内容更新后重跑本脚本即可。

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
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124 Safari/537.36")
CHUNK = 1 << 20


def sha256_of(url: str, expect_size: int, attempts: int = 3):
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
    sizes = {r["url"]: r for r in json.load(open("/tmp/yujizi_sizes.json"))}
    d = json.load(open(MANIFEST))
    base = d["baseUrl"].rstrip("/")

    result = {}
    done = 0
    failed = []
    for a in d["albums"]:
        tracks = a["tracks"]
        for idx, t in enumerate(tracks):
            url = base + "/".join(urllib.parse.quote(s) for s in t["url"].split("/"))
            size = sizes[url]["size"]
            digest, got = sha256_of(url, size)
            key = "%s/%d" % (a["id"], idx)
            if digest:
                result[key] = {"size": got, "sha256": digest}
                done += 1
                print("[%d/%d] %s %s %.1f MB" % (done, 146, a["id"], t["name"], got / 1048576), flush=True)
            else:
                failed.append(key)
                print("!! 失败 %s %s" % (key, t["name"]), flush=True)
            # 边算边落盘，中断了不用从头再来
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
    total = sum(v["size"] for v in result.values())
    print("完成：%d 首，共 %.2f GB -> %s" % (len(result), total / 1073741824, out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
