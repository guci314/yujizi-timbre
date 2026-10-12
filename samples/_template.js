// ============================================================
// Timbre 接口源开发模板（.jdr 扩展包）
// ------------------------------------------------------------
// 一个 .jdr 包 = ZIP 文件（后缀 .jdr），内含：
//   manifest.json   包描述 + 源声明（见下方注释）
//   yoursource.js   源脚本（可多个）
//
// manifest.json 示例：
// {
//   "id": "com.example.mysource",          // 全局唯一，小写字母/数字/._-
//   "name": "我的接口源",                   // 显示名
//   "version": "1.0.0",                     // 更新时必须递增
//   "author": "you",
//   "description": "一句话描述",
//   "homepage": "https://...",
//   "allowInsecure": false,                 // true = 允许该包的 http 桥信任坏证书
//   "sources": [{
//     "id": "mysource",                     // 全局唯一的源 id（路由键 jdr:mysource）
//     "name": "我的源",                     // 搜索页 chip 上显示的名字
//     "script": "yoursource.js",            // 包内脚本路径
//     "capabilities": ["search", "chapters", "audio"]
//   }]
// }
//
// 脚本约定：自注册 IIFE，调用 registerSource()，三个 async 阶段函数。
// 标准字段（与参考契约一致，自定义字段会在阶段间透传）：
//   search   → [{ id, bookTitle, bookImage?, bookAnchor?, bookDesc?, count?, heat?, ...自定义 }]
//   chapters → [{ chapter_id, title, order?, duration?, ...自定义 }]
//   audio    → "https://....mp3"（或 { url: "..." }）
// 透传规则：search 结果的自定义字段会合并进 chapters 的 params；
//          chapters 结果的自定义字段会合并进 audio 的 params。
//   params: search   = { keyword, page, limit }
//           chapters = { bookId, page, size, ...search自定义字段 }
//           audio    = { bookId, chapterId, ...chapters自定义字段 }
// 出错直接 throw new Error('原因')，会显示在界面上。
// ============================================================
;(function () {
  'use strict';

  var HOST = 'https://api.example.com';

  registerSource({
    id: 'mysource', // 必须与 manifest.sources[].id 一致

    // ---------- 搜索 ----------
    async search(params) {
      // params = { keyword, page, limit }
      var resp = await http.get(HOST + '/search', {
        params: { key: params.keyword, page: params.page, limit: params.limit },
        headers: { 'User-Agent': 'MySource/1.0' },
        timeoutMs: 15000,
      });
      if (resp.status !== 200) throw new Error('搜索失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      return (data.list || []).map(function (item) {
        return {
          id: String(item.id),
          bookTitle: item.title,
          bookImage: item.cover || '',
          bookAnchor: item.author || '',
          bookDesc: item.intro || '',
          count: item.tracks || 0,
          // 自定义字段会被透传给 chapters
          albumId: String(item.album_id || ''),
        };
      });
    },

    // ---------- 章节 ----------
    async chapters(params) {
      // params = { bookId, page, size, albumId(透传) }
      var albumId = String(params.albumId || params.bookId);
      var resp = await http.get(HOST + '/chapters/' + albumId, { timeoutMs: 20000 });
      if (resp.status !== 200) throw new Error('章节获取失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      return (data.chapters || []).map(function (item, idx) {
        return {
          chapter_id: String(item.id),
          title: item.title,
          order: item.index || idx + 1,
          duration: item.duration || 0,
          // 自定义字段会被透传给 audio
          albumId: albumId,
        };
      });
    },

    // ---------- 音频直链 ----------
    async audio(params) {
      // params = { bookId, chapterId, albumId(透传), order(透传) }
      var resp = await http.post(HOST + '/play', {
        json: { albumId: params.albumId, chapterId: params.chapterId },
        timeoutMs: 30000,
      });
      if (resp.status !== 200) throw new Error('音频获取失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      if (data && data.url) return String(data.url);
      throw new Error('未找到音频URL');
    },
  });
})();
