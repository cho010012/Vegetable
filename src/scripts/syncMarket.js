/**
 * 手動或排程抓取農業部行情
 *   npm run sync-market          抓最近 3 天
 *   npm run sync-market -- 7     抓最近 7 天
 *
 * 建議用系統排程每天跑一次，例如 Linux crontab（每天早上 6:10）：
 *   10 6 * * * cd /srv/groupbuy && /usr/bin/npm run sync-market >> data/market.log 2>&1
 */
'use strict';
require('dotenv').config();

const { syncMarket, applyToProducts } = require('../jobs/marketSync');

(async () => {
  const days = parseInt(process.argv[2], 10) || 3;
  try {
    const r = await syncMarket(days);
    console.log(`✅ 已同步 ${r.fetched} 筆行情（市場：${r.marketName || '全部'}）`);
    if (!r.fetched) {
      console.warn('⚠️  沒有取得任何資料。可能原因：假日休市、市場名稱打錯、或官方回傳欄位改了。');
      console.warn('    請開 src/jobs/marketSync.js 的 normalize()，把實際回傳欄位對上去。');
    }
    const a = applyToProducts();
    console.log(`✅ 已依「${a.basis}」更新 ${a.updated}/${a.total} 項商品的參考市價`);
  } catch (e) {
    console.error('❌ 同步失敗：', e.message);
    process.exit(1);
  }
})();
