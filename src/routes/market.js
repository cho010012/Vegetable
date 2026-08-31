/**
 * 行情相關 API（需登入）
 *   POST /api/admin/market/sync    立刻向農業部抓一次
 *   GET  /api/admin/market/latest  看目前資料庫裡的行情
 *   POST /api/admin/market/apply   套用到商品市價
 */
'use strict';

const express = require('express');
const { requireAdmin } = require('../auth');
const { syncMarket, latestPrices, applyToProducts } = require('../jobs/marketSync');
const { db } = require('../db');

const router = express.Router();
router.use(requireAdmin);

router.post('/sync', async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.body?.days, 10) || 3));
    const r = await syncMarket(days);
    res.json({ ok: true, ...r });
  } catch (e) {
    // 把真正的原因回給管理員，方便自己排查；不要把堆疊丟給前端
    res.status(502).json({
      error: '抓取失敗：' + e.message,
      hint: '請確認 .env 的 MOA_API_URL 是否正確、主機能否連外，或官方 API 是否暫時無回應。'
    });
  }
});

router.get('/latest', (req, res) => {
  res.json({
    rows: latestPrices().slice(0, 500),
    count: db.prepare('SELECT COUNT(*) c FROM market_prices').get().c
  });
});

router.post('/apply', (req, res) => res.json({ ok: true, ...applyToProducts() }));

module.exports = router;
