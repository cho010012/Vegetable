/**
 * 建立 / 重設管理員帳號
 *   npm run init-admin -- me@example.com 我的超強密碼
 * 不帶參數時會讀 .env 的 ADMIN_EMAIL / ADMIN_PASSWORD。
 */
'use strict';
require('dotenv').config();

const { db } = require('../db');
const { hashPassword, createAdmin } = require('../auth');

const email = (process.argv[2] || process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const pass = process.argv[3] || process.env.ADMIN_PASSWORD || '';

if (!email || !pass) {
  console.error('用法：npm run init-admin -- <email> <password>');
  process.exit(1);
}
if (pass.length < 10) {
  console.error('❌ 密碼至少 10 碼，請換一組長一點的。');
  process.exit(1);
}

const exists = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
if (exists) {
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(pass), exists.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(exists.id);
  console.log(`✅ 已重設 ${email} 的密碼（所有裝置需重新登入）`);
} else {
  createAdmin(email, pass);
  console.log(`✅ 已建立管理員 ${email}`);
}
console.log('提醒：建立完成後，請把 .env 裡的 ADMIN_PASSWORD 那一行刪掉。');
