/**
 * 進入點 —— 啟動 HTTP 服務
 *   npm start        正式啟動
 *   npm run dev      開發模式（存檔自動重啟）
 *
 * 預設網址：
 *   前台  http://localhost:3000/
 *   後台  http://localhost:3000/admin
 */
'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { db, seedIfEmpty } = require('./db');
const uploads = require('./uploads');
const { purgeExpired, createAdmin } = require('./auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const marketRoutes = require('./routes/market');
const paymentRoutes = require('./routes/payment');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- 安全標頭 ----------
   Content-Security-Policy 限制網頁只能載入自家資源，
   即使哪天不小心讓惡意字串進了頁面，也很難載入外部惡意腳本。 */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],   // 頁面內建樣式
      imgSrc: ["'self'", 'data:', 'https:'],     // 允許商品用外部圖片網址
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]                 // 不准被別的網站用 iframe 包起來（防點擊劫持）
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '256kb' }));       // 限制請求大小，避免被灌爆
app.use(cookieParser());
app.set('trust proxy', 1);                       // 部署在 Nginx / Cloudflare 後面時取得正確來源 IP

/* ---------- 全域流量限制 ---------- */
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '請求過於頻繁，請稍後再試' }
}));

/* 下單另外限制：同一 IP 每 10 分鐘最多 10 筆，擋惡意灌單 */
app.use('/api/orders', rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '下單次數過多，請稍後再試或直接聯絡團主' }
}));

/* 訂單查詢：同一 IP 每 10 分鐘最多 30 次，避免有人拿編號 + 電話慢慢試別人的訂單 */
app.use('/api/lookup', rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '查詢次數過多，請稍後再試' }
}));

/* ---------- 路由 ---------- */
app.use('/api', publicRoutes.router);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/market', marketRoutes);
app.use('/api/payment', paymentRoutes);

/* ---------- 商品圖片 ----------
   圖片存在 data/uploads/（刻意不放在 public/ 底下），只由這條路由供出，
   而且只認伺服器自己產生的檔名格式，詳見 src/uploads.js。 */
app.get('/uploads/:file', uploads.serve);

/* ---------- 靜態網頁 ---------- */
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

/* ---------- 錯誤處理 ----------
   對外只回一句話；完整錯誤留在伺服器日誌，避免把內部細節洩漏給攻擊者。 */
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  // body-parser 的錯誤訊息是英文，換成看得懂的中文
  const msg = err.type === 'entity.too.large' ? '上傳內容過大，請換一張小一點的圖片'
            : err.type === 'entity.parse.failed' ? '資料格式不正確'
            : status >= 500 ? '伺服器發生錯誤，請稍後再試'
            : err.message;
  res.status(status).json({ error: msg });
});

/* ---------- 啟動 ---------- */
seedIfEmpty();
purgeExpired();
setInterval(purgeExpired, 60 * 60 * 1000).unref();

/* 清掉沒有商品在使用的圖片檔（換圖、刪商品後的殘留），每小時跑一次 */
function sweepImages() {
  try {
    const rows = db.prepare("SELECT image FROM products WHERE image LIKE '/uploads/%'").all();
    uploads.gcUnreferenced(rows.map(r => r.image));
  } catch (e) { console.error('[uploads gc]', e.message); }
}
sweepImages();
setInterval(sweepImages, 60 * 60 * 1000).unref();

// 若資料庫還沒有任何管理員，且 .env 有給帳密，就自動建立第一位管理員
const adminCount = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
if (adminCount === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  try {
    createAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
    console.log(`✅ 已建立管理員 ${process.env.ADMIN_EMAIL}（建議建立後把 .env 裡的 ADMIN_PASSWORD 刪除）`);
  } catch (e) { console.error('建立管理員失敗：', e.message); }
} else if (adminCount === 0) {
  console.warn('⚠️  尚未建立管理員，請執行：npm run init-admin');
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🥬 團購平台已啟動`);
    console.log(`   前台  http://localhost:${PORT}/`);
    console.log(`   後台  http://localhost:${PORT}/admin\n`);
  });
}

module.exports = app;
