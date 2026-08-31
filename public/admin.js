/* =============================================================================
   管理後台
   -----------------------------------------------------------------------------
   所有動作都打 /api/admin/*，伺服器會用 Cookie 裡的 session 驗身分；
   沒登入就會收到 401，這裡自動跳回登入畫面。
   同樣不使用行內 onclick（CSP 會擋），一律事件委派。
   ============================================================================= */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const nt = (n) => 'NT$' + Number(n || 0).toLocaleString('zh-TW');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

async function api(url, opts = {}) {
  const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const data = await res.json().catch(() => ({}));
  // 登入端點的 401 代表「帳密錯誤」，要把原訊息顯示給使用者；
  // 其他端點的 401 才代表 session 過期，這時把畫面切回登入。
  if (res.status === 401 && !url.endsWith('/login')) {
    Admin.showLogin();
    throw new Error(data.error || '登入已過期，請重新登入');
  }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* -----------------------------------------------------------------------------
   商品圖片上傳
   -------------------------------------------------------------------------- */

/**
 * 上傳前先在瀏覽器裡縮圖。
 * 手機拍的照片動輒 4～8MB，縮到最長邊 1200px 再轉 WebP，通常只剩幾十 KB，
 * 省伺服器空間、顧客載入也快。轉檔失敗（舊瀏覽器）就退回原檔，後端一樣會把關。
 * GIF 不處理，否則動畫會被壓成一張靜態圖。
 */
async function shrinkImage(file, max = 1200) {
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= 600 * 1024) return file;      // 本來就夠小就別重壓
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.85));
    if (bmp.close) bmp.close();
    return (blob && blob.size > 0 && blob.size < file.size) ? blob : file;
  } catch { return file; }
}

/** 把圖片檔直接當成 request body POST 出去，回傳伺服器給的網址 /uploads/xxxx.webp */
async function uploadImage(file) {
  if (!file) return null;
  if (file.size > 12 * 1024 * 1024) throw new Error('原始檔案超過 12MB，請先壓縮再上傳');
  const blob = await shrinkImage(file);
  const res = await fetch('/api/admin/uploads', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { Admin.showLogin(); throw new Error('登入已過期，請重新登入'); }
  if (!res.ok) throw new Error(data.error || ('上傳失敗（HTTP ' + res.status + '）'));
  return data.url;
}

const Admin = {
  panel: 'dash',
  data: {},

  async boot() {
    try { await api('/api/admin/me'); this.showMain(); }
    catch { this.showLogin(); }
  },
  showLogin() { $('loginBox').classList.remove('hidden'); $('adminMain').classList.add('hidden'); $('logoutBtn').classList.add('hidden'); },
  showMain()  { $('loginBox').classList.add('hidden');  $('adminMain').classList.remove('hidden'); $('logoutBtn').classList.remove('hidden'); this.go(this.panel); },

  async login() {
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: $('liEmail').value, password: $('liPass').value }) });
      $('liPass').value = '';
      this.showMain();
    } catch (e) { toast(e.message); }
  },
  async logout() { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); this.showLogin(); },

  async go(p) {
    this.panel = p;
    document.querySelectorAll('#adminNav button').forEach(b => b.setAttribute('aria-selected', b.dataset.p === p));
    $('panel').innerHTML = '<p class="muted">載入中…</p>';
    try { await this['render_' + p](); }
    catch (e) { $('panel').innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  },

  /* ---------- 訂單與彙總 ---------- */
  async render_dash() {
    const d = await api('/api/admin/dashboard');
    const o = await api('/api/admin/orders');
    this.data.orders = o.orders;
    const k = d.kpi, pr = d.progress;
    const purchase = d.purchase;

    $('panel').innerHTML = `
      <div class="kpi-grid">
        <div class="card kpi"><b>${k.orders}</b><span>訂單筆數</span></div>
        <div class="card kpi"><b>${nt(k.subtotal)}</b><span>商品金額</span></div>
        <div class="card kpi"><b>${nt(k.total)}</b><span>含運應收</span></div>
        <div class="card kpi"><b>${k.buyers}</b><span>下單人數</span></div>
        <div class="card kpi"><b style="color:${pr.reached ? 'var(--ok)' : 'var(--accent)'}">${pr.reached ? '已成團' : pr.pct + '%'}</b><span>成團進度</span></div>
      </div>

      <div class="card panel" style="margin-bottom:16px">
        <h3 class="sub">📦 本期採購彙總（叫貨單）</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>商品</th><th class="num">總需求量</th><th>單位</th><th class="num">單價</th><th class="num">金額</th></tr></thead>
          <tbody>${purchase.map(r => `<tr><td>${esc(r.name)}</td><td class="num"><b>${r.qty}</b></td>
            <td>${esc(r.unit)}</td><td class="num">${nt(r.price)}</td><td class="num">${nt(r.amount)}</td></tr>`).join('')
            || '<tr><td class="muted">目前沒有訂單。</td></tr>'}
            ${purchase.length ? `<tr class="total-row"><td>合計</td><td class="num">${purchase.reduce((s,r)=>s+r.qty,0)}</td><td></td><td></td><td class="num">${nt(purchase.reduce((s,r)=>s+r.amount,0))}</td></tr>` : ''}
          </tbody></table></div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn sm" href="/api/admin/purchase.csv">下載叫貨單 CSV</a>
          <a class="btn sm ghost" href="/api/admin/orders.csv">下載訂單 CSV</a>
        </div>
      </div>

      <div class="card panel">
        <h3 class="sub">🧾 訂單明細</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>訂單</th><th>時間</th><th>姓名</th><th>電話</th><th>取貨</th><th>品項</th>
            <th class="num">金額</th><th>訂單狀態</th><th>付款</th><th></th></tr></thead>
          <tbody>${this.data.orders.map(o => `<tr>
            <td><b>${esc(o.code)}</b></td>
            <td class="muted">${esc(o.created_at)}</td>
            <td>${esc(o.buyer_name)}</td><td>${esc(o.buyer_phone)}</td>
            <td>${o.method === 'pickup' ? esc(o.pickup_name || '自取') : '宅配・' + esc(o.address)}</td>
            <td>${esc(o.items.map(i => `${i.name}×${i.qty}`).join('、'))}</td>
            <td class="num">${nt(o.total)}</td>
            <td><select class="input" style="padding:4px 6px;font-size:12px" data-ostatus="${o.id}">
              ${['待處理','已備貨','已取貨','已取消'].map(s => `<option ${o.status===s?'selected':''}>${s}</option>`).join('')}
            </select></td>
            <td><select class="input" style="padding:4px 6px;font-size:12px" data-opay="${o.id}">
              ${['未付款','已付款','已退款'].map(s => `<option ${o.pay_status===s?'selected':''}>${s}</option>`).join('')}
            </select></td>
            <td><button class="btn sm danger" data-odel="${o.id}">刪</button></td>
          </tr>`).join('') || '<tr><td class="muted">目前沒有訂單。</td></tr>'}</tbody>
        </table></div>
      </div>`;
  },

  /* ---------- 商品 ---------- */

  /** 縮圖 HTML：上傳圖或外部網址畫成 <img>，其餘一律當成 emoji 文字顯示 */
  thumbHtml(v) {
    const t = String(v == null ? '' : v).trim();
    return /^(\/uploads\/|https?:\/\/)/i.test(t)
      ? `<img src="${esc(t)}" alt="">`
      : `<span>${esc(t || '🥬')}</span>`;
  },

  async render_products() {
    const { products } = await api('/api/admin/products');
    this.data.products = products;
    $('panel').innerHTML = `
      <div class="card panel" style="margin-bottom:16px">
        <h3 class="sub">新增商品</h3>

        <div class="img-picker">
          <div class="thumb-box" id="npPreview">${this.thumbHtml('🥬')}</div>
          <div style="flex:1;min-width:220px">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <label class="btn sm file-btn">📷 上傳圖片
                <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" id="npFile" hidden></label>
              <button class="btn sm ghost" data-act="clearNewImg">清除</button>
            </div>
            <label class="field" style="margin:8px 0 0"><span>或直接填 emoji／圖片網址</span>
              <input class="input" id="npImage" placeholder="🥬，或貼上 https://… 圖片網址"></label>
            <p class="hint">支援 JPG／PNG／WebP／GIF，單張上限 4MB；上傳前會自動縮到 1200px 以內。</p>
          </div>
        </div>

        <div class="row">
          <label class="field"><span>品名 *</span><input class="input" id="npName"></label>
          <label class="field"><span>分類</span><input class="input" id="npCat" placeholder="蔬菜"></label>
          <label class="field"><span>單位</span><input class="input" id="npUnit" placeholder="顆"></label>
        </div>
        <div class="row">
          <label class="field"><span>團購價</span><input class="input" type="number" min="0" id="npPrice"></label>
          <label class="field"><span>市價</span><input class="input" type="number" min="0" id="npMarket"></label>
          <label class="field"><span>可售數量</span><input class="input" type="number" min="0" id="npStock"></label>
          <label class="field"><span>排序 <span class="hint">(小的排前面)</span></span><input class="input" type="number" min="0" id="npSort"></label>
          <label class="field"><span>行情關鍵字</span><input class="input" id="npKey" placeholder="甘藍"></label>
        </div>
        <button class="btn" data-act="addProduct">新增到本期</button>
      </div>

      <div class="card panel">
        <h3 class="sub">商品清單 <span class="muted">（共 ${products.length} 項）</span></h3>
        <p class="muted" style="margin-top:-6px">改完欄位後按該列的「存」；按「換圖」選好檔案會直接上傳並儲存。</p>
        ${products.map(p => `<div class="list-row" data-pid="${p.id}">
          <div class="lr-img">
            <div class="thumb-box" data-thumb="${p.id}">${this.thumbHtml(p.image)}</div>
            <label class="mini-file">換圖
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upimg="${p.id}" hidden></label>
          </div>
          <div class="lr-main">
            <input class="input" data-f="name" value="${esc(p.name)}" style="font-weight:700;margin-bottom:5px">
            <div class="row" style="gap:6px">
              <input class="input" data-f="category" value="${esc(p.category)}" placeholder="分類" style="flex:1 1 70px">
              <input class="input" data-f="unit" value="${esc(p.unit)}" placeholder="單位" style="flex:1 1 60px">
              <input class="input" data-f="image" value="${esc(p.image)}" placeholder="圖示/網址" style="flex:2 1 150px">
              <input class="input" data-f="market_key" value="${esc(p.market_key)}" placeholder="行情關鍵字" style="flex:1 1 90px">
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <label style="font-size:11px;color:var(--ink-3)">團購價<input class="input" type="number" min="0" data-f="price" value="${p.price}" style="width:76px"></label>
            <label style="font-size:11px;color:var(--ink-3)">市價<input class="input" type="number" min="0" data-f="market_price" value="${p.market_price}" style="width:76px"></label>
            <label style="font-size:11px;color:var(--ink-3)">數量<input class="input" type="number" min="0" data-f="stock" value="${p.stock}" style="width:68px"></label>
            <label style="font-size:11px;color:var(--ink-3)">排序<input class="input" type="number" min="0" data-f="sort_order" value="${p.sort_order}" style="width:60px"></label>
            <label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''}>上架</label>
            <button class="btn sm" data-psave="${p.id}">存</button>
            <button class="btn sm danger" data-pdel="${p.id}">刪</button>
          </div>
        </div>`).join('') || '<p class="muted">還沒有商品，用上面的表單新增第一項吧。</p>'}
      </div>`;
  },

  /* ---------- 成團規則 ---------- */
  async render_rules() {
    const s = await api('/api/admin/settings');
    const r = s.rules;
    $('panel').innerHTML = `
      <div class="card panel">
        <h3 class="sub">本期團購檔次</h3>
        <div class="row">
          <label class="field"><span>檔次名稱</span><input class="input" id="rTitle" value="${esc(r.title)}"></label>
          <label class="field"><span>截止時間 <span class="hint">(留空 = 不設)</span></span>
            <input class="input" type="datetime-local" id="rDeadline" value="${esc((r.deadline || '').slice(0, 16))}"></label>
        </div>
        <div class="row">
          <label class="field"><span>成團門檻類型</span><select class="input" id="rType">
            <option value="amount" ${r.thresholdType === 'amount' ? 'selected' : ''}>累計金額</option>
            <option value="orders" ${r.thresholdType === 'orders' ? 'selected' : ''}>下單筆數</option>
          </select></label>
          <label class="field"><span>門檻值</span><input class="input" type="number" min="0" id="rThreshold" value="${r.threshold}"></label>
          <label class="field"><span>每人單品限購 <span class="hint">(0=不限)</span></span><input class="input" type="number" min="0" id="rPerLimit" value="${r.perLimit}"></label>
          <label class="field"><span>最低訂單金額</span><input class="input" type="number" min="0" id="rMinOrder" value="${r.minOrder}"></label>
        </div>
        <label class="field"><span>開團週期提示</span><input class="input" id="rCycle" value="${esc(r.cycle)}"></label>
        <label class="field"><span>成團說明</span><textarea class="input" id="rNote">${esc(r.successNote)}</textarea></label>
        <button class="btn" data-act="saveRules">儲存成團規則</button>
      </div>`;
  },

  /* ---------- 取貨與運費 ---------- */
  async render_logi() {
    const s = await api('/api/admin/settings');
    const { pickups } = await api('/api/admin/pickups');
    const D = s.delivery;
    $('panel').innerHTML = `
      <div class="card panel" style="margin-bottom:16px">
        <h3 class="sub">自取地點</h3>
        <div class="row">
          <label class="field"><span>名稱 *</span><input class="input" id="pkName"></label>
          <label class="field"><span>地址</span><input class="input" id="pkAddr"></label>
          <label class="field"><span>時段</span><input class="input" id="pkHours" placeholder="週三 17:00–20:00"></label>
        </div>
        <button class="btn sm" data-act="addPickup">新增取貨點</button>
        <div style="margin-top:14px">${pickups.map(p => `<div class="list-row" data-kid="${p.id}">
          <div class="lr-main">
            <input class="input" data-f="name" value="${esc(p.name)}" style="font-weight:700;margin-bottom:5px">
            <div class="row" style="gap:6px">
              <input class="input" data-f="address" value="${esc(p.address)}" placeholder="地址">
              <input class="input" data-f="hours" value="${esc(p.hours)}" placeholder="時段" style="flex:0 1 160px">
            </div>
          </div>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''}>啟用</label>
          <button class="btn sm" data-ksave="${p.id}">存</button>
          <button class="btn sm danger" data-kdel="${p.id}">停用</button>
        </div>`).join('') || '<p class="muted">尚未設定取貨點。</p>'}</div>
      </div>
      <div class="card panel">
        <h3 class="sub">宅配與運費</h3>
        <label class="field" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="dEnabled" ${Number(D.enabled) ? 'checked' : ''}><span style="margin:0">開放宅配到府</span></label>
        <div class="row">
          <label class="field"><span>基本運費</span><input class="input" type="number" min="0" id="dFee" value="${D.fee}"></label>
          <label class="field"><span>免運門檻 <span class="hint">(0=不免運)</span></span><input class="input" type="number" min="0" id="dFreeOver" value="${D.freeOver}"></label>
          <label class="field"><span>自取手續費</span><input class="input" type="number" min="0" id="dPickupFee" value="${D.pickupFee}"></label>
        </div>
        <label class="field"><span>可配送區域 <span class="hint">(逗號分隔)</span></span>
          <input class="input" id="dAreas" value="${esc((D.areas || []).join(', '))}"></label>
        <button class="btn" data-act="saveLogi">儲存物流設定</button>
      </div>`;
  },

  /* ---------- 外觀 ---------- */
  async render_look() {
    const s = await api('/api/admin/settings');
    const L = s.look;
    $('panel').innerHTML = `
      <div class="card panel">
        <h3 class="sub">品牌與文案</h3>
        <div class="row">
          <label class="field"><span>平台名稱</span><input class="input" id="lName" value="${esc(L.name)}"></label>
          <label class="field"><span>Logo 文字</span><input class="input" id="lMark" maxlength="2" value="${esc(L.mark)}"></label>
          <label class="field"><span>主色</span><input class="input" type="color" id="lBrand" value="${esc(L.brand)}" style="height:38px;padding:3px"></label>
        </div>
        <label class="field"><span>首頁標語</span><input class="input" id="lTagline" value="${esc(L.tagline)}"></label>
        <label class="field"><span>公告</span><textarea class="input" id="lAnnounce">${esc(L.announce)}</textarea></label>
        <button class="btn" data-act="saveLook">儲存並套用</button>
      </div>`;
  },

  /* ---------- 行情 ---------- */
  async render_market() {
    const s = await api('/api/admin/settings');
    const m = await api('/api/admin/market/latest');
    const M = s.market;
    $('panel').innerHTML = `
      <div class="card panel" style="margin-bottom:16px">
        <h3 class="sub">農業部農產品行情</h3>
        <p class="muted" style="margin-top:-6px">
          由伺服器向農業部抓取後存進資料庫，前台只讀自家資料（不會有 CORS 問題，也不會每個訪客都去打官方 API）。
          建議用系統排程每天跑一次 <code>npm run sync-market</code>。
        </p>
        <div class="row">
          <label class="field"><span>對照批發市場</span><input class="input" id="mName" value="${esc(M.marketName)}" placeholder="台北一"></label>
          <label class="field"><span>價格基準</span><select class="input" id="mBasis">
            <option value="avg"   ${M.basis === 'avg'   ? 'selected' : ''}>平均價</option>
            <option value="upper" ${M.basis === 'upper' ? 'selected' : ''}>上價</option>
            <option value="lower" ${M.basis === 'lower' ? 'selected' : ''}>下價</option>
          </select></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" data-act="saveMarket">儲存設定</button>
          <button class="btn sm ghost" data-act="syncMarket">立刻同步行情</button>
          <button class="btn sm ghost" data-act="applyMarket">套用到商品市價</button>
        </div>
        <p class="muted" style="margin-top:10px">
          上次同步：${M.lastSync ? esc(new Date(M.lastSync).toLocaleString('zh-TW')) : '尚未同步'}
          ・資料庫現有 ${m.count} 筆行情
        </p>
        <div id="mStatus"></div>
      </div>
      <div class="card panel">
        <h3 class="sub">最新行情（每個作物取最近一天）</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>日期</th><th>作物</th><th>市場</th><th class="num">上價</th><th class="num">中價</th><th class="num">下價</th><th class="num">平均價</th></tr></thead>
          <tbody>${m.rows.slice(0, 200).map(r => `<tr>
            <td class="muted">${esc(r.trans_date)}</td><td>${esc(r.crop_name)}</td><td>${esc(r.market_name)}</td>
            <td class="num">${r.upper_price}</td><td class="num">${r.mid_price}</td>
            <td class="num">${r.lower_price}</td><td class="num"><b>${r.avg_price}</b></td>
          </tr>`).join('') || '<tr><td class="muted">尚無行情資料，請按「立刻同步行情」。</td></tr>'}</tbody>
        </table></div>
      </div>`;
  },

  /* ---------- 帳號與備份 ---------- */
  async render_account() {
    $('panel').innerHTML = `
      <div class="card panel" style="margin-bottom:16px">
        <h3 class="sub">更改密碼</h3>
        <div class="row">
          <label class="field"><span>目前密碼</span><input class="input" type="password" id="pwCur" autocomplete="current-password"></label>
          <label class="field"><span>新密碼 <span class="hint">(至少 10 碼)</span></span><input class="input" type="password" id="pwNew" autocomplete="new-password"></label>
        </div>
        <button class="btn" data-act="changePw">更改密碼</button>
        <p class="muted">改完後所有裝置都需重新登入。</p>
      </div>
      <div class="card panel">
        <h3 class="sub">資料備份</h3>
        <p class="muted" style="margin-top:-6px">
          資料庫是一個檔案：<code>data/groupbuy.db</code>。在伺服器上執行
          <code>npm run backup</code> 會在 <code>data/backups/</code> 產生帶時間戳的完整備份（自動保留最近 30 份）。
          建議設每日排程，並定期把備份複製到另一台機器或雲端硬碟。
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <a class="btn sm ghost" href="/api/admin/orders.csv">下載訂單 CSV</a>
          <a class="btn sm ghost" href="/api/admin/purchase.csv">下載叫貨單 CSV</a>
        </div>
      </div>`;
  },

  /* ---------- 動作 ---------- */
  async act(name, el) {
    const g = (id) => { const e = $(id); return e ? e.value.trim() : ''; };
    const gn = (id) => { const e = $(id); return e ? Number(e.value) : 0; };
    try {
      switch (name) {
        case 'addProduct':
          if (!g('npName')) return toast('請填品名');
          await api('/api/admin/products', { method: 'POST', body: JSON.stringify({
            name: g('npName'), image: g('npImage') || '🥬', category: g('npCat') || '其他',
            unit: g('npUnit') || '份', price: gn('npPrice'), market_price: gn('npMarket'),
            stock: gn('npStock'), sort_order: gn('npSort'),
            market_key: g('npKey') || g('npName'), active: 1 }) });
          toast('已新增'); return this.go('products');

        case 'clearNewImg':
          $('npImage').value = '';
          $('npFile').value = '';
          $('npPreview').innerHTML = this.thumbHtml('🥬');
          return;

        case 'saveRules':
          await api('/api/admin/settings/rules', { method: 'PUT', body: JSON.stringify({
            title: g('rTitle'), deadline: g('rDeadline'), thresholdType: g('rType'),
            threshold: gn('rThreshold'), perLimit: gn('rPerLimit'), minOrder: gn('rMinOrder'),
            cycle: g('rCycle'), successNote: g('rNote') }) });
          return toast('成團規則已更新');

        case 'addPickup':
          if (!g('pkName')) return toast('請填地點名稱');
          await api('/api/admin/pickups', { method: 'POST', body: JSON.stringify({
            name: g('pkName'), address: g('pkAddr'), hours: g('pkHours'), active: 1 }) });
          toast('已新增取貨點'); return this.go('logi');

        case 'saveLogi':
          await api('/api/admin/settings/delivery', { method: 'PUT', body: JSON.stringify({
            enabled: $('dEnabled').checked, fee: gn('dFee'), freeOver: gn('dFreeOver'),
            pickupFee: gn('dPickupFee'), areas: g('dAreas') }) });
          return toast('物流設定已更新');

        case 'saveLook':
          await api('/api/admin/settings/look', { method: 'PUT', body: JSON.stringify({
            name: g('lName'), mark: g('lMark'), brand: g('lBrand'),
            tagline: g('lTagline'), announce: g('lAnnounce') }) });
          return toast('外觀已更新，前台重新整理即可看到');

        case 'saveMarket':
          await api('/api/admin/settings/market', { method: 'PUT', body: JSON.stringify({
            marketName: g('mName'), basis: g('mBasis') }) });
          return toast('行情設定已儲存');

        case 'syncMarket': {
          el.disabled = true; el.textContent = '同步中…';
          $('mStatus').innerHTML = '';
          try {
            const r = await api('/api/admin/market/sync', { method: 'POST', body: JSON.stringify({ days: 3 }) });
            $('mStatus').innerHTML = `<div class="notice" style="background:#eaf4ea;border-color:#c9e0c9;color:#1f5c22">✅ 已同步 ${r.fetched} 筆行情。</div>`;
            setTimeout(() => this.go('market'), 800);
          } catch (e) {
            $('mStatus').innerHTML = `<div class="notice">⚠️ ${esc(e.message)}</div>`;
          }
          el.disabled = false; el.textContent = '立刻同步行情';
          return;
        }

        case 'applyMarket': {
          const r = await api('/api/admin/market/apply', { method: 'POST' });
          toast(r.updated ? `已更新 ${r.updated}/${r.total} 項商品市價` : '沒有商品對應到行情，請調整「行情關鍵字」');
          return this.go('market');
        }

        case 'changePw':
          if (g('pwNew').length < 10) return toast('新密碼至少 10 碼');
          await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: g('pwCur'), next: g('pwNew') }) });
          toast('密碼已更新，請重新登入');
          return setTimeout(() => this.showLogin(), 1200);
      }
    } catch (e) { toast(e.message); }
  },

  /** 從一列 .list-row 收集 data-f 欄位 */
  rowData(row) {
    const out = {};
    row.querySelectorAll('[data-f]').forEach(el => {
      out[el.dataset.f] = el.type === 'checkbox' ? (el.checked ? 1 : 0)
                        : el.type === 'number' ? Number(el.value) : el.value;
    });
    return out;
  }
};

/* ---------- 事件委派 ---------- */
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button,[data-p]');
  if (!t) return;

  if (t.dataset.p) return Admin.go(t.dataset.p);
  if (t.dataset.act) return Admin.act(t.dataset.act, t);

  try {
    if (t.dataset.psave) {
      const row = t.closest('.list-row');
      await api('/api/admin/products/' + t.dataset.psave, { method: 'PUT', body: JSON.stringify(Admin.rowData(row)) });
      return toast('已儲存');
    }
    if (t.dataset.pdel) {
      if (!confirm('確定刪除這個商品？既有訂單不受影響。')) return;
      await api('/api/admin/products/' + t.dataset.pdel, { method: 'DELETE' });
      toast('已刪除'); return Admin.go('products');
    }
    if (t.dataset.ksave) {
      const row = t.closest('.list-row');
      await api('/api/admin/pickups/' + t.dataset.ksave, { method: 'PUT', body: JSON.stringify(Admin.rowData(row)) });
      return toast('已儲存');
    }
    if (t.dataset.kdel) {
      if (!confirm('停用這個取貨點？舊訂單仍會保留紀錄。')) return;
      await api('/api/admin/pickups/' + t.dataset.kdel, { method: 'DELETE' });
      toast('已停用'); return Admin.go('logi');
    }
    if (t.dataset.odel) {
      if (!confirm('確定刪除這筆訂單？庫存會自動加回。此動作無法復原。')) return;
      await api('/api/admin/orders/' + t.dataset.odel, { method: 'DELETE' });
      toast('已刪除'); return Admin.go('dash');
    }
  } catch (e) { toast(e.message); }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  try {
    // 新增商品區塊的圖片：上傳後只填進欄位，等按「新增到本期」才真的建立商品
    if (el.id === 'npFile') {
      const f = el.files && el.files[0];
      if (!f) return;
      toast('上傳中…');
      const url = await uploadImage(f);
      $('npImage').value = url;
      $('npPreview').innerHTML = Admin.thumbHtml(url);
      el.value = '';
      return toast('圖片已上傳，按「新增到本期」即可套用');
    }
    // 清單裡某一列的「換圖」：上傳完直接連同該列其他欄位一起存檔
    if (el.dataset.upimg) {
      const f = el.files && el.files[0];
      if (!f) return;
      const row = el.closest('.list-row');
      toast('上傳中…');
      const url = await uploadImage(f);
      row.querySelector('[data-f="image"]').value = url;
      row.querySelector('[data-thumb]').innerHTML = Admin.thumbHtml(url);
      el.value = '';
      await api('/api/admin/products/' + el.dataset.upimg,
        { method: 'PUT', body: JSON.stringify(Admin.rowData(row)) });
      return toast('圖片已更新');
    }
    if (el.dataset.ostatus) {
      await api('/api/admin/orders/' + el.dataset.ostatus, { method: 'PATCH', body: JSON.stringify({ status: el.value }) });
      return toast('狀態已更新');
    }
    if (el.dataset.opay) {
      await api('/api/admin/orders/' + el.dataset.opay, { method: 'PATCH', body: JSON.stringify({ pay_status: el.value }) });
      return toast('付款狀態已更新');
    }
  } catch (e) { toast(e.message); }
});

/* 手動貼上網址或改 emoji 時，縮圖跟著即時更新 */
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.id === 'npImage') { $('npPreview').innerHTML = Admin.thumbHtml(el.value); return; }
  if (el.dataset && el.dataset.f === 'image') {
    const box = el.closest('.list-row')?.querySelector('[data-thumb]');
    if (box) box.innerHTML = Admin.thumbHtml(el.value);
  }
});

$('loginBtn').addEventListener('click', () => Admin.login());
$('liPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') Admin.login(); });
$('logoutBtn').addEventListener('click', () => Admin.logout());

Admin.boot();
