/**
 * 商品圖片上傳 / 儲存 / 供圖
 * -----------------------------------------------------------------------------
 * 設計取捨：
 *  1. 不用 multer 之類的 multipart 套件 —— 前端直接把圖片檔當成 request body 送出
 *     （Content-Type 就是圖片的 MIME），後端用 express.raw() 收成 Buffer。
 *     少一個相依套件，也少一整塊 multipart 解析的攻擊面。
 *  2. 檔案存在 data/uploads/（不在 public/ 底下），由本檔的 serve() 這條唯一出口供圖。
 *     這樣就算哪天有人想辦法丟進奇怪的檔案，也不會被靜態伺服器直接當網頁執行。
 *
 * 安全重點（上傳是最常見的破口，逐條說明）：
 *  - 只認「檔頭魔術位元組」判斷型別，完全不信任前端送來的副檔名或 Content-Type。
 *  - 檔名一律由伺服器隨機產生（16 bytes hex + 白名單副檔名），杜絕 ../ 路徑穿越、
 *    也避免中文/特殊字元檔名在不同作業系統上出包。
 *  - 大小上限由路由層的 express.raw({ limit }) 擋，這裡再驗一次。
 *  - 供圖時副檔名 → Content-Type 由白名單對照表決定，並加上 nosniff，
 *    瀏覽器不會把圖片猜成 HTML/JS 去執行。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 預設 data/uploads/；設 GB_UPLOAD_DIR 可換位置（測試用獨立目錄，不會弄髒正式圖片）
const UPLOAD_DIR = process.env.GB_UPLOAD_DIR
  ? path.resolve(process.env.GB_UPLOAD_DIR)
  : path.join(__dirname, '..', 'data', 'uploads');
const URL_PREFIX = '/uploads/';
const MAX_BYTES = 4 * 1024 * 1024;          // 4MB，前端會先縮圖，正常不會碰到

/** 副檔名 ↔ 對外 Content-Type 白名單 */
const EXT_MIME = {
  jpg:  'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif'
};

/** 伺服器產生的檔名長這樣，只有這個樣子的檔名會被供出 */
const NAME_RE = /^[0-9a-f]{32}\.(jpg|png|webp|gif)$/;

function ensureDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * 看檔頭認圖片格式（magic bytes）。認不出來就回 null，一律拒收。
 * 這比看副檔名可靠得多：把 shell.php 改名成 a.png 騙不過這一關。
 */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * 存檔。
 * @param {Buffer} buf 圖片內容
 * @returns {{url:string, name:string, ext:string, bytes:number}}
 * @throws {Error} 格式不符或超過大小上限（帶 status 讓錯誤處理層回 4xx）
 */
function save(buf) {
  const err = (msg, status) => Object.assign(new Error(msg), { status });
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw err('沒有收到圖片內容', 400);
  if (buf.length > MAX_BYTES) throw err(`圖片太大，請小於 ${MAX_BYTES / 1024 / 1024}MB`, 413);

  const ext = sniff(buf);
  if (!ext) throw err('只接受 JPG／PNG／WebP／GIF 圖片檔', 415);

  ensureDir();
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: URL_PREFIX + name, name, ext, bytes: buf.length };
}

/** 這個網址是不是本站自己管理的上傳圖？（用來決定能不能刪、要不要 GC） */
function isManaged(url) {
  const s = String(url || '').trim();
  return s.startsWith(URL_PREFIX) && NAME_RE.test(s.slice(URL_PREFIX.length));
}

/** 刪掉一張自家上傳圖；不是自家圖或檔案不存在都只是靜靜地回 false，不丟錯 */
function remove(url) {
  if (!isManaged(url)) return false;
  const file = path.join(UPLOAD_DIR, path.basename(String(url)));
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * 清掉沒有任何商品在用的孤兒圖（換圖、刪商品之後會留下來）。
 * 只清 1 小時前的檔案 —— 剛上傳、還沒按下「儲存」綁到商品上的圖不能被掃掉。
 * @param {Set<string>|string[]} inUse 目前仍被引用的網址集合
 */
function gcUnreferenced(inUse) {
  ensureDir();
  const used = new Set([...inUse].map(u => path.basename(String(u || ''))));
  const cutoff = Date.now() - 60 * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (!NAME_RE.test(f) || used.has(f)) continue;
    const p = path.join(UPLOAD_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs > cutoff) continue;   // 太新，可能正要被綁定
      fs.unlinkSync(p); removed++;
    } catch { /* 檔案剛好被別的流程動過就跳過 */ }
  }
  return removed;
}

/** Express handler：GET /uploads/:file */
function serve(req, res) {
  const name = String(req.params.file || '');
  if (!NAME_RE.test(name)) return res.status(404).end();       // 連檔案系統都不用碰
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(EXT_MIME[name.split('.').pop()]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 檔名含隨機雜湊，內容永不變動，可以放心長時間快取
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file);
}

module.exports = {
  UPLOAD_DIR, URL_PREFIX, MAX_BYTES, EXT_MIME, NAME_RE,
  sniff, save, isManaged, remove, gcUnreferenced, serve, ensureDir
};
