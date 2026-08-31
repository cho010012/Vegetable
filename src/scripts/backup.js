/**
 * 備份資料庫
 *   npm run backup
 * 會在 data/backups/ 產生一份帶時間戳的 .db 檔，並自動保留最近 30 份。
 *
 * 用 SQLite 的 VACUUM INTO（而不是直接複製檔案），
 * 這樣即使備份當下有人正在下單，備份出來的檔案仍然是完整可用的。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const dir = path.join(__dirname, '..', '..', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(dir, `groupbuy-${stamp}.db`);

try {
  db.backupTo(dest);
  const size = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`✅ 已備份到 ${dest}（${size} KB）`);

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
  const drop = files.slice(0, Math.max(0, files.length - 30));
  drop.forEach(f => fs.unlinkSync(path.join(dir, f)));
  if (drop.length) console.log(`🧹 已清除 ${drop.length} 份較舊的備份（保留最近 30 份）`);

  console.log('提醒：請定期把備份複製到另一台機器或雲端硬碟，跟正本放同一顆硬碟等於沒備份。');
  console.log('提醒：商品圖片放在 data/uploads/，這個指令不會處理，請另外一起複製，否則還原後會變破圖。');
} catch (e) {
  console.error('❌ 備份失敗：', e.message);
  process.exit(1);
}
