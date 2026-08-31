# 社區蔬果團購平台 — 安裝與維護手冊

一個給社區／公司行號自己開團的蔬果團購網站。手機、電腦都能用，
團主在後台調參數，顧客在前台下單，後台自動彙總出「該跟供應商叫多少貨」。

---

## 目錄

1. [五分鐘跑起來](#1-五分鐘跑起來)
2. [日常操作：一次開團的完整流程](#2-日常操作一次開團的完整流程)
3. [後台可以調哪些參數](#3-後台可以調哪些參數)
4. [農業部行情比價怎麼運作](#4-農業部行情比價怎麼運作)
5. [部署上線](#5-部署上線)
6. [備份與還原](#6-備份與還原)
7. [安全須知（請務必看）](#7-安全須知請務必看)
8. [串接線上金流](#8-串接線上金流)
9. [改程式：檔案地圖](#9-改程式檔案地圖)
10. [常見問題排查](#10-常見問題排查)

---

## 1. 五分鐘跑起來

需要 **Node.js 22.5 以上**（建議直接裝 24 LTS：https://nodejs.org ）。

> 資料庫用的是 Node **內建**的 `node:sqlite`，所以這個專案**沒有任何需要編譯的套件** ——
> Windows 上不必安裝 Visual Studio Build Tools，`npm install` 幾秒就跑完。
> 用 `node -v` 確認版本；若低於 22.5 請先升級 Node。

```bash
# 1. 安裝套件
npm install

# 2. 建立設定檔
cp .env.example .env          # Windows 用 copy .env.example .env

# 3. 打開 .env，至少改這三行：
#    SESSION_SECRET=（貼上下面指令產生的隨機字串）
#    ADMIN_EMAIL=你的email
#    ADMIN_PASSWORD=一組至少12碼的強密碼
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. 啟動
npm start
```

打開瀏覽器：

| 位置 | 網址 |
|---|---|
| 前台（顧客用） | http://localhost:3000/ |
| 後台（團主用） | http://localhost:3000/admin |

第一次啟動會自動建立 `.env` 裡的管理員帳號，並塞入 7 樣示範商品和 2 個取貨點。
**建立完成後請把 `.env` 裡的 `ADMIN_PASSWORD` 那一行刪掉**（密碼已經雜湊存進資料庫，不需要再留明碼）。

之後要改密碼或加管理員：

```bash
npm run init-admin -- someone@example.com 新的長密碼
```

確認整包還正常：

```bash
npm run smoke     # 32 項自動測試，含下單、權限、金額竄改、SQL 注入
```

---

## 2. 日常操作：一次開團的完整流程

| 時機 | 你要做的事 | 在哪裡 |
|---|---|---|
| 週一 開團 | 更新本期商品、價格、可售數量、**上傳商品照片** | 後台 → 商品與價格 |
| | 設定截止時間與成團門檻 | 後台 → 成團規則 |
| | （選）同步行情，讓比價數字是新的 | 後台 → 行情比價 → 立刻同步行情 |
| | 把前台網址貼到社區 LINE 群 | — |
| 週二 截止前 | 看進度、催單 | 後台 → 訂單與彙總（首頁 KPI） |
| 截止後 | **下載叫貨單 CSV**，拿去跟供應商叫貨 | 後台 → 下載叫貨單 CSV |
| 取貨日 | 顧客來取貨，逐筆把狀態改成「已取貨」、付款改「已付款」 | 後台 → 訂單明細 |
| 收尾 | 下載訂單 CSV 對帳、備份資料庫 | `npm run backup` |

> 「總需求量」那張表就是你的叫貨單 —— 系統會把所有訂單依商品加總。

### 顧客自己查訂單

顧客在前台右上角按「查訂單」，輸入**訂單編號 + 下單時填的手機號碼**就能看到自己的訂單狀態、
品項與應付金額，不用來問你。兩個條件都要對才查得到，姓名只會顯示遮罩過的版本（例：王＊美），
而且同一個 IP 每 10 分鐘最多查 30 次，避免有人拿編號慢慢試別人的訂單。

---

## 3. 後台可以調哪些參數

全部都在後台改，**不需要動程式碼**。

### 商品與價格
品名、分類、商品圖片、單位、團購價、市價、可售數量、排序、上下架、行情關鍵字。
改完按該列的「存」。下架的商品前台立刻消失，但舊訂單不受影響。
「排序」數字小的排前面，同數字則依建立順序。

#### 商品圖片怎麼維護（都在網頁上做，不必碰主機）

| 想做的事 | 怎麼做 |
|---|---|
| 新商品配一張照片 | 「新增商品」區塊按 **📷 上傳圖片** → 選檔 → 縮圖出現後填品名價格 → **新增到本期** |
| 換掉既有商品的照片 | 該列縮圖下方按 **換圖** → 選檔（上傳完會自動存檔，不必再按「存」） |
| 改用 emoji | 直接把該列的「圖示/網址」欄位改成 emoji（例 🥬）再按「存」 |
| 用外部圖片網址 | 把 `https://…` 的圖片網址貼進同一個欄位再按「存」 |

- 支援 **JPG／PNG／WebP／GIF**，單張上限 4MB。
- 上傳前瀏覽器會自動把圖縮到最長邊 1200px 並轉成 WebP，通常只剩幾十 KB，
  顧客用手機開也很快（GIF 不處理，以免動畫被壓成靜態圖）。
- 圖片存在主機的 `data/uploads/`，檔名由伺服器隨機產生。
  換圖或刪商品後，沒有任何商品在用的舊圖會被自動清掉，不會越積越多。
- **備份時記得連 `data/uploads/` 一起複製**（見第 6 節），否則還原後圖片會變成破圖。

### 成團規則
- **檔次名稱**：前台大標題
- **截止時間**：到點後前台自動停止下單（留空 = 不設截止）
- **成團門檻**：可選「累計金額」或「下單筆數」，前台會顯示進度條
- **每人單品限購**：0 = 不限
- **最低訂單金額**：沒達到不能結帳
- **成團說明**：顧客下單完看到的那段文字

### 取貨點與運費
- **自取地點**：名稱／地址／時段，可多個，停用後前台不再顯示（舊訂單保留紀錄）
- **宅配開關**、**基本運費**、**免運門檻**（0 = 不免運）、**自取手續費**
- **可配送區域**：逗號分隔，不在清單內的地址後端會擋下

運費規則寫在 `src/routes/public.js` 的 `calcFee()`，想改成「依重量計費」或「分區不同價」就改那個函式。

### 外觀與文案
平台名稱、Logo 文字、主色（整站配色會跟著變）、首頁標語、公告。

### 行情比價
見下一節。

### 帳號與備份
改密碼、下載 CSV。

---

## 4. 農業部行情比價怎麼運作

資料來源：農業資料開放平臺「農產品交易行情」
<https://data.moa.gov.tw/open_detail.aspx?id=037>

**流程是：伺服器抓 → 存資料庫 → 前台讀資料庫。**
不是讓瀏覽器直接打政府 API，因為那樣會被 CORS 擋下，而且每個訪客都去打官方 API 既慢又不禮貌。

```
  農業部 API ──(每天一次)──> market_prices 資料表 ──> 商品的「市價」欄位 ──> 前台「省 27%」
```

### 怎麼用

1. 後台 → 行情比價 → 設定「對照批發市場」（例：台北一）與「價格基準」（平均價／上價／下價）
2. 按「立刻同步行情」
3. 按「套用到商品市價」—— 系統用每個商品的**行情關鍵字**去比對行情裡的作物名稱

> 行情關鍵字很重要：你賣的叫「高麗菜」，行情資料裡叫「甘藍」，所以關鍵字要填「甘藍」才對得上。
> 對照結果可在「行情比價」頁面的表格確認。

### 設成每天自動抓

Linux / macOS，`crontab -e` 加一行（每天早上 6:10）：

```
10 6 * * * cd /srv/groupbuy && /usr/bin/npm run sync-market >> data/market.log 2>&1
```

Windows 用「工作排程器」執行 `npm run sync-market`，起始位置設為專案資料夾。

### ⚠️ 第一次使用一定要驗證欄位

政府 API 的回傳欄位歷年來改過，程式裡的 `normalize()` 同時支援兩種已知格式：

- 中文欄位：`交易日期 / 作物名稱 / 市場名稱 / 上價 / 中價 / 下價 / 平均價`
- 英文欄位：`TransDate / CropName / MarketName / Upper_Price / Middle_Price / Lower_Price / Avg_Price`

**請先跑一次確認：**

```bash
npm run sync-market
```

如果印出「已同步 0 筆」，先確認是不是假日休市；若平日也是 0，就是欄位又變了。
這時打開 `src/jobs/marketSync.js` 的 `normalize()`，把實際回傳的欄位名補上去即可 —— **只需要改這一個函式**。

想看實際回傳長什麼樣：

```bash
curl "https://data.moa.gov.tw/api/v1/AgriProductsTransType/?Start_time=115.08.20&End_time=115.08.27" | head -c 1000
```

若該端點需要申請金鑰，到開放平臺申請後填進 `.env` 的 `MOA_API_KEY`。

---

## 5. 部署上線

### 選項 A：雲端平台（最省事）

Zeabur、Render、Railway 這類平台都可以：

1. 把專案推到 GitHub（`.env` 不會被上傳，`.gitignore` 已排除）
2. 平台上選這個 repo，Build 指令留空，Start 指令 `npm start`
3. 在平台的環境變數頁面填入 `.env` 裡的每一項
4. **掛一顆持久磁碟並掛載到 `/app/data`** —— 沒有這步，每次重新部署訂單就全沒了

### 選項 B：自己的主機（VPS / 公司內部機器）

```bash
# 用 pm2 讓它常駐、開機自動啟動
npm install -g pm2
pm2 start src/server.js --name groupbuy
pm2 save && pm2 startup
```

前面再擺一台 Nginx 反向代理並申請 Let's Encrypt 憑證：

```nginx
server {
    listen 443 ssl;
    server_name  團購.你的網域.tw;
    ssl_certificate     /etc/letsencrypt/live/你的網域/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的網域/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**上線前務必把 `.env` 的 `NODE_ENV` 改成 `production`** —— Cookie 才會加上 Secure 旗標。

> 一定要用 HTTPS。顧客的姓名、電話、住址走 HTTP 是明文傳輸，同一個 Wi-Fi 下的人就能看到。

---

## 6. 備份與還原

要備份的東西有兩份：資料庫檔 `data/groupbuy.db`，以及商品圖片資料夾 `data/uploads/`。

```bash
npm run backup     # 產生 data/backups/groupbuy-2026-08-31T03-24-00.db，自動保留最近 30 份
```

建議每天排程備份，並**把備份複製到另一台機器或雲端硬碟** —— 備份跟正本放同一顆硬碟，硬碟壞了就一起沒了。

`npm run backup` 只處理資料庫；圖片請一起複製（Linux 範例）：

```bash
tar czf data/backups/uploads-$(date +%F).tar.gz -C data uploads
```

還原：停掉服務 → 把備份檔複製成 `data/groupbuy.db`（圖片解壓回 `data/uploads/`）→ 重新啟動。

```bash
pm2 stop groupbuy
cp data/backups/groupbuy-2026-08-31T03-24-00.db data/groupbuy.db
rm -f data/groupbuy.db-wal data/groupbuy.db-shm
pm2 start groupbuy
```

---

## 7. 安全須知（請務必看）

這套系統會存**顧客的真實姓名、手機、住址**，這些是個資，外洩要負法律責任。程式已內建的防護：

| 風險 | 已做的防護 | 在哪個檔案 |
|---|---|---|
| SQL 注入 | 全部查詢都用預備語句＋參數綁定，沒有任何字串拼接 SQL | `src/db.js`、各 routes |
| XSS（跨站腳本） | 所有輸出經過 `esc()` 轉義；CSP 只允許自家腳本；不使用行內 onclick | `public/*.js`、`src/server.js` |
| 竄改價格 | 金額一律由後端依資料庫價格重算，完全不採信前端傳來的價格 | `src/routes/public.js` |
| 竊取 session | Cookie 設 httpOnly（JS 讀不到）＋ SameSite=Lax ＋ 正式環境 Secure | `src/auth.js` |
| 暴力破解密碼 | 登入 15 分鐘內最多 10 次 | `src/routes/admin.js` |
| 惡意灌單 | 同一 IP 每 10 分鐘最多 10 筆訂單 | `src/server.js` |
| 密碼外洩 | bcrypt 雜湊（cost 12），資料庫裡沒有明碼 | `src/auth.js` |
| 超賣 | 扣庫存用 `WHERE stock >= ?`，同時搶最後一件只會有一人成功 | `src/routes/public.js` |
| CSV 公式注入 | 以 `=`、`+`、`-`、`@` 開頭的欄位前面補單引號 | `src/routes/admin.js` |
| 惡意上傳（把腳本偽裝成圖片） | 只看**檔頭魔術位元組**判斷格式，不信任副檔名與 Content-Type；檔名由伺服器隨機產生；圖片存在 `data/uploads/`（不在網站根目錄底下），只由單一路由供出並加 `nosniff` | `src/uploads.js` |
| 猜別人的訂單 | 查訂單需「編號 + 手機」都對，查不到時訊息一律相同，且同 IP 每 10 分鐘最多 30 次 | `src/routes/public.js`、`src/server.js` |

**你自己要做的：**

- [ ] `.env` 絕對不要提交到 git、不要貼在聊天室、不要傳 email
- [ ] `SESSION_SECRET` 改成隨機字串，不要沿用範例值
- [ ] 管理員密碼至少 12 碼，且不要跟其他網站共用
- [ ] 正式站一定要 HTTPS
- [ ] 定期把不再需要的舊訂單刪掉（個資保存越少風險越低）
- [ ] 匯出的訂單 CSV 含完整個資，不要隨手丟在共用資料夾或轉傳給無關的人
- [ ] 上傳圖片前先確認自己有使用權（別直接抓別人網站的商品照片）；顧客或供應商提供的照片若含人臉，要先取得同意

---

## 8. 串接線上金流

目前是**取貨時付款**，`payment` 功能是關閉的。要接線上支付：

台灣常見選擇是綠界 ECPay 或藍新 NewebPay，流程都一樣：

1. 顧客送出訂單 → 後端建訂單（`pay_status = '未付款'`，這部分已經做好了）
2. 後端用你的 HashKey / HashIV 算出檢查碼，組付款表單
3. 前端把表單 POST 到金流的付款頁，顧客在金流端刷卡
4. 金流**伺服器對伺服器**打你的 `/api/payment/callback` 回報結果
5. 驗過檢查碼、金額也對得上，才把 `pay_status` 改成 `'已付款'`

範例程式碼與註解在 `src/routes/payment.js`，解除註解後補上金流商的檢查碼運算即可。

**三個一定要注意的坑：**

- ❌ 不要相信「瀏覽器導回頁面」帶的成功參數 —— 那個可以偽造。只認第 4 步的伺服器回呼。
- ❌ 不要用回呼帶來的金額直接寫入 —— 要跟資料庫裡的訂單金額比對過才算數。
- ❌ HashKey / HashIV 只能放 `.env`，不可以寫進程式碼、不可以提交到 git。

---

## 9. 改程式：檔案地圖

```
groupbuy-server/
├── .env                    ← 你的設定與密鑰（不進 git）
├── package.json
├── README.md               ← 這份文件
├── data/
│   ├── groupbuy.db         ← 資料庫（就是全部資料）
│   ├── uploads/            ← 後台上傳的商品圖片（要跟資料庫一起備份）
│   └── backups/            ← npm run backup 產生的備份
├── src/
│   ├── server.js           啟動、安全標頭、流量限制、路由掛載
│   ├── sqlite.js           資料庫連線相容層（Node 內建 node:sqlite）
│   ├── db.js               ★ 資料表結構、預設設定、種子資料
│   ├── auth.js             管理員密碼與 session
│   ├── validate.js         輸入驗證工具
│   ├── uploads.js          ★ 商品圖片上傳／驗檔頭／供圖／清孤兒檔
│   ├── routes/
│   │   ├── public.js       ★ 前台 API、下單邏輯、運費計算、查訂單
│   │   ├── admin.js        後台 CRUD、圖片上傳、CSV 匯出
│   │   ├── market.js       行情 API
│   │   └── payment.js      金流（預留）
│   ├── jobs/
│   │   └── marketSync.js   ★ 行情抓取與欄位正規化
│   └── scripts/
│       ├── initAdmin.js    建立／重設管理員
│       ├── syncMarket.js   手動或排程同步行情
│       └── backup.js       備份
├── public/                 前端（純 HTML/CSS/JS，沒有建置步驟）
│   ├── index.html + app.js     前台
│   ├── admin.html + admin.js   後台
│   └── style.css           ★ 全站樣式，改配色從最上面的 CSS 變數開始
└── test/smoke.js           自動測試
```

★ = 最常需要動的檔案

### 幾個常見的修改

**改運費規則** → `src/routes/public.js` 的 `calcFee()`
（前端顯示的預覽在 `public/app.js` 的 `fee()`，兩邊要一起改）

**加一個商品欄位（例如「產地」）**
1. `src/db.js` 的 `CREATE TABLE products` 加欄位
2. `src/routes/admin.js` 的 `productFromBody()` 加驗證
3. `public/admin.js` 的 `render_products()` 加輸入框
4. `public/app.js` 的商品卡加顯示
5. 刪掉 `data/groupbuy.db` 重建（**先備份！**），或手動下 `ALTER TABLE products ADD COLUMN origin TEXT DEFAULT ''`

**改配色** → `public/style.css` 最上面的 `:root` 變數
（主色也可以直接在後台「外觀與文案」改，不用碰程式碼）

**改圖片大小上限或允許的格式** → `src/uploads.js` 的 `MAX_BYTES`、`EXT_MIME`、`sniff()`
（三個地方要一起改：大小、對外 Content-Type、檔頭判斷；前端的縮圖尺寸在 `public/admin.js` 的 `shrinkImage()`）

**把資料庫或圖片放到別的位置** → 啟動時設環境變數 `GB_DB_FILE`、`GB_UPLOAD_DIR`
（`npm run smoke` 就是用這兩個變數跑在暫存目錄，完全不會動到正式資料）

---

## 10. 常見問題排查

**Windows PowerShell 說「因為這個系統上已停用指令碼執行，所以無法載入 npm.ps1」**
PowerShell 預設不准跑指令碼。最簡單的解法是改用 `.cmd` 版本，不必更動任何系統設定：

```powershell
npm.cmd install
npm.cmd start
```

或改用「命令提示字元」（`Win + R` → `cmd`）執行原本的 `npm install`。
（也可以用 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 放寬原則，但那是修改系統安全設定，
公司電腦通常由 IT 以群組原則管理，動之前請先確認你有權限。）

**`npm install` 失敗，訊息裡有 `node-gyp` / `find-visualstudio` / `MSBuild`**
表示某個套件要編譯原生模組但找不到 Visual Studio。本專案已改用 Node 內建的 `node:sqlite`，
正常不會發生。若你是從舊版升級上來，先刪掉 `node_modules` 與 `package-lock.json` 再重裝：

```powershell
rmdir /s /q node_modules
del package-lock.json
npm.cmd install
```

**啟動時 `Error: Cannot find module 'dotenv'`（或其他套件名）**
`npm install` 還沒跑，或跑到一半失敗了。先確認目前目錄看得到 `package.json`（用 `dir` 檢查），再重跑 `npm.cmd install`。

**啟動時出現 `ExperimentalWarning: SQLite is an experimental feature`**
這只是提示，不是錯誤，可以忽略。若不想看到，啟動改成 `node --no-warnings src/server.js`。

**啟動時 `EADDRINUSE: address already in use :::3000`**
3000 埠已經有程式在用。改 `.env` 的 `PORT`，或關掉舊的程序（`pm2 list` / 工作管理員）。

**後台一直跳回登入畫面**
session 過期（8 小時）是正常的。若是重複發生，檢查是不是 `NODE_ENV=production` 但網站走 HTTP —— Secure Cookie 在 HTTP 下不會被送出，改用 HTTPS 或開發時把 `NODE_ENV` 設回 `development`。

**忘記管理員密碼**
```bash
npm run init-admin -- 你的email 新密碼至少十碼
```

**行情同步回 0 筆**
先確認不是假日休市。若平日也是 0，見第 4 節「一定要驗證欄位」。

**顧客說「加入團購」按不下去**
可能是已截止（後台改截止時間）、可售數量歸零（後台補數量）、或未達最低訂單金額（購物車底部會寫還差多少）。

**上傳商品圖片失敗**
- 「只接受 JPG／PNG／WebP／GIF 圖片檔」：檔案不是真的圖片（例如是 HEIC 或改過副檔名的檔案）。
  iPhone 拍的 HEIC 請在「設定 → 相機 → 格式」改成「相容性最佳」，或先轉成 JPG。
- 「上傳內容過大」：單張上限 4MB。瀏覽器本來會自動縮圖，若用很舊的瀏覽器會跳過縮圖，換 Chrome／Edge／Safari 新版即可。
- 「登入已過期」：後台 session 8 小時就過期，重新登入再上傳。

**前台商品圖變成破圖**
圖片檔在主機的 `data/uploads/`。換機器或還原備份時只搬了資料庫、沒搬這個資料夾就會這樣（見第 6 節）。
確認資料夾存在且服務有讀取權限；若圖真的不見了，重新上傳一次即可。

**CSV 用 Excel 開是亂碼**
檔案已加 UTF-8 BOM，正常應該不會。若還是亂碼，用 Excel 的「資料 → 從文字/CSV」匯入並選 UTF-8。

**部署後訂單消失**
雲端平台沒掛持久磁碟，容器重啟資料就沒了。見第 5 節選項 A 第 4 步。

**想讓兩個人同時管後台**
`npm run init-admin -- 同事email 密碼` 再建一個帳號即可，兩人各自登入。

---

## 授權與資料來源

- 行情資料：農業部農業資料開放平臺，使用前請確認其開放資料授權條款
- 本專案程式碼可自由修改使用
