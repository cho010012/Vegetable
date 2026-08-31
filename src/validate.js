/**
 * 輸入驗證工具
 *
 * 原則：所有從瀏覽器送進來的東西一律視為不可信。
 *  - 字串一律限制長度（避免有人塞 10MB 的名字把資料庫灌爆）
 *  - 數字一律轉型並夾在合理範圍
 *  - 列舉值一律用白名單比對
 * 前端的檢查只是體驗，後端這層才是真正的防線。
 */
'use strict';

function str(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function int(v, { min = 0, max = 1e9, def = 0 } = {}) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

function oneOf(v, allowed, def) {
  return allowed.includes(v) ? v : def;
}

/** 台灣手機號碼 09xxxxxxxx */
function phone(v) {
  const digits = String(v || '').replace(/[^0-9]/g, '');
  return /^09\d{8}$/.test(digits) ? digits : null;
}

/**
 * 圖片欄位：只接受三種形式
 *   1. /uploads/<32碼hex>.<副檔名>  ← 後台上傳的圖（由 src/uploads.js 產生檔名）
 *   2. http(s):// 開頭的外部圖片網址
 *   3. emoji 或極短字串（當作圖示用）
 * 其餘一律換成預設 emoji，特別是 javascript: / data: / vbscript: 這類
 * 塞進 <img src> 或 <a href> 就可能變成 XSS 的協定。
 */
const UPLOAD_RE = /^\/uploads\/[0-9a-f]{32}\.(jpg|png|webp|gif)$/;
function image(v) {
  const s = str(v, 500);
  if (!s) return '🥬';
  if (UPLOAD_RE.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(javascript|data|vbscript):/i.test(s)) return '🥬';
  if (s.startsWith('/')) return '🥬';        // 其他相對路徑一律不收，避免被當成站內任意檔案
  return s.slice(0, 8);
}

/** 丟出 400 用的錯誤 */
class BadRequest extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

module.exports = { str, int, bool, oneOf, phone, image, UPLOAD_RE, BadRequest };
