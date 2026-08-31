/**
 * 農業部農產品交易行情 — 抓取與正規化
 *
 * 為什麼要放後端跑：
 *   1. 瀏覽器直接呼叫政府 API 會被 CORS 擋下。
 *   2. 每個訪客都去打一次官方 API 既慢又不禮貌，抓一次存起來給所有人用才合理。
 *
 * 官方資料頁：https://data.moa.gov.tw/open_detail.aspx?id=037
 *
 * ⚠️ 欄位相容性
 * 官方端點歷年來出現過兩種回傳格式，normalize() 兩種都吃：
 *   A) 陣列，中文欄位：[{ 交易日期, 作物名稱, 市場名稱, 上價, 中價, 下價, 平均價, 交易量 }]
 *   B) 物件，英文欄位：{ RS:"OK", Data:[{ TransDate, CropName, MarketName,
 *                        Upper_Price, Middle_Price, Lower_Price, Avg_Price }] }
 * 若官方日後又改欄位，只要改 normalize() 這一個函式即可。
 * 上線前請先跑一次 `npm run sync-market`，確認實際欄位對得上。
 */
'use strict';

const { db, getSetting, setSetting } = require('../db');

/** 西元 Date → 民國年格式 115.08.28（官方 API 的日期格式） */
function rocDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear() - 1911}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function normalize(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.Data) ? raw.Data : []);
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  return arr.map(r => ({
    trans_date:  String(r.TransDate    ?? r['交易日期'] ?? ''),
    crop_name:   String(r.CropName     ?? r['作物名稱'] ?? '').trim(),
    market_name: String(r.MarketName   ?? r['市場名稱'] ?? '').trim(),
    upper_price: n(r.Upper_Price       ?? r['上價']),
    mid_price:   n(r.Middle_Price      ?? r['中價']),
    lower_price: n(r.Lower_Price       ?? r['下價']),
    avg_price:   n(r.Avg_Price         ?? r['平均價'])
  })).filter(r => r.crop_name && r.trans_date);
}

/**
 * 抓取並寫入資料庫。
 * @param {number} days 往回抓幾天（預設 3 天，避開假日休市沒有資料的情況）
 * @returns {Promise<{fetched:number, saved:number, marketName:string}>}
 */
async function syncMarket(days = 3) {
  const cfg = getSetting('market');
  const base = process.env.MOA_API_URL || 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);

  const url = new URL(base);
  url.searchParams.set('Start_time', rocDate(start));
  url.searchParams.set('End_time', rocDate(end));
  if (cfg.marketName) url.searchParams.set('MarketName', cfg.marketName);
  if (process.env.MOA_API_KEY) url.searchParams.set('api_key', process.env.MOA_API_KEY);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let payload;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`官方 API 回應 HTTP ${res.status}`);
    payload = await res.json();
  } finally { clearTimeout(timer); }

  let rows = normalize(payload);
  if (cfg.marketName) rows = rows.filter(r => r.market_name.includes(cfg.marketName));

  const ins = db.prepare(`
    INSERT INTO market_prices (trans_date,crop_name,market_name,upper_price,mid_price,lower_price,avg_price,synced_at)
    VALUES (@trans_date,@crop_name,@market_name,@upper_price,@mid_price,@lower_price,@avg_price,datetime('now'))
    ON CONFLICT(trans_date,crop_name,market_name) DO UPDATE SET
      upper_price=excluded.upper_price, mid_price=excluded.mid_price,
      lower_price=excluded.lower_price, avg_price=excluded.avg_price,
      synced_at=excluded.synced_at`);
  const tx = db.transaction(list => list.forEach(r => ins.run(r)));
  tx(rows);

  // 只留最近 60 天，資料庫不會無限長大
  db.prepare(`DELETE FROM market_prices WHERE synced_at < datetime('now','-60 days')`).run();

  setSetting('market', { ...cfg, lastSync: new Date().toISOString() });
  return { fetched: rows.length, saved: rows.length, marketName: cfg.marketName };
}

/** 取每個作物最新一天的行情 */
function latestPrices() {
  return db.prepare(`
    SELECT crop_name, market_name, upper_price, mid_price, lower_price, avg_price, trans_date
    FROM market_prices m
    WHERE trans_date = (SELECT MAX(trans_date) FROM market_prices WHERE crop_name = m.crop_name)
    ORDER BY crop_name`).all();
}

/** 把行情套到商品的 market_price 欄位（比價用的參考市價） */
function applyToProducts() {
  const cfg = getSetting('market');
  const col = cfg.basis === 'upper' ? 'upper_price' : cfg.basis === 'lower' ? 'lower_price' : 'avg_price';
  const prices = latestPrices();
  const products = db.prepare('SELECT id,name,market_key FROM products').all();
  const upd = db.prepare('UPDATE products SET market_price = ? WHERE id = ?');
  let updated = 0;
  const tx = db.transaction(() => {
    for (const p of products) {
      const key = (p.market_key || p.name).trim();
      if (!key) continue;
      const hit = prices.find(r => r.crop_name.includes(key) || key.includes(r.crop_name));
      if (!hit) continue;
      const v = Math.round(hit[col]);
      if (v > 0) { upd.run(v, p.id); updated++; }
    }
  });
  tx();
  return { updated, basis: cfg.basis, total: products.length };
}

module.exports = { syncMarket, normalize, latestPrices, applyToProducts, rocDate };
