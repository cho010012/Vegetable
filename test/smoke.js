/**
 * 冒煙測試 —— 確認整條路徑會動：
 *   啟動 → 建管理員 → 下單 → 查訂單 → 登入後台 → 上傳商品圖 → 匯出 → 登出
 *   npm run smoke
 *
 * 測試會用「自己的」資料庫檔與圖片目錄（GB_DB_FILE / GB_UPLOAD_DIR），
 * 完全不碰 data/groupbuy.db —— 所以正式服務正在執行時也能安心跑測試。
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupbuy-smoke-'));

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.GB_DB_FILE = path.join(tmpDir, 'smoke.db');
process.env.GB_UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.ADMIN_EMAIL = '';        // 佔位，讓 dotenv 不要把 .env 的管理員帳密帶進測試
process.env.ADMIN_PASSWORD = '';

const app = require('../src/server');
const { db } = require('../src/db');
const { createAdmin } = require('../src/auth');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push('PASS — ' + name); }
  catch (e) { results.push('FAIL — ' + name + ' :: ' + e.message); process.exitCode = 1; }
};

let server, base, cookie = '';

async function req(method, url, body, opts = {}) {
  const res = await fetch(base + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}, opts.headers),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && opts.keepCookie !== false) cookie = setCookie.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  return { status: res.status, data, headers: res.headers };
}

(async () => {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;

  try { createAdmin('smoke@test.local', 'smoke-password-123'); } catch {}

  // 1. 公開設定
  let r = await req('GET', '/api/config');
  check('GET /api/config 回 200', () => assert.strictEqual(r.status, 200));
  check('種子商品已建立', () => assert.ok(r.data.products.length >= 7));
  const cabbage = r.data.products.find(p => p.name === '高麗菜');
  const mango = r.data.products.find(p => p.name === '愛文芒果');
  const pickupId = r.data.pickups[0].id;
  const stockBefore = cabbage.stock;

  // 2. 後台未登入應被擋
  r = await req('GET', '/api/admin/orders');
  check('未登入存取後台回 401', () => assert.strictEqual(r.status, 401));

  // 3. 低於最低訂單金額
  r = await req('POST', '/api/orders', {
    name: '測試', phone: '0912345678', method: 'pickup', pickupId,
    items: [{ productId: cabbage.id, qty: 1 }]
  });
  check('低於最低訂單金額被擋', () => assert.strictEqual(r.status, 400));

  // 4. 錯誤手機格式
  r = await req('POST', '/api/orders', {
    name: '測試', phone: '123', method: 'pickup', pickupId,
    items: [{ productId: mango.id, qty: 2 }]
  });
  check('手機格式驗證', () => assert.ok(r.data.error.includes('手機')));

  // 5. 竄改價格：前端送 price=1，後端必須用資料庫價格
  r = await req('POST', '/api/orders', {
    name: '王小美', phone: '0912345678', method: 'pickup', pickupId, note: '測試單',
    items: [{ productId: mango.id, qty: 2, price: 1 }]
  });
  check('正常下單成功', () => assert.strictEqual(r.status, 200));
  check('金額以伺服器價格計算（非前端傳入的 1 元）',
    () => assert.strictEqual(r.data.subtotal, mango.price * 2));
  check('自取無運費', () => assert.strictEqual(r.data.fee, 0));
  const code = r.data.code;

  // 6. 庫存扣減
  r = await req('GET', '/api/config');
  const mangoAfter = r.data.products.find(p => p.id === mango.id);
  check('庫存已扣減', () => assert.strictEqual(mangoAfter.stock, mango.stock - 2));

  // 7. 超量下單被擋
  r = await req('POST', '/api/orders', {
    name: '測試', phone: '0922333444', method: 'pickup', pickupId,
    items: [{ productId: mango.id, qty: 99999 }]
  });
  check('超過庫存被擋', () => assert.strictEqual(r.status, 400));

  // 8. 每人限購
  r = await req('POST', '/api/orders', {
    name: '測試', phone: '0922333444', method: 'pickup', pickupId,
    items: [{ productId: cabbage.id, qty: 50 }]
  });
  check('每人限購生效', () => assert.ok(r.data.error.includes('每人最多')));

  // 9. 宅配運費 + 免運門檻
  r = await req('POST', '/api/orders', {
    name: '陳大文', phone: '0922333444', method: 'delivery', area: '松山區', address: '八德路四段1號',
    items: [{ productId: mango.id, qty: 2 }]   // 360 元：已達最低訂單金額，但未達 800 免運門檻
  });
  check('宅配收運費 80', () => assert.strictEqual(r.data.fee, 80));

  r = await req('POST', '/api/orders', {
    name: '林淑芬', phone: '0933555777', method: 'delivery', area: '信義區', address: '松高路11號',
    items: [{ productId: mango.id, qty: 5 }]   // 900 元 >= 800 免運
  });
  check('達免運門檻不收運費', () => assert.strictEqual(r.data.fee, 0));

  // 10. 不在配送區域
  r = await req('POST', '/api/orders', {
    name: '測試', phone: '0955666777', method: 'delivery', area: '高雄市', address: 'XX路1號',
    items: [{ productId: mango.id, qty: 2 }]
  });
  check('非配送區域被擋', () => assert.ok(String(r.data.error).includes('配送範圍')));

  // 11. 登入
  r = await req('POST', '/api/admin/login', { email: 'smoke@test.local', password: 'wrong' });
  check('錯誤密碼登入失敗', () => assert.strictEqual(r.status, 401));
  r = await req('POST', '/api/admin/login', { email: 'smoke@test.local', password: 'smoke-password-123' });
  check('正確密碼登入成功', () => assert.strictEqual(r.status, 200));
  check('session cookie 為 httpOnly', () => assert.ok(/httponly/i.test(r.headers.get('set-cookie'))));

  // 12. 後台彙總
  r = await req('GET', '/api/admin/dashboard');
  check('儀表板可讀', () => assert.strictEqual(r.status, 200));
  const mangoRow = r.data.purchase.find(x => x.name === '愛文芒果');
  check('採購彙總數量正確 (2+2+5=9)', () => assert.strictEqual(mangoRow.qty, 9));
  check('KPI 訂單數 = 3', () => assert.strictEqual(r.data.kpi.orders, 3));

  // 13. 設定寫入 + 驗證白名單
  r = await req('PUT', '/api/admin/settings/look', { name: '松山共購社', mark: '松', brand: 'javascript:alert(1)', tagline: 'hi' });
  check('非法色碼被換成預設值', () => assert.strictEqual(r.data.value.brand, '#2f7d32'));
  r = await req('PUT', '/api/admin/settings/rules', { title: 'T', thresholdType: 'hack', threshold: 100 });
  check('非法列舉值被修正', () => assert.strictEqual(r.data.value.thresholdType, 'amount'));

  // 14. 商品 CRUD + XSS 字串原樣存（輸出端才轉義）
  r = await req('POST', '/api/admin/products', {
    name: '<script>alert(1)</script>惡意', price: 10, stock: 5, unit: '份',
    image: 'javascript:alert(1)', active: 1
  });
  check('新增商品成功', () => assert.strictEqual(r.status, 200));
  const badId = r.data.id;
  r = await req('GET', '/api/admin/products');
  const bad = r.data.products.find(p => p.id === badId);
  check('危險的 image 值被換掉', () => assert.ok(!/javascript:/i.test(bad.image)));

  // 15. SQL injection 嘗試
  r = await req('POST', '/api/orders', {
    name: "'); DROP TABLE orders;--", phone: '0912345678', method: 'pickup', pickupId,
    items: [{ productId: mango.id, qty: 2 }]
  });
  check('SQL injection 字串被當成普通文字', () => assert.strictEqual(r.status, 200));
  check('orders 表仍存在', () => assert.ok(db.prepare('SELECT COUNT(*) c FROM orders').get().c >= 4));
  check('沒有被塞進假的資料表', () => assert.ok(
    db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c >= 8));

  // 16. 刪單會把庫存加回
  const ord = db.prepare('SELECT id FROM orders WHERE code = ?').get(code);
  const before = db.prepare('SELECT stock FROM products WHERE id = ?').get(mango.id).stock;
  await req('DELETE', '/api/admin/orders/' + ord.id);
  const after = db.prepare('SELECT stock FROM products WHERE id = ?').get(mango.id).stock;
  check('刪單後庫存加回 2', () => assert.strictEqual(after, before + 2));

  // 17. CSV 匯出
  r = await req('GET', '/api/admin/purchase.csv');
  check('叫貨單 CSV 可下載', () => assert.ok(String(r.data).includes('總需求量')));

  // 18. 商品圖片上傳
  //     用最小的合法 PNG（1x1 透明點）當測試素材
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

  async function upload(body, contentType, withCookie = true) {
    const res = await fetch(base + '/api/admin/uploads', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': contentType },
        withCookie && cookie ? { Cookie: cookie } : {}),
      body
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  let up = await upload(PNG_1x1, 'image/png', false);
  check('未登入不能上傳圖片', () => assert.strictEqual(up.status, 401));

  // 副檔名/Content-Type 說是圖片，內容其實是腳本 → 必須被檔頭檢查擋下
  up = await upload(Buffer.from('<?php system($_GET["c"]); ?>'), 'image/png');
  check('偽裝成圖片的非圖片內容被擋（檔頭檢查）', () => assert.strictEqual(up.status, 415));

  up = await upload(PNG_1x1, 'image/png');
  check('上傳合法 PNG 成功', () => assert.strictEqual(up.status, 200));
  check('回傳的網址是伺服器產生的隨機檔名',
    () => assert.ok(/^\/uploads\/[0-9a-f]{32}\.png$/.test(up.data.url)));
  const imgUrl = up.data.url;

  // 圖片可以被讀取，而且帶著正確型別與 nosniff
  let imgRes = await fetch(base + imgUrl);
  check('上傳的圖片可公開讀取', () => assert.strictEqual(imgRes.status, 200));
  check('圖片 Content-Type 正確', () => assert.ok(imgRes.headers.get('content-type').includes('image/png')));
  check('圖片帶 nosniff 標頭', () => assert.strictEqual(imgRes.headers.get('x-content-type-options'), 'nosniff'));

  // 路徑穿越 / 亂猜檔名一律 404，不會洩漏伺服器上的其他檔案
  for (const bad of ['/uploads/..%2f..%2fpackage.json', '/uploads/groupbuy.db', '/uploads/xxx.png']) {
    const r2 = await fetch(base + bad, { redirect: 'manual' });
    check('非法圖片路徑被擋：' + bad, () => assert.ok(r2.status === 404 || r2.status === 400));
  }

  // 把圖片綁到商品上，前台就看得到
  r = await req('POST', '/api/admin/products', {
    name: '測試圖片商品', price: 30, stock: 3, unit: '份', image: imgUrl, active: 1
  });
  const imgPid = r.data.id;
  r = await req('GET', '/api/config');
  check('前台商品帶得出上傳的圖片網址',
    () => assert.strictEqual(r.data.products.find(x => x.id === imgPid).image, imgUrl));

  // 刪掉商品，圖片檔也要一起清掉，不留孤兒檔
  const imgFile = path.join(process.env.GB_UPLOAD_DIR, imgUrl.split('/').pop());
  check('圖片檔實際存在磁碟上', () => assert.ok(fs.existsSync(imgFile)));
  await req('DELETE', '/api/admin/products/' + imgPid);
  check('刪除商品後圖片檔一併清除', () => assert.ok(!fs.existsSync(imgFile)));

  // 19. 顧客自助查訂單
  r = await req('POST', '/api/lookup', { code, phone: '0912345678' });
  check('已刪除的訂單查不到', () => assert.strictEqual(r.status, 400));   // 這筆訂單在第 16 步已被刪掉
  const alive = db.prepare('SELECT code, buyer_phone FROM orders ORDER BY id DESC LIMIT 1').get();
  r = await req('POST', '/api/lookup', { code: alive.code, phone: alive.buyer_phone });
  check('查詢現存訂單成功', () => assert.strictEqual(r.status, 200));
  check('回傳的姓名有遮罩', () => assert.ok(r.data.order.buyer_name.includes('＊')));
  check('回傳不含完整電話',
    () => assert.ok(!JSON.stringify(r.data).includes(alive.buyer_phone)));
  r = await req('POST', '/api/lookup', { code: alive.code, phone: '0900000000' });
  check('電話對不上查不到', () => assert.strictEqual(r.status, 400));
  check('查不到時不透露是編號錯還是電話錯',
    () => assert.ok(String(r.data.error).includes('查無此訂單')));

  // 20. 登出後不能再存取
  await req('POST', '/api/admin/logout');
  cookie = '';
  r = await req('GET', '/api/admin/dashboard');
  check('登出後回 401', () => assert.strictEqual(r.status, 401));

  // 21. 前台頁面可取得
  r = await req('GET', '/');
  check('前台首頁可取得', () => assert.ok(String(r.data).includes('<title>')));
  r = await req('GET', '/admin');
  check('後台頁面可取得', () => assert.ok(String(r.data).includes('管理後台')));

  console.log(results.join('\n'));
  console.log(`\n${results.filter(x => x.startsWith('PASS')).length} 通過 / ${results.filter(x => x.startsWith('FAIL')).length} 失敗`);

  server.close();
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 暫存檔清不掉不影響結果 */ }
  process.exit(process.exitCode || 0);
})();
