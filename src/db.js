/**
 * 資料庫層 — SQLite（better-sqlite3）
 *
 * 為什麼用 SQLite：單一檔案、免安裝資料庫伺服器、備份就是複製一個檔案。
 * 社區團購這種規模（一天幾百筆訂單）綽綽有餘。
 * 未來若要換 PostgreSQL，只要改這個檔案裡的連線與 SQL 方言即可。
 *
 * 連線由 src/sqlite.js 提供 —— 預設走 Node 內建的 node:sqlite，
 * 所以整個專案沒有任何需要編譯的原生模組。
 *
 * 安全重點：所有查詢一律使用「預備語句 + 參數綁定」（? 佔位符），
 * 絕不用字串拼接組 SQL — 這是防 SQL Injection 的根本作法。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sqlite = require('./sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 預設 data/groupbuy.db；設 GB_DB_FILE 可指向別的檔案（測試就是靠這個用獨立資料庫，
// 不會碰到正式資料，也不必因為伺服器正在執行而卡住）
const DB_FILE = process.env.GB_DB_FILE
  ? path.resolve(process.env.GB_DB_FILE)
  : path.join(DATA_DIR, 'groupbuy.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = sqlite.open(DB_FILE);
db.pragma('journal_mode = WAL');   // 併發讀寫較穩
db.pragma('foreign_keys = ON');

/* ---------------------------------------------------------------------------
   結構定義
   要新增欄位：在下面加 ALTER TABLE，或直接改 CREATE TABLE 後刪掉 data/groupbuy.db
   （刪檔會清空資料，正式環境請先備份！）
--------------------------------------------------------------------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 站台設定：一列一個 key，value 存 JSON 字串
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  category     TEXT    NOT NULL DEFAULT '其他',
  image        TEXT    NOT NULL DEFAULT '🥬',   -- emoji 或圖片網址
  unit         TEXT    NOT NULL DEFAULT '份',
  price        INTEGER NOT NULL DEFAULT 0,      -- 團購價（元，整數）
  market_price INTEGER NOT NULL DEFAULT 0,      -- 市價（比價用）
  stock        INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  market_key   TEXT    NOT NULL DEFAULT '',     -- 對應行情資料的作物名稱關鍵字
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pickup_points (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  hours   TEXT NOT NULL DEFAULT '',
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,           -- 對顧客顯示的訂單編號
  buyer_name  TEXT    NOT NULL,
  buyer_phone TEXT    NOT NULL,
  method      TEXT    NOT NULL,                  -- pickup | delivery
  pickup_id   INTEGER REFERENCES pickup_points(id) ON DELETE SET NULL,
  address     TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  subtotal    INTEGER NOT NULL,
  fee         INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT '待處理',
  pay_status  TEXT    NOT NULL DEFAULT '未付款', -- 未付款 | 已付款 | 已退款
  pay_ref     TEXT    NOT NULL DEFAULT '',       -- 金流交易序號（串接後填入）
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name       TEXT    NOT NULL,   -- 下單當下的品名與價格快照，之後改商品不影響舊訂單
  unit       TEXT    NOT NULL,
  price      INTEGER NOT NULL,
  qty        INTEGER NOT NULL,
  amount     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- 農業部行情快取：由後端排程抓取，前端只讀這張表（避免 CORS 與 API 流量問題）
CREATE TABLE IF NOT EXISTS market_prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trans_date  TEXT NOT NULL,
  crop_name   TEXT NOT NULL,
  market_name TEXT NOT NULL,
  upper_price REAL NOT NULL DEFAULT 0,
  mid_price   REAL NOT NULL DEFAULT 0,
  lower_price REAL NOT NULL DEFAULT 0,
  avg_price   REAL NOT NULL DEFAULT 0,
  synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trans_date, crop_name, market_name)
);
CREATE INDEX IF NOT EXISTS idx_market_crop ON market_prices(crop_name);
`);

/* ---------------------------------------------------------------------------
   設定的預設值
--------------------------------------------------------------------------- */
const DEFAULT_SETTINGS = {
  look: {
    name: '鄰里鮮買',
    mark: '菜',
    brand: '#2f7d32',
    tagline: '上班沒空買菜？跟鄰居一起團，週三下班直接到取貨點提走。',
    announce: ''
  },
  rules: {
    title: '本週社區蔬果團購',
    deadline: '',                 // ISO 字串，空 = 不設截止
    thresholdType: 'amount',      // amount | orders
    threshold: 5000,
    perLimit: 10,
    minOrder: 200,
    cycle: '每週一開團、週三 17:00 後取貨',
    successNote: '成團後會以簡訊通知取貨時間，未成團則全額不收款。'
  },
  delivery: {
    enabled: 1,
    fee: 80,
    freeOver: 800,
    pickupFee: 0,
    areas: ['松山區', '信義區', '大安區']
  },
  market: {
    marketName: process.env.MOA_MARKET || '台北一',
    basis: 'avg',                 // avg | upper | lower
    lastSync: ''
  }
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return DEFAULT_SETTINGS[key] ?? null;
  try {
    // 與預設值合併，這樣日後新增欄位時舊資料也不會缺 key
    return { ...(DEFAULT_SETTINGS[key] || {}), ...JSON.parse(row.value) };
  } catch {
    return DEFAULT_SETTINGS[key] ?? null;
  }
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(value));
}
function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k);
  return out;
}

/* ---------------------------------------------------------------------------
   種子資料：資料庫全空時塞一批示範商品與取貨點，方便第一次啟動就看得到東西
--------------------------------------------------------------------------- */
function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (n > 0) return;
  const ins = db.prepare(`INSERT INTO products (name,category,image,unit,price,market_price,stock,market_key,sort_order)
                          VALUES (?,?,?,?,?,?,?,?,?)`);
  const seed = [
    ['高麗菜', '蔬菜', '🥬', '顆', 45, 62, 60, '甘藍', 1],
    ['牛番茄', '蔬菜', '🍅', '斤', 55, 75, 40, '番茄', 2],
    ['青江菜', '蔬菜', '🥗', '把', 30, 40, 80, '青江白菜', 3],
    ['紅蘿蔔', '根莖', '🥕', '斤', 35, 48, 50, '胡蘿蔔', 4],
    ['馬鈴薯', '根莖', '🥔', '斤', 40, 52, 45, '馬鈴薯', 5],
    ['香蕉', '水果', '🍌', '把', 50, 70, 35, '香蕉', 6],
    ['愛文芒果', '水果', '🥭', '盒', 180, 240, 20, '芒果', 7]
  ];
  const tx = db.transaction(rows => rows.forEach(r => ins.run(...r)));
  tx(seed);

  const insP = db.prepare('INSERT INTO pickup_points (name,address,hours) VALUES (?,?,?)');
  insP.run('民生社區活動中心', '台北市松山區民生東路五段163-1號', '週三 17:00–20:00');
  insP.run('興安里辦公處', '台北市松山區八德路四段123號', '週三 18:00–21:00');
}

module.exports = { db, DB_FILE, getSetting, setSetting, allSettings, seedIfEmpty, DEFAULT_SETTINGS };
