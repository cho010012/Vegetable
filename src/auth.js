/**
 * 管理員驗證
 *
 * 設計說明：
 *  - 密碼用 bcrypt 雜湊後存資料庫，資料庫外洩也還原不出原始密碼。
 *  - 登入成功發一組隨機 session token，存進 sessions 表，並以
 *    httpOnly + SameSite=Lax + (正式環境) Secure 的 Cookie 帶給瀏覽器。
 *    httpOnly 讓 JavaScript 讀不到 token，可擋住 XSS 偷 cookie；
 *    SameSite=Lax 可擋掉大部分 CSRF。
 *  - token 只存在後端，登出即刪除，可真正「立刻失效」。
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const COOKIE = 'gb_session';
const TTL_MS = 8 * 60 * 60 * 1000;   // 8 小時

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

function createAdmin(email, plainPassword) {
  if (!email || !plainPassword || plainPassword.length < 8) {
    throw new Error('email 必填，密碼至少 8 碼');
  }
  return db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)')
           .run(String(email).toLowerCase().trim(), hashPassword(plainPassword));
}

function verifyLogin(email, plainPassword) {
  const row = db.prepare('SELECT * FROM admins WHERE email = ?')
                .get(String(email || '').toLowerCase().trim());
  // 帳號不存在時也跑一次比對，讓回應時間一致，避免用時間差猜出哪些 email 存在
  const hash = row ? row.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = bcrypt.compareSync(String(plainPassword || ''), hash);
  return ok && row ? row : null;
}

function issueSession(res, adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + TTL_MS;
  db.prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?,?,?)')
    .run(token, adminId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TTL_MS,
    path: '/'
  });
}

function destroySession(req, res) {
  const t = req.cookies?.[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.clearCookie(COOKIE, { path: '/' });
}

function currentAdmin(req) {
  const t = req.cookies?.[COOKIE];
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
    return null;
  }
  return db.prepare('SELECT id, email FROM admins WHERE id = ?').get(s.admin_id) || null;
}

/** 掛在所有 /api/admin/* 前面的守門員 */
function requireAdmin(req, res, next) {
  const a = currentAdmin(req);
  if (!a) return res.status(401).json({ error: '請先登入' });
  req.admin = a;
  next();
}

/** 定期清掉過期 session */
function purgeExpired() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  COOKIE, hashPassword, createAdmin, verifyLogin,
  issueSession, destroySession, currentAdmin, requireAdmin, purgeExpired
};
