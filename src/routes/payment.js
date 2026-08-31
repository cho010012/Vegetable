/**
 * 金流串接預留位置 —— 目前「未啟用」，訂單一律是取貨時付款。
 *
 * 想接線上支付時，台灣常見選項是綠界 ECPay 或藍新 NewebPay，流程都一樣：
 *
 *   1. 顧客送出訂單 → 後端建立訂單（狀態 pay_status = '未付款'）
 *   2. 後端組一張「付款表單」，含商品名稱、金額、訂單編號，
 *      並用你的 HashKey / HashIV 算出檢查碼 CheckMacValue
 *   3. 前端把表單 POST 到金流的付款頁，顧客在金流端刷卡
 *   4. 金流「伺服器對伺服器」打你的 /api/payment/callback 回報結果
 *      → 這一步是唯一可信的付款憑據，一定要驗檢查碼
 *   5. 驗過才把 pay_status 改成 '已付款'
 *
 * ⚠️ 三個最常見的坑，實作時務必注意：
 *   - 絕對不要相信「瀏覽器導回頁面」帶的付款成功參數，那個可以偽造。
 *     只認第 4 步的伺服器回呼。
 *   - 金額一律用資料庫裡的訂單金額重算比對，不要用回呼帶來的數字直接寫入。
 *   - HashKey / HashIV 只能放 .env，不可寫進程式碼、不可提交到 git。
 */
'use strict';

const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    enabled: false,
    provider: null,
    note: '目前為取貨付款模式。要啟用線上支付，請參考 src/routes/payment.js 的說明與維護手冊「串接金流」一節。'
  });
});

/*
// --- 啟用時把下面解除註解，並補上金流商 SDK / 檢查碼運算 ---
//
// router.post('/create', requireNothing, (req, res) => {
//   const order = db.prepare('SELECT * FROM orders WHERE code = ?').get(String(req.body.code || ''));
//   if (!order) return res.status(404).json({ error: '找不到訂單' });
//   if (order.pay_status === '已付款') return res.status(409).json({ error: '此訂單已付款' });
//
//   const params = {
//     MerchantID:      process.env.ECPAY_MERCHANT_ID,
//     MerchantTradeNo: order.code,
//     TotalAmount:     order.total,          // ← 用資料庫金額，不用前端傳的
//     ItemName:        '社區團購商品',
//     ReturnURL:       'https://你的網域/api/payment/callback',
//   };
//   params.CheckMacValue = makeCheckMac(params, process.env.ECPAY_HASH_KEY, process.env.ECPAY_HASH_IV);
//   res.json({ action: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5', params });
// });
//
// router.post('/callback', express.urlencoded({ extended: false }), (req, res) => {
//   if (!verifyCheckMac(req.body, process.env.ECPAY_HASH_KEY, process.env.ECPAY_HASH_IV)) {
//     return res.status(400).send('0|CheckMacValue Error');
//   }
//   const order = db.prepare('SELECT * FROM orders WHERE code = ?').get(String(req.body.MerchantTradeNo));
//   if (order && Number(req.body.RtnCode) === 1 && Number(req.body.TradeAmt) === order.total) {
//     db.prepare("UPDATE orders SET pay_status = '已付款', pay_ref = ? WHERE id = ?")
//       .run(String(req.body.TradeNo || ''), order.id);
//   }
//   res.send('1|OK');   // 金流商規定要回這個字串，否則會一直重送
// });
*/

module.exports = router;
