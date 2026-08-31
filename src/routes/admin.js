/**
 * 後台 API（全部需要登入，由 requireAdmin 把關）
 *
 *   POST   /api/admin/login            登入（此路由本身不需登入）
 *   POST   /api/admin/logout           登出
 *   GET    /api/admin/me               目前登入者
 *   GET    /api/admin/dashboard        KPI + 採購彙總
 *   GET    /api/admin/orders           訂單列表
 *   PATCH  /api/admin/orders/:id       改狀態 / 付款狀態
 *   DELETE /api/admin/orders/:id       刪除訂單
 *   GET    /api/admin/orders.csv       匯出訂單
 *   GET    /api/admin/purchase.csv     匯出叫貨單
 *   CRUD   /api/admin/products         商品
 *   POST   /api/admin/uploads          上傳商品圖片（request body 直接是圖片檔）
 *   DELETE /api/admin/uploads/:file    刪除一張已上傳的圖片
 *   CRUD   /api/admin/pickups          取貨點
 *   PUT    /api/admin/settings/:key    設定（look / rules / delivery / market）
 */
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, getSetting, setSetting } = require('../db');
const A = require('../auth');
const V = require('../validate');
const U = require('../uploads');
const { progress } = require('./public');

const router = express.Router();

/* ---------- 登入（限制嘗試次數，擋暴力破解） ---------- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '嘗試次數過多，請 15 分鐘後再試' }
});

router.post('/login', loginLimiter, (req, res) => {
  const admin = A.verifyLogin(req.body.email, req.body.password);
  if (!admin) return res.status(401).json({ error: '帳號或密碼錯誤' });
  A.issueSession(res, admin.id);
  res.json({ ok: true, email: admin.email });
});

router.post('/logout', (req, res) => { A.destroySession(req, res); res.json({ ok: true }); });

router.get('/me', (req, res) => {
  const a = A.currentAdmin(req);
  return a ? res.json({ email: a.email }) : res.status(401).json({ error: '未登入' });
});

/* ===== 以下全部需要登入 ===== */
router.use(A.requireAdmin);

/* ---------- 儀表板與彙總 ---------- */
function purchaseList() {
  return db.prepare(`
    SELECT i.name, i.unit, i.price,
           SUM(i.qty)    AS qty,
           SUM(i.amount) AS amount
    FROM order_items i
    JOIN orders o ON o.id = i.order_id
    WHERE o.status <> '已取消'
    GROUP BY i.name, i.unit, i.price
    ORDER BY qty DESC`).all();
}

router.get('/dashboard', (req, res) => {
  const k = db.prepare(`SELECT COUNT(*) AS orders,
                               COALESCE(SUM(subtotal),0) AS subtotal,
                               COALESCE(SUM(total),0)    AS total,
                               COUNT(DISTINCT buyer_phone) AS buyers
                        FROM orders WHERE status <> '已取消'`).get();
  res.json({ kpi: k, progress: progress(), purchase: purchaseList(), rules: getSetting('rules') });
});

/* ---------- 訂單 ---------- */
function orderRows(limit = 500) {
  const rows = db.prepare(`
    SELECT o.*, p.name AS pickup_name, p.hours AS pickup_hours
    FROM orders o LEFT JOIN pickup_points p ON p.id = o.pickup_id
    ORDER BY o.id DESC LIMIT ?`).all(limit);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  return rows.map(o => ({ ...o, items: items.all(o.id) }));
}

router.get('/orders', (req, res) => res.json({ orders: orderRows() }));

router.patch('/orders/:id', (req, res) => {
  const id = V.int(req.params.id);
  const fields = [], vals = [];
  if (req.body.status !== undefined) {
    fields.push('status = ?');
    vals.push(V.oneOf(V.str(req.body.status, 10), ['待處理', '已備貨', '已取貨', '已取消'], '待處理'));
  }
  if (req.body.pay_status !== undefined) {
    fields.push('pay_status = ?');
    vals.push(V.oneOf(V.str(req.body.pay_status, 10), ['未付款', '已付款', '已退款'], '未付款'));
  }
  if (!fields.length) return res.status(400).json({ error: '沒有可更新的欄位' });
  vals.push(id);
  db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

router.delete('/orders/:id', (req, res) => {
  // 刪單時把庫存加回去，避免帳面上的可售數量越來越少
  const id = V.int(req.params.id);
  const tx = db.transaction(() => {
    const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(id);
    const upd = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    for (const it of items) if (it.product_id) upd.run(it.qty, it.product_id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);   // order_items 由外鍵 CASCADE 一併刪除
  });
  tx();
  res.json({ ok: true });
});

/* ---------- CSV 匯出 ---------- */
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;          // 擋 Excel 公式注入
  return '"' + s.replace(/"/g, '""') + '"';
}
function sendCsv(res, filename, asciiName, rows) {
  const body = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // HTTP 標頭只能放 ASCII，中文檔名必須走 RFC 5987 的 filename* 這一欄，
  // 另外給一個純英數的 filename 當作舊瀏覽器的退路。
  res.setHeader('Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(body);
}

router.get('/purchase.csv', (req, res) => {
  const rows = [['商品', '總需求量', '單位', '單價', '金額'],
    ...purchaseList().map(r => [r.name, r.qty, r.unit, r.price, r.amount])];
  const d = new Date().toISOString().slice(0, 10);
  sendCsv(res, `叫貨單_${d}.csv`, `purchase-${d}.csv`, rows);
});

router.get('/orders.csv', (req, res) => {
  const rows = [['訂單編號', '下單時間', '姓名', '電話', '取貨方式', '取貨點/地址', '品項', '小計', '運費', '總額', '訂單狀態', '付款狀態', '備註']];
  for (const o of orderRows(5000)) {
    rows.push([o.code, o.created_at, o.buyer_name, o.buyer_phone,
      o.method === 'pickup' ? '自取' : '宅配',
      o.method === 'pickup' ? (o.pickup_name || '') : o.address,
      o.items.map(i => `${i.name}×${i.qty}${i.unit}`).join('; '),
      o.subtotal, o.fee, o.total, o.status, o.pay_status, o.note]);
  }
  const d = new Date().toISOString().slice(0, 10);
  sendCsv(res, `訂單明細_${d}.csv`, `orders-${d}.csv`, rows);
});

/* ---------- 商品 ---------- */
function productFromBody(b) {
  return {
    name: V.str(b.name, 60),
    category: V.str(b.category, 20) || '其他',
    image: V.image(b.image),
    unit: V.str(b.unit, 10) || '份',
    price: V.int(b.price, { max: 1000000 }),
    market_price: V.int(b.market_price, { max: 1000000 }),
    stock: V.int(b.stock, { max: 100000 }),
    active: V.bool(b.active),
    market_key: V.str(b.market_key, 30),
    sort_order: V.int(b.sort_order, { max: 9999 })
  };
}

router.get('/products', (req, res) =>
  res.json({ products: db.prepare('SELECT * FROM products ORDER BY sort_order, id').all() }));

router.post('/products', (req, res) => {
  const p = productFromBody(req.body);
  if (!p.name) return res.status(400).json({ error: '請填寫品名' });
  const r = db.prepare(`INSERT INTO products
    (name,category,image,unit,price,market_price,stock,active,market_key,sort_order)
    VALUES (@name,@category,@image,@unit,@price,@market_price,@stock,@active,@market_key,@sort_order)`).run(p);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/products/:id', (req, res) => {
  const id = V.int(req.params.id);
  const p = productFromBody(req.body);
  if (!p.name) return res.status(400).json({ error: '請填寫品名' });
  const before = db.prepare('SELECT image FROM products WHERE id = ?').get(id);
  db.prepare(`UPDATE products SET name=@name,category=@category,image=@image,unit=@unit,
    price=@price,market_price=@market_price,stock=@stock,active=@active,
    market_key=@market_key,sort_order=@sort_order WHERE id=@id`)
    .run({ ...p, id });
  if (before && before.image !== p.image) dropImageIfUnused(before.image);   // 換了圖就清掉舊檔
  res.json({ ok: true });
});

router.delete('/products/:id', (req, res) => {
  const id = V.int(req.params.id);
  const before = db.prepare('SELECT image FROM products WHERE id = ?').get(id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  if (before) dropImageIfUnused(before.image);
  res.json({ ok: true });
});

/* ---------- 商品圖片上傳 ----------
   前端把圖片檔直接當成 request body 送過來（Content-Type 就是圖片型別），
   這裡用 express.raw() 收成 Buffer，再交給 src/uploads.js 驗檔頭、存檔。
   不用 multipart 套件，少一層解析、也少一塊攻擊面。 */
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '上傳次數過多，請稍後再試' }
});

router.post('/uploads',
  uploadLimiter,
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: U.MAX_BYTES }),
  (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw Object.assign(new Error('請求內容不是圖片檔（Content-Type 需為 image/…）'), { status: 415 });
      }
      res.json({ ok: true, ...U.save(req.body) });   // save() 會驗檔頭並產生隨機檔名
    } catch (e) { next(e); }
  });

router.delete('/uploads/:file', (req, res) => {
  res.json({ ok: U.remove(U.URL_PREFIX + req.params.file) });
});

/** 換圖或刪商品後，若這張圖已經沒有任何商品在用，就把檔案一起刪掉，不留垃圾 */
function dropImageIfUnused(url) {
  if (!U.isManaged(url)) return;
  const still = db.prepare('SELECT COUNT(*) c FROM products WHERE image = ?').get(url).c;
  if (!still) U.remove(url);
}

/* ---------- 取貨點 ---------- */
router.get('/pickups', (req, res) =>
  res.json({ pickups: db.prepare('SELECT * FROM pickup_points ORDER BY id').all() }));

router.post('/pickups', (req, res) => {
  const name = V.str(req.body.name, 60);
  if (!name) return res.status(400).json({ error: '請填寫地點名稱' });
  const r = db.prepare('INSERT INTO pickup_points (name,address,hours,active) VALUES (?,?,?,?)')
    .run(name, V.str(req.body.address, 200), V.str(req.body.hours, 60), V.bool(req.body.active ?? 1));
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/pickups/:id', (req, res) => {
  db.prepare('UPDATE pickup_points SET name=?,address=?,hours=?,active=? WHERE id=?')
    .run(V.str(req.body.name, 60), V.str(req.body.address, 200),
         V.str(req.body.hours, 60), V.bool(req.body.active ?? 1), V.int(req.params.id));
  res.json({ ok: true });
});

router.delete('/pickups/:id', (req, res) => {
  // 不真的刪除：舊訂單還指著它。改成停用，前台就不再顯示。
  db.prepare('UPDATE pickup_points SET active = 0 WHERE id = ?').run(V.int(req.params.id));
  res.json({ ok: true });
});

/* ---------- 設定 ---------- */
const SETTING_SHAPES = {
  look: (b) => ({
    name: V.str(b.name, 30) || '社區團購',
    mark: V.str(b.mark, 2) || '團',
    brand: /^#[0-9a-f]{6}$/i.test(String(b.brand)) ? b.brand : '#2f7d32',
    tagline: V.str(b.tagline, 120),
    announce: V.str(b.announce, 500)
  }),
  rules: (b) => ({
    title: V.str(b.title, 60) || '本期團購',
    deadline: V.str(b.deadline, 40),
    thresholdType: V.oneOf(V.str(b.thresholdType, 10), ['amount', 'orders'], 'amount'),
    threshold: V.int(b.threshold, { max: 10000000 }),
    perLimit: V.int(b.perLimit, { max: 9999 }),
    minOrder: V.int(b.minOrder, { max: 1000000 }),
    cycle: V.str(b.cycle, 100),
    successNote: V.str(b.successNote, 300)
  }),
  delivery: (b) => ({
    enabled: V.bool(b.enabled),
    fee: V.int(b.fee, { max: 100000 }),
    freeOver: V.int(b.freeOver, { max: 1000000 }),
    pickupFee: V.int(b.pickupFee, { max: 100000 }),
    areas: (Array.isArray(b.areas) ? b.areas : String(b.areas || '').split(/[,，]/))
      .map(s => V.str(s, 20)).filter(Boolean).slice(0, 50)
  }),
  market: (b) => ({
    marketName: V.str(b.marketName, 20) || '台北一',
    basis: V.oneOf(V.str(b.basis, 10), ['avg', 'upper', 'lower'], 'avg'),
    lastSync: getSetting('market').lastSync || ''
  })
};

router.put('/settings/:key', (req, res) => {
  const key = req.params.key;
  const shape = SETTING_SHAPES[key];
  if (!shape) return res.status(400).json({ error: '未知的設定項目' });
  const value = shape(req.body || {});
  setSetting(key, value);
  res.json({ ok: true, value });
});

router.get('/settings', (req, res) => {
  res.json({
    look: getSetting('look'), rules: getSetting('rules'),
    delivery: getSetting('delivery'), market: getSetting('market')
  });
});

/* ---------- 更改自己的密碼 ---------- */
router.post('/password', (req, res) => {
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  if (next.length < 10) return res.status(400).json({ error: '新密碼至少 10 碼' });
  if (!A.verifyLogin(req.admin.email, cur)) return res.status(401).json({ error: '目前密碼不正確' });
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?')
    .run(A.hashPassword(next), req.admin.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(req.admin.id);  // 改密碼後所有裝置重新登入
  res.json({ ok: true });
});

module.exports = router;
