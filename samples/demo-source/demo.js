// 最小示例接口源：演示三阶段的标准字段与透传规则。
// HOST 是占位地址，替换成你的真实接口即可（本示例不做任何加密/签名）。
;(function () {
  'use strict';

  var HOST = 'https://api.example.com';

  registerSource({
    id: 'demosource', // 必须与 manifest.sources[].id 一致

    // ---------- 搜索 ----------
    // 入参: { keyword, page, limit }
    // 出参: [{ id, bookTitle, bookImage?, bookAnchor?, bookDesc?, count?, ...自定义 }]
    async search(params) {
      var resp = await http.get(HOST + '/search', {
        params: { key: params.keyword, page: params.page, limit: params.limit },
        headers: { Accept: 'application/json' },
        timeoutMs: 15000,
      });
      if (resp.status !== 200) throw new Error('搜索失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      var list = data.list || [];
      var result = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item.id || !item.title) continue;
        result.push({
          id: String(item.id),
          bookTitle: item.title,
          bookImage: item.cover || '',
          bookAnchor: item.author || '',
          bookDesc: item.intro || '',
          count: item.tracks || 0,
          // 自定义字段会透传给 chapters 阶段的 params
          albumId: String(item.album_id || item.id),
        });
      }
      return result;
    },

    // ---------- 章节 ----------
    // 入参: { bookId, page, size, albumId(透传), ...search 自定义字段 }
    // 出参: [{ chapter_id, title, order?, duration?, ...自定义 }]
    async chapters(params) {
      var albumId = String(params.albumId || params.bookId);
      var resp = await http.get(HOST + '/chapters/' + albumId, { timeoutMs: 20000 });
      if (resp.status !== 200) throw new Error('章节获取失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      var list = data.chapters || [];
      var result = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item.id || !item.title) continue;
        result.push({
          chapter_id: String(item.id),
          title: item.title,
          order: item.index || i + 1,
          duration: item.duration || 0,
          // 自定义字段会透传给 audio 阶段的 params
          albumId: albumId,
        });
      }
      return result;
    },

    // ---------- 音频直链 ----------
    // 入参: { bookId, chapterId, albumId(透传), order(透传), ...chapters 自定义字段 }
    // 出参: 'https://....mp3' 字符串（或 { url: '...' }）
    async audio(params) {
      var resp = await http.post(HOST + '/play', {
        json: { albumId: String(params.albumId || params.bookId), chapterId: String(params.chapterId) },
        headers: { Accept: 'application/json' },
        timeoutMs: 30000,
      });
      if (resp.status !== 200) throw new Error('音频获取失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      if (data && data.url) return String(data.url);
      // 兜底：从响应文本里正则提取一个音频直链
      var m = resp.body.match(/https?:\/\/[^"\s]+\.(mp3|m4a|mp4)[^"\s]*/);
      if (m) return m[0];
      throw new Error('未找到音频URL');
    },
  });
})();
