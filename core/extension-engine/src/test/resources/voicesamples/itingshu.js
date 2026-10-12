// 爱听书 免密接口源（搜索 / 章节 / 音频直链）
// 由 Python 版移植：MD5 时间戳 token + AES-128-ECB 签名，无需登录。
;(function () {
  'use strict';

  var HOST = 'https://api.itingshu.iiisss.top';
  var TOKET = 'z7jhAuyG95HkBONdHjJMl6C7yfxVnKoz';
  var BOOK_TOKEN = '1275675fe60b81e30a48cd697e1919dd';
  var USER = 'T5r-GISZAKuF9_rPpwwhgZ8lDhHg23n0deKF_VVuuAeA064wtLcYhVCsFSOOd_WksQ0G6fjDuDvDHDTIuWA_K2srN2vGj1u3NImRf4j9H-o';
  var DEVICE_KEY = 'ag5fmPpUrWwDAMY6';
  var APP_VERSION = '2.6.5';
  var SIGN = 'pHdavmlvyH2M7ydMAGlKJ+jYP/G+IrgTYHwI8zvzXIc=';
  var LIMIT = 30;

  function baseHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 uni-app',
      'x-Requested-With': 'com.itingshu.hearbook',
      Accept: 'application/json',
      sign: SIGN,
    };
  }

  function md5Token(ts) {
    return md5Hex(TOKET + ts);
  }

  registerSource({
    id: 'itingshu',

    // ---------- 搜索 ----------
    async search(params) {
      var keyword = String(params.keyword || '');
      var page = params.page || 1;
      var offset = (page - 1) * LIMIT + 1;
      var ts = timestamp();
      var resp = await http.get(HOST + '/api/itingshu/cloudsearch', {
        headers: baseHeaders(),
        params: {
          platform: 'qq',
          key: keyword,
          type: 1,
          limit: LIMIT,
          offset: offset,
          types: 'lastupdate',
          time: ts,
          token: md5Token(ts),
          appVersion: APP_VERSION,
        },
        timeoutMs: 15000,
      });
      if (resp.status !== 200) throw new Error('搜索失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      var list = (data && data.data) || [];
      var result = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var novel = item.novel || {};
        var author = item.author || {};
        if (!novel.id || !novel.name) continue;
        result.push({
          id: String(novel.id),
          bookTitle: novel.name,
          bookImage: novel.cover || '',
          bookAnchor: author.name || '',
          bookDesc: novel.intro || '',
          count: novel.tracks || 0,
          heat: novel.plays || 0,
          platform: 'qq',
        });
      }
      return result;
    },

    // ---------- 章节 ----------
    async chapters(params) {
      var bookId = String(params.bookId || '');
      if (!bookId) throw new Error('缺少 bookId，请从搜索结果进入');
      var ts = timestamp();
      var resp = await http.get(HOST + '/api/itingshu/bookdirst', {
        headers: baseHeaders(),
        params: {
          id: bookId,
          user: USER,
          time: ts,
          token: BOOK_TOKEN,
          appVersion: APP_VERSION,
        },
        timeoutMs: 20000,
      });
      if (resp.status !== 200) throw new Error('章节获取失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      var list = (data && data.list) || [];
      var result = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item.id || !item.name) continue;
        result.push({
          chapter_id: String(item.id),
          title: item.name,
          order: i + 1,
          oid: String(item.oid || ''),
          bookId: bookId,
        });
      }
      return result;
    },

    // ---------- 音频直链 ----------
    async audio(params) {
      var bookId = String(params.bookId || '');
      var chapterId = String(params.chapterId || params.chapter_id || params.oid || '');
      if (!bookId || !chapterId) throw new Error('缺少 bookId/chapterId');
      var ts = timestamp();
      var innerMd5 = md5Hex(bookId + '-' + chapterId + '.mp3');
      var innerSign = aesEcbEncryptB64(APP_VERSION + '-' + ts + '-' + innerMd5, DEVICE_KEY);
      var encrypted = aesEcbEncryptB64(JSON.stringify({
        bookID: bookId,
        chapterID: chapterId,
        time: ts,
        koten: USER,
        sign: innerSign,
      }), DEVICE_KEY);
      var resp = await http.get(HOST + '/api/itingshu/audio', {
        headers: baseHeaders(),
        params: {
          encrypted: encrypted,
          time: String(ts),
          token: md5Token(ts),
          appVersion: APP_VERSION,
        },
        timeoutMs: 30000,
      });
      if (resp.status !== 200) throw new Error('音频获取失败: HTTP ' + resp.status);
      var data = JSON.parse(resp.body);
      if (data && data.data && data.data.src) return data.data.src;
      var text = resp.body;
      var m = text.match(/https?:\/\/[^"\s]+\.(mp3|m4a|mp4)[^"\s]*/);
      if (m) return m[0];
      throw new Error('未找到音频URL: ' + text.slice(0, 120));
    },
  });
})();
