// Injected into every source sandbox before the source script. Defines the
// public helper API plus the registerSource() registration hook, and bridges
// crypto/http calls to the Kotlin host (strings only across the boundary).
'use strict';
(() => {
  let registered = null;

  globalThis.registerSource = (source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('registerSource(源对象) 需要一个对象参数');
    }
    if (typeof source.id !== 'string' || !source.id) {
      throw new Error('registerSource 缺少 id 字符串');
    }
    registered = source;
  };

  // ---------- bytes helpers (pure JS) ----------
  const hexToBytes = (hex) => {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) {
      throw new Error('hexToBytes 需要偶数长度的 hex 字符串');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      const v = parseInt(hex.substr(i * 2, 2), 16);
      if (Number.isNaN(v)) throw new Error('hexToBytes 含非法字符');
      out[i] = v;
    }
    return out;
  };

  const bytesToHex = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  };

  const utf8ToBytes = (str) => {
    str = String(str);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c < 0x10000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  };

  const bytesToUtf8 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; ) {
      const b0 = bytes[i];
      let cp;
      if (b0 < 0x80) {
        cp = b0;
        i += 1;
      } else if (b0 < 0xe0) {
        cp = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        i += 2;
      } else if (b0 < 0xf0) {
        cp = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
        i += 3;
      } else {
        cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        i += 4;
      }
      if (cp > 0xffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
    }
    return out;
  };

  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  const b64FromBytes = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64_CHARS[b0 >> 2];
      out += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
      out += i + 1 < bytes.length ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      out += i + 2 < bytes.length ? B64_CHARS[b2 & 63] : '=';
    }
    return out;
  };

  const bytesFromB64 = (str) => {
    str = String(str).replace(/[\s=]+/g, '');
    const out = [];
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < str.length; i++) {
      const v = B64_CHARS.indexOf(str[i]);
      if (v < 0) throw new Error('base64Decode 含非法字符');
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buffer >> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  };

  const toB64 = (data) => (typeof data === 'string' ? b64FromBytes(utf8ToBytes(data)) : b64FromBytes(data));
  const keyToB64 = toB64;

  const host = (name) => {
    const fn = globalThis[name];
    if (typeof fn !== 'function') throw new Error('宿主缺少 ' + name);
    return fn;
  };

  // ---------- public API ----------
  globalThis.md5Hex = (text) => host('__md5Hex')(String(text));
  globalThis.sha256Hex = (text) => host('__sha256Hex')(String(text));
  globalThis.hmacSha256Hex = (key, text) => host('__hmacSha256Hex')(String(key), String(text));

  globalThis.base64Encode = (data) => toB64(data);
  globalThis.base64Decode = (str) => bytesFromB64(str);
  globalThis.base64ToUtf8 = (str) => bytesToUtf8(bytesFromB64(str));

  globalThis.hexToBytes = hexToBytes;
  globalThis.bytesToHex = bytesToHex;
  globalThis.utf8ToBytes = utf8ToBytes;
  globalThis.bytesToUtf8 = bytesToUtf8;

  globalThis.aesEcbEncryptB64 = (data, key) => host('__aesEcbEncryptB64')(toB64(data), keyToB64(key));
  globalThis.aesEcbDecrypt = (data, key) =>
    bytesFromB64(host('__aesEcbDecryptB64')(typeof data === 'string' ? data : b64FromBytes(data), keyToB64(key)));

  globalThis.aesGcmEncrypt = (key, nonce, data) =>
    bytesFromB64(host('__aesGcmEncryptB64')(keyToB64(key), b64FromBytes(nonce), toB64(data)));
  globalThis.aesGcmDecrypt = (key, nonce, cipherWithTag) =>
    bytesFromB64(
      host('__aesGcmDecryptB64')(
        keyToB64(key),
        b64FromBytes(nonce),
        typeof cipherWithTag === 'string' ? cipherWithTag : b64FromBytes(cipherWithTag),
      ),
    );

  globalThis.chacha20Poly1305Encrypt = (key, nonce, data) =>
    bytesFromB64(host('__chacha20Poly1305EncryptB64')(keyToB64(key), b64FromBytes(nonce), toB64(data)));
  globalThis.chacha20Poly1305Decrypt = (key, nonce, cipherWithTag) =>
    bytesFromB64(
      host('__chacha20Poly1305DecryptB64')(
        keyToB64(key),
        b64FromBytes(nonce),
        typeof cipherWithTag === 'string' ? cipherWithTag : b64FromBytes(cipherWithTag),
      ),
    );

  globalThis.sm4EcbEncrypt = (data, key) => bytesFromB64(host('__sm4EcbEncryptB64')(toB64(data), keyToB64(key)));
  globalThis.sm4EcbDecrypt = (data, key) =>
    bytesFromB64(
      host('__sm4EcbDecryptB64')(typeof data === 'string' ? data : b64FromBytes(data), keyToB64(key)),
    );

  globalThis.randomBytes = (n) => bytesFromB64(host('__randomBytesB64')(n | 0));
  globalThis.timestamp = () => host('__timestamp')();
  globalThis.timestampMs = () => host('__timestampMs')();
  globalThis.urlEncode = (text) => host('__urlEncode')(String(text));
  globalThis.urlDecode = (text) => host('__urlDecode')(String(text));
  globalThis.log = (...args) => host('__log')(args.map((a) => String(a)).join(' '));

  globalThis.http = {
    get: async (url, options = {}) =>
      JSON.parse(await host('__httpRequest')('GET', String(url), JSON.stringify(options))),
    post: async (url, options = {}) =>
      JSON.parse(await host('__httpRequest')('POST', String(url), JSON.stringify(options))),
  };

  // ---------- host-facing hooks ----------
  globalThis.__invoke = async (stage, paramsJson) => {
    if (!registered) throw new Error('源脚本未调用 registerSource');
    const fn = registered[stage];
    if (typeof fn !== 'function') throw new Error('该源未实现 ' + stage + '()');
    const params = paramsJson ? JSON.parse(paramsJson) : {};
    const result = await fn.call(registered, params);
    return JSON.stringify(result === undefined ? null : result);
  };

  globalThis.__sourceInfo = () => {
    if (!registered) return null;
    return JSON.stringify({
      id: registered.id,
      search: typeof registered.search === 'function',
      chapters: typeof registered.chapters === 'function',
      audio: typeof registered.audio === 'function',
    });
  };
})();
