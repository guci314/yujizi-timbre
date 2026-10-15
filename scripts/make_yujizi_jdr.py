#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 AntennaPod 版玉机子清单转成 Timbre 的 .jdr 接口源。

- 9 个专辑 → 9 本书；曲目 → 章节；播放直链 = baseUrl + 相对路径
- 数据全部静态内联进脚本，播放时不需要任何网络请求（除了音频本身）
"""
import json
import os
import zipfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 路径都可用环境变量覆盖：源清单在隔壁的 AntennaPod 仓库里（那是音频清单的出处），
# 产物落在本仓库的 assets 下。默认值按「两个仓库并排放在 ~/work 下」推导，
# 别把作者本机的绝对路径写进代码。
SRC = os.environ.get(
    "YUJIZI_MANIFEST",
    os.path.join(REPO_ROOT, "..", "AntennaPod", "app", "src", "main", "assets", "yujizi_manifest.json"),
)
OUT_DIR = os.environ.get("YUJIZI_ASSETS_DIR", os.path.join(REPO_ROOT, "app", "src", "main", "assets"))
OUT_JDR = os.path.join(OUT_DIR, "yujizi.jdr")

MANIFEST = {
    "id": "org.yujizi.source",
    "name": "玉机子",
    "version": "1.0.0",
    "author": "玉机子",
    "description": "玉机子道长讲经音频：九部经目，可整本缓存离线听",
    "allowInsecure": False,
    "sources": [
        {
            "id": "yujizi",
            "name": "玉机子",
            "script": "yujizi.js",
            "capabilities": ["search", "chapters", "audio"],
        }
    ],
}

JS_TEMPLATE = """;(function () {
  'use strict';

  // 玉机子经目：数据静态内联，播放时除音频本身外不发任何请求。
  var BASE = %(base)s;
  var ALBUMS = %(albums)s;

  // 路径里有中文，必须逐段编码（整串 encodeURI 会把分隔符 / 也一起处理）
  function audioUrl(path) {
    var segs = String(path).split('/');
    var out = [];
    for (var i = 0; i < segs.length; i++) { out.push(urlEncode(segs[i])); }
    return BASE + out.join('/');
  }

  function albumOf(bookId) {
    for (var i = 0; i < ALBUMS.length; i++) {
      if (ALBUMS[i].id === String(bookId)) { return ALBUMS[i]; }
    }
    return null;
  }

  registerSource({
    id: 'yujizi',

    async search(params) {
      var kw = params.keyword == null ? '' : String(params.keyword).trim();
      var out = [];
      for (var i = 0; i < ALBUMS.length; i++) {
        var a = ALBUMS[i];
        if (kw && a.title.indexOf(kw) < 0) { continue; }
        out.push({
          id: a.id,
          bookTitle: a.title,
          bookAnchor: '玉机子道长',
          bookDesc: a.tracks.length + ' 集',
          count: a.tracks.length,
        });
      }
      return out;
    },

    async chapters(params) {
      var a = albumOf(params.bookId);
      if (!a) { throw new Error('找不到经目：' + params.bookId); }
      var out = [];
      for (var i = 0; i < a.tracks.length; i++) {
        out.push({ chapter_id: String(i), title: a.tracks[i].name, order: i + 1 });
      }
      return out;
    },

    async audio(params) {
      var a = albumOf(params.bookId);
      if (!a) { throw new Error('找不到经目：' + params.bookId); }
      var t = a.tracks[Number(params.chapterId)];
      if (!t) { throw new Error('找不到曲目：' + params.chapterId); }
      return audioUrl(t.path);
    },
  });
})();
"""


def main():
    with open(SRC, encoding="utf-8") as f:
        data = json.load(f)

    base = data["baseUrl"].rstrip("/")
    albums = []
    for a in data["albums"]:
        tracks = [{"name": t["name"], "path": t["url"]} for t in a.get("tracks", [])]
        if not tracks:
            continue
        albums.append({"id": a["id"], "title": a["title"], "tracks": tracks})

    js = JS_TEMPLATE % {
        "base": json.dumps(base, ensure_ascii=False),
        "albums": json.dumps(albums, ensure_ascii=False, separators=(",", ":")),
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with zipfile.ZipFile(OUT_JDR, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(MANIFEST, ensure_ascii=False, indent=2))
        z.writestr("yujizi.js", js)

    # 自检：重新打开 zip，确认根层就是这两个文件
    with zipfile.ZipFile(OUT_JDR) as z:
        names = sorted(z.namelist())
        print("包内文件:", names)
        json.loads(z.read("manifest.json").decode("utf-8"))
        print("manifest.json 可解析 ✓")
    print("专辑数: %d, 曲目数: %d" % (len(albums), sum(len(a["tracks"]) for a in albums)))
    print("输出: %s (%d 字节)" % (OUT_JDR, os.path.getsize(OUT_JDR)))


if __name__ == "__main__":
    main()
