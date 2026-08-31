/* =============================================================================
   前台 —— 商品瀏覽、購物車、結帳
   -----------------------------------------------------------------------------
   資料全部來自後端 /api/config，價格與運費最後也由後端重算，
   這裡的計算只是給顧客看的即時預覽。
   注意：本檔案不使用行內 onclick（會被 CSP 擋掉），一律用事件委派。
   ============================================================================= */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const nt = (n) => 'NT$' + Number(n || 0).toLocaleString('zh-TW');
/** 只有這三種來源會被當成圖片網址：站內上傳圖、http(s) 外部圖、data:image；其餘一律當 emoji */
const safeImg = (u) => /^(\/uploads\/|https?:\/\/|data:image\/)/i.test(String(u || '').trim())
  ? String(u).trim() : '';

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

async function api(url, opts) {
  const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

const Shop = {
  cfg: null,
  cart: {},          // { productId: qty }
  cat: '全部',
  q: '',             // 搜尋關鍵字
  lookup: null,      // 查詢到的訂單
  mode: 'cart',      // cart | checkout | done
  done: null,

  async load() {
    try {
      this.cfg = await api('/api/config');
    } catch (e) {
      document.querySelector('main').innerHTML =
        `<div class="notice" style="margin-top:24px">無法連上伺服器：${esc(e.message)}</div>`;
      return;
    }
    this.applyLook();
    this.render();
    setInterval(() => this.tick(), 1000);
  },

  applyLook() {
    const L = this.cfg.look;
    document.documentElement.style.setProperty('--brand', L.brand);
    document.documentElement.style.setProperty('--brand-dark', shade(L.brand, -22));
    document.documentElement.style.setProperty('--brand-soft', shade(L.brand, 88));
    $('logoText').textContent = L.name;
    $('logoMark').textContent = L.mark || L.name.slice(0, 1);
    document.title = L.name + ' · 社區團購';
  },

  product(id) { return this.cfg.products.find(p => p.id === id); },

  render() {
    const { look, rules, products, market } = this.cfg;
    $('heroTitle').textContent = rules.title;
    $('heroTagline').textContent = look.tagline;
    $('announceBox').innerHTML = look.announce
      ? `<div class="notice" style="margin-top:4px">📢 ${esc(look.announce)}</div>` : '';

    const cats = ['全部', ...new Set(products.map(p => p.category || '其他'))];
    if (!cats.includes(this.cat)) this.cat = '全部';
    $('catBar').innerHTML = cats.map(c =>
      `<button class="chip" data-cat="${esc(c)}" aria-pressed="${c === this.cat}">${esc(c)}</button>`).join('');

    const kw = this.q.trim().toLowerCase();
    const list = products.filter(p =>
      (this.cat === '全部' || (p.category || '其他') === this.cat) &&
      (!kw || p.name.toLowerCase().includes(kw) || (p.category || '').toLowerCase().includes(kw)));
    const closed = this.cfg.closed;
    const limit = Number(rules.perLimit) || 0;

    $('productGrid').innerHTML = list.map(p => {
      const q = this.cart[p.id] || 0;
      const img = safeImg(p.image);
      const thumb = img ? `<img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy">` : esc(p.image || '🥬');
      const save = p.market_price > p.price
        ? `<span class="mkt">${nt(p.market_price)}</span><span class="save">省 ${Math.round((1 - p.price / p.market_price) * 100)}%</span>` : '';
      const soldOut = p.stock <= 0;
      const maxQ = Math.min(p.stock, limit > 0 ? limit : Infinity);
      return `<article class="card prod">
        <div class="thumb">${thumb}</div>
        <div class="name">${esc(p.name)}</div>
        <div class="price-line"><span class="price">${nt(p.price)}<small> /${esc(p.unit)}</small></span>${save}</div>
        <div class="muted">${soldOut ? '<span class="pill red">已售完</span>' : `剩 ${p.stock} ${esc(p.unit)}`}</div>
        <div class="prod-foot">
          ${(soldOut || closed)
            ? `<button class="btn sm" disabled>${closed ? '已截止' : '售完'}</button>`
            : q > 0
              ? `<div class="qty">
                   <button data-qty="${p.id}" data-to="${q - 1}">−</button><span>${q}</span>
                   <button data-qty="${p.id}" data-to="${q + 1}" ${q >= maxQ ? 'disabled' : ''}>＋</button>
                 </div>`
              : `<button class="btn sm" data-qty="${p.id}" data-to="1">加入團購</button>`}
        </div>
      </article>`;
    }).join('') || `<p class="muted">${kw ? '找不到符合「' + esc(this.q) + '」的商品。' : '這個分類目前沒有商品。'}</p>`;

    $('priceSourceNote').textContent = market.lastSync
      ? `市價參考：農業部農產品交易行情（${market.marketName}），更新於 ${new Date(market.lastSync).toLocaleString('zh-TW')}`
      : '市價為團主自行維護之參考價。';

    this.renderCart();
    this.tick();
  },

  tick() {
    if (!this.cfg) return;
    const { rules, progress } = this.cfg;
    let text = '—', over = false;
    if (rules.deadline) {
      const ms = new Date(rules.deadline).getTime() - Date.now();
      if (!isFinite(ms)) text = '—';
      else if (ms <= 0) { text = '已截止'; over = true; }
      else {
        const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24,
              m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
        text = d > 0 ? `${d}天 ${h}時` : `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      }
    } else text = '不限';
    $('statDeadline').textContent = text;
    $('statJoined').textContent = progress.orders;
    $('statAmount').textContent = nt(progress.amount);
    $('statStatus').textContent = over ? (progress.reached ? '已成團・已截止' : '未成團・已截止')
                                       : (progress.reached ? '已成團 ✅' : '募集中');
    $('progressBar').style.width = progress.pct + '%';
    $('progressText').textContent = rules.thresholdType === 'orders'
      ? `已有 ${progress.orders} 筆訂單，滿 ${rules.threshold} 筆成團（${progress.pct}%）`
      : `已累計 ${nt(progress.amount)}，滿 ${nt(rules.threshold)} 成團（${progress.pct}%）`;
  },

  setQty(id, qty) {
    const p = this.product(id); if (!p) return;
    const limit = Number(this.cfg.rules.perLimit) || 0;
    let q = Math.max(0, Math.floor(qty));
    if (q > p.stock) { q = p.stock; toast('已達可售數量上限'); }
    if (limit > 0 && q > limit) { q = limit; toast(`每人單品最多 ${limit} ${p.unit}`); }
    if (q === 0) delete this.cart[id]; else this.cart[id] = q;
    this.render();
  },

  lines() {
    return Object.entries(this.cart).map(([id, qty]) => {
      const p = this.product(Number(id));
      return p ? { p, qty, sum: p.price * qty } : null;
    }).filter(Boolean);
  },
  subtotal() { return this.lines().reduce((s, l) => s + l.sum, 0); },
  fee(method, sub) {
    const D = this.cfg.delivery;
    if (method === 'pickup') return Number(D.pickupFee) || 0;
    const free = Number(D.freeOver) || 0;
    return (free > 0 && sub >= free) ? 0 : (Number(D.fee) || 0);
  },

  openDrawer() { $('drawer').classList.add('open'); $('drawerMask').classList.add('open'); },
  closeDrawer() { $('drawer').classList.remove('open'); $('drawerMask').classList.remove('open'); },

  renderCart() {
    const lines = this.lines();
    $('cartCount').textContent = lines.reduce((s, l) => s + l.qty, 0);
    $('drawerTitle').textContent = this.mode === 'checkout' ? '填寫取貨資料'
                                 : this.mode === 'done' ? '訂單已送出'
                                 : this.mode === 'lookup' ? '查詢我的訂單' : '購物車';
    if (this.mode === 'done') return this.renderDone();
    if (this.mode === 'lookup') return this.renderLookup();
    if (this.mode === 'checkout') return this.renderCheckout();

    if (!lines.length) {
      $('drawerBody').innerHTML = '<p class="muted" style="text-align:center;padding:40px 0">購物車是空的<br>回前台挑點新鮮的吧 🥬</p>';
      $('drawerFoot').innerHTML = '<button class="btn block ghost" data-act="close">繼續選購</button>';
      return;
    }
    $('drawerBody').innerHTML = lines.map(l => {
      const img = safeImg(l.p.image);
      return `<div class="cart-item">
        <div class="ci-emoji">${img ? `<img src="${esc(img)}" alt="" style="width:34px;height:34px;border-radius:6px;object-fit:cover">` : esc(l.p.image)}</div>
        <div class="ci-main"><div class="ci-name">${esc(l.p.name)}</div>
          <div class="muted">${nt(l.p.price)} × ${l.qty} ${esc(l.p.unit)}</div></div>
        <div style="text-align:right"><div style="font-weight:700">${nt(l.sum)}</div>
          <div class="qty" style="margin-top:5px">
            <button data-qty="${l.p.id}" data-to="${l.qty - 1}">−</button><span>${l.qty}</span>
            <button data-qty="${l.p.id}" data-to="${l.qty + 1}">＋</button>
          </div></div>
      </div>`;
    }).join('');

    const sub = this.subtotal(), min = Number(this.cfg.rules.minOrder) || 0;
    const ok = !this.cfg.closed && sub >= min;
    $('drawerFoot').innerHTML = `
      <div class="sum-line"><span>商品小計</span><b>${nt(sub)}</b></div>
      ${min > 0 && sub < min ? `<p class="muted" style="color:var(--danger)">還差 ${nt(min - sub)} 才達最低訂單金額 ${nt(min)}</p>` : ''}
      ${this.cfg.closed ? '<p class="muted" style="color:var(--danger)">本檔次已截止。</p>' : ''}
      <button class="btn block" style="margin-top:8px" data-act="checkout" ${ok ? '' : 'disabled'}>前往填寫取貨資料</button>`;
  },

  renderCheckout() {
    const D = this.cfg.delivery, P = this.cfg.pickups;
    $('drawerBody').innerHTML = `
      <label class="field"><span>姓名 *</span><input class="input" id="coName" autocomplete="name"></label>
      <label class="field"><span>手機 *</span><input class="input" id="coPhone" inputmode="tel" autocomplete="tel" placeholder="09xxxxxxxx"></label>
      <label class="field"><span>取貨方式 *</span>
        <select class="input" id="coMethod">
          <option value="pickup">到取貨點自取</option>
          ${Number(D.enabled) ? '<option value="delivery">宅配到府</option>' : ''}
        </select></label>
      <div id="coBox"></div>
      <label class="field"><span>備註</span><textarea class="input" id="coNote"></textarea></label>
      <p class="muted">${esc(this.cfg.rules.successNote)}</p>`;

    const paint = () => {
      const m = $('coMethod').value, sub = this.subtotal(), fee = this.fee(m, sub);
      $('coBox').innerHTML = m === 'pickup'
        ? `<label class="field"><span>自取地點 *</span><select class="input" id="coPickup">
             ${P.map(p => `<option value="${p.id}">${esc(p.name)}（${esc(p.hours)}）</option>`).join('')}
           </select></label>${P.length ? `<p class="muted">${esc(P[0].address)}</p>`
             : '<p class="muted" style="color:var(--danger)">尚未設定取貨點。</p>'}`
        : `<label class="field"><span>配送區域 *</span><select class="input" id="coArea">
             ${(D.areas || []).map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}
           </select></label>
           <label class="field"><span>詳細地址 *</span><input class="input" id="coAddr" autocomplete="street-address"></label>`;
      $('drawerFoot').innerHTML = `
        <div class="sum-line"><span>商品小計</span><span>${nt(sub)}</span></div>
        <div class="sum-line"><span>${m === 'pickup' ? '自取手續費' : '運費'}</span><span>${fee === 0 ? '免費' : nt(fee)}</span></div>
        ${m === 'delivery' && Number(D.freeOver) > 0 && sub < Number(D.freeOver)
          ? `<p class="muted">再買 ${nt(D.freeOver - sub)} 即可免運</p>` : ''}
        <div class="sum-line total"><span>應付總額</span><span>${nt(sub + fee)}</span></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn ghost" style="flex:0 0 90px" data-act="back">返回</button>
          <button class="btn" style="flex:1" data-act="submit">送出訂單</button>
        </div>
        <p class="muted" style="text-align:center;margin:8px 0 0">目前為取貨時付款。</p>`;
    };
    $('coMethod').addEventListener('change', paint);
    paint();
  },

  async submit(btn) {
    const g = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
    const method = g('coMethod');
    const body = {
      name: g('coName'), phone: g('coPhone'), method, note: g('coNote'),
      items: this.lines().map(l => ({ productId: l.p.id, qty: l.qty }))
    };
    if (method === 'pickup') body.pickupId = Number(g('coPickup'));
    else { body.area = g('coArea'); body.address = g('coAddr'); }

    if (!body.name) return toast('請填寫姓名');
    if (!/^09\d{8}$/.test(body.phone.replace(/[^0-9]/g, ''))) return toast('請填寫正確的手機號碼');

    btn.disabled = true; btn.textContent = '送出中…';
    try {
      const r = await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      this.done = r;
      this.cart = {};
      this.mode = 'done';
      this.cfg = await api('/api/config');   // 重新取得庫存與進度
      this.render();
      this.renderCart();
    } catch (e) {
      toast(e.message);
      btn.disabled = false; btn.textContent = '送出訂單';
    }
  },

  /* ---------- 查詢我的訂單 ----------
     沒有會員系統，用「訂單編號 + 下單手機」比對；後端查不到時只回一句籠統的錯誤，
     而且有速率限制，避免有人拿編號慢慢試別人的訂單。 */
  renderLookup() {
    const o = this.lookup;
    if (!o) {
      $('drawerBody').innerHTML = `
        <p class="muted">輸入訂單編號與下單時填寫的手機號碼，即可查看訂單狀態。</p>
        <label class="field"><span>訂單編號 *</span>
          <input class="input" id="lkCode" placeholder="GB…" autocomplete="off"></label>
        <label class="field"><span>手機號碼 *</span>
          <input class="input" id="lkPhone" inputmode="tel" placeholder="09xxxxxxxx" autocomplete="tel"></label>
        <div id="lkMsg"></div>`;
      $('drawerFoot').innerHTML = `
        <button class="btn block" data-act="doLookup">查詢</button>
        <button class="btn block ghost" style="margin-top:8px" data-act="close">關閉</button>`;
      return;
    }

    const payPill = o.pay_status === '已付款' ? 'green' : o.pay_status === '已退款' ? 'red' : '';
    $('drawerBody').innerHTML = `
      <div class="card panel">
        <div class="sum-line"><span>訂單編號</span><b>${esc(o.code)}</b></div>
        <div class="sum-line"><span>下單時間</span><span>${esc(o.created_at)}</span></div>
        <div class="sum-line"><span>訂購人</span><span>${esc(o.buyer_name)}</span></div>
        <div class="sum-line"><span>訂單狀態</span><span class="pill">${esc(o.status)}</span></div>
        <div class="sum-line"><span>付款狀態</span><span class="pill ${payPill}">${esc(o.pay_status)}</span></div>
        <div class="sum-line"><span>取貨方式</span><span>${o.method === 'pickup'
          ? esc(o.pickup ? o.pickup.name : '自取') : '宅配・' + esc(o.address)}</span></div>
        ${o.method === 'pickup' && o.pickup ? `<p class="muted">${esc(o.pickup.address)}　${esc(o.pickup.hours)}</p>` : ''}
      </div>
      <div class="card panel" style="margin-top:12px">
        ${o.items.map(i => `<div class="sum-line"><span>${esc(i.name)} × ${i.qty} ${esc(i.unit)}</span><span>${nt(i.amount)}</span></div>`).join('')}
        <div class="sum-line"><span>運費</span><span>${o.fee === 0 ? '免費' : nt(o.fee)}</span></div>
        <div class="sum-line total"><span>應付總額</span><span>${nt(o.total)}</span></div>
      </div>
      ${o.note ? `<p class="muted" style="margin-top:10px">備註：${esc(o.note)}</p>` : ''}
      <p class="muted">訂單如需修改或取消，請直接聯絡團主。</p>`;
    $('drawerFoot').innerHTML = `
      <button class="btn block ghost" data-act="lookupAgain">查另一筆</button>
      <button class="btn block" style="margin-top:8px" data-act="close">關閉</button>`;
  },

  async doLookup(btn) {
    const code = ($('lkCode').value || '').trim();
    const phone = ($('lkPhone').value || '').trim();
    if (!code || !phone) return toast('請輸入訂單編號與手機號碼');
    btn.disabled = true; btn.textContent = '查詢中…';
    try {
      const r = await api('/api/lookup', { method: 'POST', body: JSON.stringify({ code, phone }) });
      this.lookup = r.order;
      this.renderCart();
    } catch (e) {
      $('lkMsg').innerHTML = `<div class="notice">${esc(e.message)}</div>`;
      btn.disabled = false; btn.textContent = '查詢';
    }
  },

  renderDone() {
    const r = this.done;
    $('drawerBody').innerHTML = `
      <div style="text-align:center;padding:18px 0">
        <div style="font-size:46px">✅</div>
        <h3 class="sub" style="margin:8px 0 2px">訂單已送出</h3>
        <p class="muted">訂單編號 <b>${esc(r.code)}</b></p>
      </div>
      <div class="card panel">
        <div class="sum-line"><span>商品小計</span><span>${nt(r.subtotal)}</span></div>
        <div class="sum-line"><span>運費</span><span>${r.fee === 0 ? '免費' : nt(r.fee)}</span></div>
        <div class="sum-line total"><span>應付總額</span><span>${nt(r.total)}</span></div>
      </div>
      <p class="muted" style="margin-top:14px">${esc(r.successNote || '')}</p>
      <p class="muted">目前進度：${r.progress.reached ? '已達成團門檻 🎉'
        : `還差 ${this.cfg.rules.thresholdType === 'orders'
            ? (r.progress.target - r.progress.current) + ' 筆'
            : nt(Math.max(0, r.progress.target - r.progress.current))} 成團`}</p>`;
    $('drawerFoot').innerHTML = '<button class="btn block" data-act="finish">完成</button>';
  }
};

/** 把 #rrggbb 調亮(正)或調暗(負) */
function shade(hex, p) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(p >= 0 ? c + (255 - c) * p / 100 : c * (100 + p) / 100)));
  return '#' + [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(c => c.toString(16).padStart(2, '0')).join('');
}

/* ---------- 事件委派（CSP 不允許行內 onclick，所以統一在這裡接） ---------- */
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-qty],[data-cat],[data-act]');
  if (!t) return;
  if (t.dataset.qty) return Shop.setQty(Number(t.dataset.qty), Number(t.dataset.to));
  if (t.dataset.cat) { Shop.cat = t.dataset.cat; return Shop.render(); }
  switch (t.dataset.act) {
    case 'close':    return Shop.closeDrawer();
    case 'doLookup':    return Shop.doLookup(t);
    case 'lookupAgain': Shop.lookup = null; return Shop.renderCart();
    case 'checkout': Shop.mode = 'checkout'; return Shop.renderCart();
    case 'back':     Shop.mode = 'cart';     return Shop.renderCart();
    case 'submit':   return Shop.submit(t);
    case 'finish':   Shop.mode = 'cart'; Shop.lookup = null; Shop.renderCart(); return Shop.closeDrawer();
  }
});
$('cartBtn').addEventListener('click', () => { Shop.mode = 'cart'; Shop.renderCart(); Shop.openDrawer(); });
$('lookupBtn').addEventListener('click', () => {
  Shop.mode = 'lookup'; Shop.lookup = null; Shop.renderCart(); Shop.openDrawer();
});
// 搜尋框是靜態元素（不隨 render() 重畫），所以打字時不會失去游標焦點
$('searchBox').addEventListener('input', (e) => { Shop.q = e.target.value; Shop.render(); });
$('drawerClose').addEventListener('click', () => Shop.closeDrawer());
$('drawerMask').addEventListener('click', () => Shop.closeDrawer());

Shop.load();
