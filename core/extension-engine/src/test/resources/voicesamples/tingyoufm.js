// 听友FM 免密接口源（搜索 / 章节 / 音频直链）
// 由 Python 版完整移植：guest 授权 + AES-GCM/XChaCha 加密载荷 + 纯算法 dfp 设备指纹。
// 每次启动用全新 dfp 调 guest 获取凭证，无需登录。
;(function () {
  'use strict';

  var KEY = hexToBytes('ea9d9d4f9a983fe6f6382f29c7b46b8d6dc47abc6da36662e6ddff8c78902f65');
  var UA = 'azybk_1.0.8(HBP-AL00,Android32)';
  var BASE = 'https://azybk.tingyou8.vip/apk';
  var JSON_BASE = 'https://json.hgeuz.cn/azybk/json_v1';

  // ---- dfp 指纹：libtokendecoder.so encryptFingerprint 的忠实复现 ----
  var SBOX = [214, 144, 233, 254, 204, 225, 61, 183, 22, 182, 20, 194, 40, 251, 44, 5, 43, 103, 154, 118, 42, 190, 4, 195, 170, 68, 19, 38, 73, 134, 6, 153, 156, 66, 80, 244, 145, 239, 152, 122, 51, 84, 11, 67, 237, 207, 172, 98, 228, 179, 28, 169, 201, 8, 232, 149, 128, 223, 148, 250, 117, 143, 63, 166, 71, 7, 167, 252, 243, 115, 23, 186, 131, 89, 60, 25, 230, 133, 79, 168, 104, 107, 129, 178, 113, 100, 218, 139, 248, 235, 15, 75, 112, 86, 157, 53, 30, 36, 14, 94, 99, 88, 209, 162, 37, 34, 124, 59, 1, 33, 120, 135, 212, 0, 70, 87, 159, 211, 39, 82, 76, 54, 2, 231, 160, 196, 200, 158, 234, 191, 138, 210, 64, 199, 56, 181, 163, 247, 242, 206, 249, 97, 21, 161, 224, 174, 93, 164, 155, 52, 26, 85, 173, 147, 50, 48, 245, 140, 177, 227, 29, 246, 226, 46, 130, 102, 202, 96, 192, 41, 35, 171, 13, 83, 78, 111, 213, 219, 55, 69, 222, 253, 142, 47, 3, 255, 106, 114, 109, 108, 91, 81, 141, 27, 175, 146, 187, 221, 188, 127, 17, 217, 92, 65, 31, 16, 90, 216, 10, 193, 49, 136, 165, 205, 123, 189, 45, 116, 208, 18, 184, 229, 180, 176, 137, 105, 151, 74, 12, 150, 119, 126, 101, 185, 241, 9, 197, 110, 198, 132, 24, 240, 125, 236, 58, 220, 77, 32, 121, 238, 95, 62, 215, 203, 57, 72];
  var RK = [21, 14, 7, 0, 49, 42, 35, 28, 77, 70, 63, 56, 105, 98, 91, 84, 133, 126, 119, 112, 161, 154, 147, 140, 189, 182, 175, 168, 217, 210, 203, 196, 245, 238, 231, 224, 17, 10, 3, 252, 45, 38, 31, 24, 73, 66, 59, 52, 101, 94, 87, 80, 129, 122, 115, 108, 157, 150, 143, 136, 185, 178, 171, 164, 213, 206, 199, 192, 241, 234, 227, 220, 13, 6, 255, 248, 41, 34, 27, 20, 69, 62, 55, 48, 97, 90, 83, 76, 125, 118, 111, 104, 153, 146, 139, 132, 181, 174, 167, 160, 209, 202, 195, 188, 237, 230, 223, 216, 9, 2, 251, 244, 37, 30, 23, 16, 65, 58, 51, 44, 93, 86, 79, 72, 121, 114, 107, 100];
  var DEVICE_INPUT = 'HONOR|HBP-AL00|HBP-AL00|1234567890|12|fp|';
  var MASK = 0xFFFFFFFF;

  function rotl(x, n) {
    return (((x << n) & MASK) | (x >>> (32 - n))) & MASK;
  }

  function le32(bytes, off) {
    return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) & MASK;
  }

  function tau(v) {
    return ((SBOX[(v >>> 24) & 0xff] << 24) | (SBOX[(v >>> 16) & 0xff] << 16) |
      (SBOX[(v >>> 8) & 0xff] << 8) | SBOX[v & 0xff]) & MASK;
  }

  // the app's custom schedule: T-transform (not T') with a permuted state roll
  function extKey(d0, d1, d2, d3) {
    var v62 = (d1 ^ 0x56AA3350) & MASK;
    var v63 = (d0 ^ 0xA3B1BAC6) & MASK;
    var v65 = (d3 ^ 0xB27022DC) & MASK;
    var v64 = (d2 ^ 0x677D9197) & MASK;
    var ext = new Uint8Array(128);
    var p = 0;
    for (var i = 0; i < 128; i += 4) {
      var v67 = v65;
      var rk = le32(RK, i);
      var v68 = (v62 ^ v65 ^ v64 ^ rk) & MASK;
      var hi = (v68 >>> 24) & 0xff;
      var b2 = (v68 >>> 16) & 0xff;
      var b1 = (v68 >>> 8) & 0xff;
      var lo = SBOX[v68 & 0xff];
      var b2n = ((SBOX[hi] << 24) | (SBOX[b2] << 16) | (SBOX[b1] << 8) | lo) & MASK;
      v65 = (v63 ^ ((lo << 24) & MASK) ^ ((b2n << 10) & MASK) ^
        ((4 * b2n) & MASK) ^ ((b2n << 18) & MASK) ^ b2n) & MASK;
      ext[p++] = v65 & 0xff;
      ext[p++] = (v65 >>> 8) & 0xff;
      ext[p++] = (v65 >>> 16) & 0xff;
      ext[p++] = (v65 >>> 24) & 0xff;
      v63 = v62;
      v62 = v64;
      v64 = v67;
    }
    return ext;
  }

  function encBlock(block, key) {
    var v74 = ((block[8] << 24) | (block[9] << 16) | (block[10] << 8) | block[11]) & MASK;
    var v75 = ((block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3]) & MASK;
    var v76 = ((block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]) & MASK;
    var v77 = ((block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]) & MASK;
    for (var i = 0; i < 128; i += 4) {
      var v78 = v76;
      var v79 = v77;
      var v80 = le32(key, i);
      var v81 = v74;
      var v82 = (v76 ^ v74 ^ v79 ^ v80) & MASK;
      var hi = (v82 >>> 24) & 0xff;
      var b2 = (v82 >>> 16) & 0xff;
      var b1 = (v82 >>> 8) & 0xff;
      var lo = SBOX[v82 & 0xff];
      var v86 = (v75 ^ ((lo << 24) & MASK)) & MASK;
      var b2n = ((SBOX[hi] << 24) | (SBOX[b2] << 16) | (SBOX[b1] << 8) | lo) & MASK;
      v74 = v79;
      v76 = v81;
      v77 = (v86 ^ ((b2n << 10) & MASK) ^ ((4 * b2n) & MASK) ^ ((b2n << 18) & MASK) ^ b2n) & MASK;
      v75 = v78;
    }
    var out = new Uint8Array(16);
    var words = [v77, v79, v81, v78];
    for (var j = 0; j < 4; j++) {
      var v = words[j];
      out[j * 4] = (v >>> 24) & 0xff;
      out[j * 4 + 1] = (v >>> 16) & 0xff;
      out[j * 4 + 2] = (v >>> 8) & 0xff;
      out[j * 4 + 3] = v & 0xff;
    }
    return out;
  }

  function localTimestamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function genDfp() {
    var ts = localTimestamp();
    var raw = utf8ToBytes(DEVICE_INPUT);
    var paddedLen = (raw.length + 15) & ~0xf;
    var pad = paddedLen - raw.length;
    var padded = new Uint8Array(paddedLen);
    padded.set(raw);
    for (var k = raw.length; k < paddedLen; k++) padded[k] = pad;
    var seed = hexToBytes(sha256Hex('fa317cd29b|' + ts));
    var d0 = le32(seed, 0);
    var d1 = le32(seed, 4);
    var d2 = le32(seed, 8);
    var d3 = le32(seed, 12);
    var key = extKey(d0, d1, d2, d3);
    var out = new Uint8Array(paddedLen);
    for (var off = 0; off < paddedLen; off += 16) {
      out.set(encBlock(padded.subarray(off, off + 16), key), off);
    }
    return 'dfp=f-c29cd:f-' + base64Encode(out);
  }

  // ---- 载荷加解密：AES-GCM 封包 / XChaCha20-Poly1305 解包 ----
  function reverseBytes(bytes) {
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
    return out;
  }

  function concatBytes(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var p = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], p);
      p += parts[j].length;
    }
    return out;
  }

  function encryptPayload(plaintextBytes) {
    var nonce = randomBytes(12);
    var cipherTag = aesGcmEncrypt(KEY, nonce, plaintextBytes);
    var payload = concatBytes([Uint8Array.of(2), nonce, reverseBytes(cipherTag)]);
    return bytesToHex(payload);
  }

  function decryptPayload(hex) {
    var payload = hexToBytes(hex);
    var ver = payload[0];
    var nonce = payload.subarray(1, 25);
    var body = payload.subarray(25);
    if (ver === 2) body = reverseBytes(body);
    var ct = body.subarray(0, body.length - 16);
    var tag = body.subarray(body.length - 16);
    return chacha20Poly1305Decrypt(KEY, nonce, concatBytes([ct, tag]));
  }

  function decryptJson(hex) {
    return JSON.parse(bytesToUtf8(decryptPayload(hex)));
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---- guest 凭证（进程内复用，401/403 时强制刷新）----
  var credCache = null;

  async function refreshCredentials() {
    var dfp = genDfp();
    var resp = await http.post(BASE + '/auth/guest', {
      headers: {
        'User-Agent': UA,
        'X-VERSION': '1.0.8',
        'X-Payload-Version': '2',
        'Content-Type': 'text/plain; charset=utf-8',
        'x-skip-error-prompt': 'true',
        'x-guest-auth-request': 'true',
        'x-skip-session': 'true',
        Cookie: dfp,
      },
      body: encryptPayload(utf8ToBytes('{}')),
      timeoutMs: 15000,
    });
    if (resp.status !== 200) throw new Error('guest 授权失败: HTTP ' + resp.status);
    var outer = JSON.parse(resp.body);
    var token = decryptJson(outer.payload).auth_token;
    var session = '';
    var setCookie = resp.headers['set-cookie'] || '';
    var parts = setCookie.split(/; */);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf('session=') === 0) {
        session = parts[i].substring('session='.length);
        break;
      }
    }
    log('guest 授权成功');
    return { token: token, session: session, dfp: dfp };
  }

  async function getCredentials(force) {
    if (!credCache || force) {
      credCache = await refreshCredentials();
    }
    return credCache;
  }

  function authHeaders(cred) {
    return {
      'User-Agent': UA,
      'X-VERSION': '1.0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'X-Session-Type': 'guest',
      Authorization: 'Bearer ' + cred.token,
      'X-Payload-Version': '2',
      'Content-Type': 'text/plain; charset=utf-8',
      Cookie: cred.dfp + '; session=' + cred.session,
    };
  }

  // 带凭证请求：401/403 时刷新凭证重试一次
  async function postEncrypted(url, bodyBytes) {
    var cred = await getCredentials();
    var resp = await http.post(url, {
      headers: authHeaders(cred),
      body: encryptPayload(bodyBytes),
      timeoutMs: 20000,
    });
    if (resp.status === 401 || resp.status === 403) {
      cred = await getCredentials(true);
      resp = await http.post(url, {
        headers: authHeaders(cred),
        body: encryptPayload(bodyBytes),
        timeoutMs: 20000,
      });
    }
    if (resp.status !== 200) throw new Error(url + ' 失败: HTTP ' + resp.status);
    return resp;
  }

  async function fetchJson(url) {
    var cred = await getCredentials();
    var resp = await http.get(url, { headers: authHeaders(cred), timeoutMs: 20000 });
    if (resp.status === 401 || resp.status === 403) {
      cred = await getCredentials(true);
      resp = await http.get(url, { headers: authHeaders(cred), timeoutMs: 20000 });
    }
    if (resp.status !== 200) throw new Error(url + ' 失败: HTTP ' + resp.status);
    var outer = JSON.parse(resp.body);
    if (outer && outer.payload) return decryptJson(outer.payload);
    return outer;
  }

  async function chaptersJson(albumId) {
    return fetchJson(JSON_BASE + '/album_chapters/' + albumId);
  }

  registerSource({
    id: 'tingyoufm',

    // ---------- 搜索 ----------
    async search(params) {
      var keyword = String(params.keyword || '');
      var body = utf8ToBytes(JSON.stringify({ keyword: keyword, page: 1 }));
      var resp = await postEncrypted(BASE + '/search', body);
      var data = decryptJson(JSON.parse(resp.body).payload);
      var list = data.results || [];
      var result = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item.id || !item.title) continue;
        result.push({
          id: String(item.id),
          bookTitle: item.title,
          bookImage: item.cover_url || '',
          bookAnchor: item.author || item.teller || '',
          bookDesc: item.description || '',
          count: item.count || 0,
          albumId: String(item.id),
          type: item.type || '',
          teller: item.teller || '',
        });
      }
      return result;
    },

    // ---------- 章节 ----------
    async chapters(params) {
      var albumId = String(params.albumId || params.bookId || '');
      if (!albumId) throw new Error('缺少 albumId，请从搜索结果进入');
      var data = await chaptersJson(albumId);
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
          albumId: albumId,
        });
      }
      return result;
    },

    // ---------- 音频直链 ----------
    async audio(params) {
      var albumId = String(params.albumId || params.bookId || '');
      var chapterId = String(params.chapterId || params.chapter_id || '');
      var playUrl = params.playUrl || params.play_url || '';
      if (playUrl) return String(playUrl);
      if (!albumId || !chapterId) throw new Error('缺少 albumId/chapterId');
      // play_token 只认集序号：没有 order 时用章节列表反查
      var chapterIdx = params.order || params.chapterIdx || params.index;
      if (!chapterIdx) {
        var data = await chaptersJson(albumId);
        var list = data.chapters || [];
        chapterIdx = 1;
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].id) === chapterId) {
            chapterIdx = list[i].index || 1;
            break;
          }
        }
        log('未在章节列表中直接匹配，回退集序号 ' + chapterIdx);
      }
      var body = utf8ToBytes(JSON.stringify({ album_id: String(albumId), chapter_idx: Number(chapterIdx) }));
      var resp = await postEncrypted(BASE + '/play/play_token', body);
      var outer = JSON.parse(resp.body);
      var data = outer && outer.payload ? decryptJson(outer.payload) : outer;
      var url = (data && (data.play_url || data.url || data.playUrl)) || '';
      if (url) return String(url);
      var m = resp.body.match(/https?:\/\/[^"\s]+\.(mp3|m4a|mp4)[^"\s]*/);
      if (m) return m[0];
      throw new Error('未找到音频URL');
    },
  });
})();
