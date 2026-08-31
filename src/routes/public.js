/**
 * 前台 API（不需登入）
 *   GET  /api/config          站台設定 + 商品 + 取貨點 + 目前成團進度
 *   POST /api/orders          建立訂單
 *   POST /api/lookup          顧客自助查訂單（訂單編號 + 下單手機）
 *
 * 重要安全原則：金額一律由後端依資料庫的價格重算。
 * 前端送來的 price / total 完全不採信 —— 否則有人改一下網頁就能一元買芒果。
 */
'use strict';

const express = require('express');
const { db, getSetting } = require('../db');
const V = require('../validate');

const router = express.Router();

/* ---------- 讀取站台狀態 ---------- */
function publicProducts() {
  return db.prepare(`SELECT id,name,category,image,unit,price,market_price,stock,market_key
                     FROM products WHERE active = 1 ORDER BY sort_order, id`).all();
}
function pickupPoints() {
  return db.prepare('SELECT id,name,address,hours FROM pickup_points WHERE active = 1 ORDER BY id').all();
}
function progress() {
  const rules = getSetting('rules');
  const agg = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS amount
                          FROM orders WHERE status <> '已取消'`).get();
  const current = rules.thresholdType === 'orders' ? agg.orders : agg.amount;
  const target = Math.max(1, Number(rules.threshold) || 1);
  return {
    orders: agg.orders,
    amount: agg.amount,
    current,
    target,
    pct: Math.min(100, Math.round(current / target * 100)),
    reached: current >= (Number(rules.threshold) || 0)
  };
}
function isClosed() {
  const dl = getSetting('rules').deadline;
  if (!dl) return false;
  const t = new Date(dl).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

router.get('/config', (req, res) => {
  res.json({
    look: getSetting('look'),
    rules: getSetting('rules'),
    delivery: getSetting('delivery'),
    market: { lastSync: getSetting('market').lastSync, marketName: getSetting('market').marketName },
    products: publicProducts(),
    pickups: pickupPoints(),
    progress: progress(),
    closed: isClosed()
  });
});

/* ---------- 運費計算（後端版本，與前端顯示邏輯一致） ---------- */
function calcFee(method, subtotal) {
  const D = getSetting('delivery');
  if (method === 'pickup') return V.int(D.pickupFee);
  const free = V.int(D.freeOver);
  return (free > 0 && subtotal >= free) ? 0 : V.int(D.fee);
}

/* ---------- 建立訂單 ---------- */
router.post('/orders', (req, res, next) => {
  try {
    const rules = getSetting('rules');
    const delivery = getSetting('delivery');

    if (isClosed()) throw new V.BadRequest('本檔次已截止，無法下單');

    const name = V.str(req.body.name, 40);
    const phone = V.phone(req.body.phone);
    const method = V.oneOf(V.str(req.body.method, 10), ['pickup', 'delivery'], 'pickup');
    const note = V.str(req.body.note, 300);
    if (!name) throw new V.BadRequest('請填寫姓名');
    if (!phone) throw new V.BadRequest('手機號碼格式不正確');
    if (method === 'delivery' && !V.int(delivery.enabled)) throw new V.BadRequest('目前未開放宅配');

    let pickupId = null, address = '';
    if (method === 'pickup') {
      pickupId = V.int(req.body.pickupId, { def: 0 }) || null;
      const p = pickupId && db.prepare('SELECT id FROM pickup_points WHERE id = ? AND active = 1').get(pickupId);
      if (!p) throw new V.BadRequest('請選擇有效的取貨地點');
    } else {
      const area = V.str(req.body.area, 30);
      const addr = V.str(req.body.address, 200);
      if (!addr) throw new V.BadRequest('請填寫配送地址');
      if (Array.isArray(delivery.areas) && delivery.areas.length && !delivery.areas.includes(area)) {
        throw new V.BadRequest('該區域目前不在配送範圍');
      }
      address = (area + addr).slice(0, 230);
    }

    // 整理購物車：只收 productId 與 qty，價格一律回資料庫查
    const raw = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
    if (!raw.length) throw new V.BadRequest('購物車是空的');
    const perLimit = V.int(rules.perLimit);

    const lines = [];
    for (const it of raw) {
      const pid = V.int(it.productId, { def: 0 });
      const qty = V.int(it.qty, { min: 1, max: 9999, def: 0 });
      if (!pid || !qty) continue;
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(pid);
      if (!p) throw new V.BadRequest('商品已下架，請重新整理頁面');
      if (perLimit > 0 && qty > perLimit) throw new V.BadRequest(`「${p.name}」每人最多 ${perLimit} ${p.unit}`);
      if (qty > p.stock) throw new V.BadRequest(`「${p.name}」可售數量剩 ${p.stock} ${p.unit}`);
      lines.push({ product: p, qty, amount: p.price * qty });
    }
    if (!lines.length) throw new V.BadRequest('購物車是空的');

    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const minOrder = V.int(rules.minOrder);
    if (minOrder > 0 && subtotal < minOrder) throw new V.BadRequest(`最低訂單金額為 ${minOrder} 元`);
    const fee = calcFee(method, subtotal);

    // 交易：扣庫存 + 寫訂單，任何一步失敗就整批回滾，不會出現扣了庫存卻沒訂單
    const code = 'GB' + Date.now().toString(36).toUpperCase().slice(-6) +
                 Math.floor(Math.random() * 900 + 100);
    const tx = db.transaction(() => {
      for (const l of lines) {
        // WHERE stock >= ? 是關鍵：兩個人同時搶最後一顆時，只有一個會成功
        const r = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?')
                    .run(l.qty, l.product.id, l.qty);
        if (r.changes !== 1) throw new V.BadRequest(`「${l.product.name}」剛剛被搶完了，請調整數量`);
      }
      const o = db.prepare(`INSERT INTO orders
        (code,buyer_name,buyer_phone,method,pickup_id,address,note,subtotal,fee,total)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(code, name, phone, method, pickupId, address, note, subtotal, fee, subtotal + fee);
      const insItem = db.prepare(`INSERT INTO order_items
        (order_id,product_id,name,unit,price,qty,amount) VALUES (?,?,?,?,?,?,?)`);
      for (const l of lines) {
        insItem.run(o.lastInsertRowid, l.product.id, l.product.name, l.product.unit, l.product.price, l.qty, l.amount);
      }
      return o.lastInsertRowid;
    });
    tx();

    res.json({
      ok: true,
      code,
      subtotal, fee, total: subtotal + fee,
      progress: progress(),
      successNote: rules.successNote
    });
  } catch (e) { next(e); }
});

/* ---------- 顧客自助查訂單 ----------
   不做會員系統，改用「訂單編號 + 下單時填的手機」兩者都對才給看。
   查不到時一律回同一句話，不告訴對方是編號錯還是電話錯 ——
   否則就等於提供一個可以慢慢試出別人訂單的工具。
   外層另有速率限制（見 src/server.js），擋暴力嘗試。 */
function maskName(name) {
  const s = String(name || '');
  if (s.length <= 1) return s;
  if (s.length === 2) return s[0] + '＊';
  return s[0] + '＊'.repeat(s.length - 2) + s[s.length - 1];
}

router.post('/lookup', (req, res, next) => {
  try {
    const code = V.str(req.body.code, 20).toUpperCase();
    const phone = V.phone(req.body.phone);
    if (!code || !phone) throw new V.BadRequest('請輸入訂單編號與下單時填寫的手機號碼');

    const o = db.prepare('SELECT * FROM orders WHERE code = ? AND buyer_phone = ?').get(code, phone);
    if (!o) throw new V.BadRequest('查無此訂單，請確認訂單編號與手機號碼是否正確');

    const items = db.prepare('SELECT name, unit, price, qty, amount FROM order_items WHERE order_id = ?').all(o.id);
    const pickup = o.pickup_id
      ? db.prepare('SELECT name, address, hours FROM pickup_points WHERE id = ?').get(o.pickup_id)
      : null;

    res.json({
      ok: true,
      order: {
        code: o.code,
        created_at: o.created_at,
        buyer_name: maskName(o.buyer_name),   // 只回遮罩過的姓名，萬一手機被別人拿到也不會整份個資外流
        method: o.method,
        address: o.address,
        note: o.note,
        subtotal: o.subtotal, fee: o.fee, total: o.total,
        status: o.status, pay_status: o.pay_status,
        items, pickup
      },
      progress: progress()
    });
  } catch (e) { next(e); }
});

module.exports = { router, progress, isClosed, calcFee };
