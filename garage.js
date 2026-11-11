// GT7 賽事戰績簿 — 車輛清單比對＋車庫視角
// 依賴 cars.js（CARS）；執行時會用到 app.js 的 S、esc、trophy、trackById、eventOfRec、evKey、posCmp、gotoTrack、Api 等
// （這個檔在 app.js 之前載入，所以只定義函式，不在載入時呼叫 app.js 的東西）

/* ───────── 車輛清單與比對 ───────── */
const CAR = (typeof CARS === 'undefined' ? [] : CARS).map(a => ({ id: a[0], mk: a[1], s: a[2], l: a[3], cls: a[4], ct: a[5], dt: a[6], pp: a[7] }));
const _fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘`´]/g, "'");
const normCar = s => _fold(s).replace(/vision gran turismo/g, 'vgt').replace(/[^a-z0-9]/g, '');
const CAR_IDX = new Map();
for (const c of CAR) { CAR_IDX.set(normCar(c.l), c); if (!CAR_IDX.has(normCar(c.s))) CAR_IDX.set(normCar(c.s), c); }
const carOf = name => (name ? CAR_IDX.get(normCar(name)) || null : null);
const carLabel = name => carOf(name)?.s || name || '';           // 顯示用：遊戲裡的簡稱
const carTokens = s => _fold(s).split(/[^a-z0-9']+/).filter(Boolean);

// 對不到時找最接近的幾台（字詞重疊＋包含關係）
function carCandidates(name, n = 6) {
  const q = carTokens(name), qn = normCar(name);
  if (!q.length) return [];
  return CAR.map(c => {
    const t = new Set(carTokens(c.l));
    let hit = 0; q.forEach(x => t.has(x) && hit++);
    let score = hit / (q.length + 0.25 * t.size);
    if (qn.length >= 3 && normCar(c.l).includes(qn)) score += 0.6;
    return { c, score };
  }).filter(x => x.score > 0.12).sort((a, b) => b.score - a.score).slice(0, n).map(x => x.c);
}

const CLS_LABEL = { 'Gr.N': '市售車', 'Gr.1': 'Gr.1', 'Gr.2': 'Gr.2', 'Gr.3': 'Gr.3', 'Gr.4': 'Gr.4', 'Gr.B': '拉力', 'Gr.X': '特殊' };
const CTRY_CC = { '日本': 'jp', '美國': 'us', '德國': 'de', '義大利': 'it', '英國': 'gb', '法國': 'fr', '韓國': 'kr', '瑞典': 'se', '奧地利': 'at', '捷克': 'cz', '中國': 'cn', '西班牙': 'es', '荷蘭': 'nl', '克羅埃西亞': 'hr' };
// 廠牌代表色（文字徽章用，不是官方 logo）；淺色底配深色字
const BRAND_COLOR = {
  'McLaren': '#ff8000', 'Ferrari': '#c8102e', 'Porsche': '#2b2b2b', 'Honda': '#cc0000', 'Alpine': '#0055a4', 'Toyota': '#eb0a1e',
  'Subaru': '#003399', 'Nissan': '#c3002f', 'Mazda': '#5b1220', 'BMW': '#1c69d4', 'Audi': '#bb0a30', 'Mercedes-Benz': '#3a3a3a',
  'AMG': '#00877a', 'Lamborghini': '#d4a017', 'Aston Martin': '#00665e', 'Chevrolet': '#d4af37', 'Ford': '#003478', 'Dodge': '#b0102a',
  'Lexus': '#1a1a1a', 'Mitsubishi': '#e60012', 'Hyundai': '#002c5f', 'Genesis': '#111', 'Jaguar': '#0b3d2e', 'Bugatti': '#1f3a93',
  'Peugeot': '#1b1b1b', 'Renault': '#ffcc00', 'Volkswagen': '#001e50', 'Lancia': '#003a70', 'Citroën': '#a6192e', 'Suzuki': '#e30613',
  'Pagani': '#555', 'Maserati': '#0c2340', 'Tesla': '#cc0000', 'Volvo': '#003057', 'Nismo': '#c3002f', 'Abarth': '#d40000',
  'FIAT': '#9b1b30', 'MINI': '#222', 'Shelby': '#003478', 'RUF': '#1a7f37', 'Pontiac': '#c8102e', 'Plymouth': '#2a4d8f',
  'Daihatsu': '#c8102e', 'KTM': '#ff6600', 'Caterham': '#1a6b2f', 'Radical': '#e30613', '跑車浪漫旅': '#2f7cf6', '超級方程式': '#e30613',
};
const LIGHT_BRANDS = new Set(['Lamborghini', 'Renault', 'Chevrolet', 'KTM', 'McLaren']);
function brandStyle(mk) {
  let bg = BRAND_COLOR[mk];
  if (!bg) { let h = 0; for (const ch of mk) h = (h * 31 + ch.charCodeAt(0)) % 360; bg = `hsl(${h},42%,30%)`; }
  return `background:${bg};color:${LIGHT_BRANDS.has(mk) ? '#141414' : '#fff'}`;
}
const UNMATCHED = '清單外的車名';

/* ───────── 表單：車名只能從清單選 ───────── */
function fillCarList() {
  const dl = document.getElementById('dlCars');
  if (dl.dataset.filled) return;
  dl.innerHTML = CAR.map(c => `<option value="${esc(c.l)}" label="${esc(CLS_LABEL[c.cls] || c.cls)}">`).join('');
  dl.dataset.filled = '1';
}
function recentCars(n = 6) {
  const seen = new Set(), out = [];
  for (const r of [...S.records].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    const c = carOf(r.car); if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
    if (out.length >= n) break;
  }
  return out;
}
function updateCarHint(normalize) {
  const inp = form.car, box = document.getElementById('carHint'), custom = form.carCustom.checked;
  const v = inp.value.trim(), c = carOf(v);
  if (c) {
    if (normalize && inp.value !== c.l) inp.value = c.l;
    box.innerHTML = `<span class="ok">✓ ${esc(c.mk)} · ${esc(CLS_LABEL[c.cls] || c.cls)} · ${esc(c.dt)} · PP ${esc(c.pp)}</span>`;
    return;
  }
  if (!v) {
    const rc = recentCars();
    box.innerHTML = rc.length ? `<span class="muted">最近開的：</span>${rc.map(c => `<button type="button" class="carpick" data-car="${esc(c.l)}">${esc(c.s)}</button>`).join('')}` : '';
    return;
  }
  if (custom) { box.innerHTML = '<span class="warn">會照你打的名稱存（清單外）</span>'; return; }
  const cand = carCandidates(v);
  box.innerHTML = `<span class="warn">對不到清單，是不是：</span>` +
    (cand.length ? cand.map(c => `<button type="button" class="carpick" data-car="${esc(c.l)}">${esc(c.l)}</button>`).join('') : '<span class="muted">（找不到相近的）</span>');
}
function bindCarField() {
  form.car.addEventListener('input', () => updateCarHint(false));
  form.car.addEventListener('change', () => updateCarHint(true));
  form.carCustom.addEventListener('change', () => updateCarHint(false));
  document.getElementById('carHint').addEventListener('click', e => {
    const b = e.target.closest('.carpick'); if (!b) return;
    form.car.value = b.dataset.car; form.carCustom.checked = false; updateCarHint(true);
  });
}
// 存檔前檢查：回傳要存的車名；對不到又沒勾「清單外」就回傳 null
function carForSave() {
  const v = form.car.value.trim(), c = carOf(v);
  if (c) return c.l;
  if (form.carCustom.checked && v) return v;
  updateCarHint(false);
  return null;
}

/* ───────── 車庫畫面 ───────── */
const G = { cls: 'all', sort: 'wins', q: '', open: new Set(), car: null, opened: false };

function garageData() {
  const cars = new Map();
  for (const r of S.records) {
    if (!r.car) continue;
    const c = carOf(r.car), key = c ? c.id : 'x:' + r.car;
    if (!cars.has(key)) cars.set(key, { key, c, name: c ? c.l : r.car, short: c ? c.s : r.car, mk: c ? c.mk : UNMATCHED, recs: [] });
    cars.get(key).recs.push(r);
  }
  for (const g of cars.values()) {
    g.wins = g.recs.filter(r => +r.position === 1).length;
    g.races = g.recs.length;
    g.last = g.recs.reduce((m, r) => (String(r.raceDate || r.createdAt) > m ? String(r.raceDate || r.createdAt) : m), '');
    g.tracks = new Set(g.recs.map(r => r.trackId)).size;
    const ev = {}; g.recs.forEach(r => r.event && (ev[r.event] = (ev[r.event] || 0) + 1));
    g.topEvent = Object.entries(ev).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }
  return [...cars.values()];
}

function garageSortFn() {
  if (G.sort === 'races') return (a, b) => b.races - a.races || b.wins - a.wins;
  if (G.sort === 'last') return (a, b) => b.last.localeCompare(a.last);
  return (a, b) => b.wins - a.wins || b.races - a.races;
}

function renderGarage() {
  const all = garageData();
  const q = _fold(G.q.trim());
  const cars = all.filter(g => (G.cls === 'all' || (g.c && g.c.cls === G.cls) || (G.cls === 'none' && !g.c))
    && (!q || _fold(g.name + ' ' + g.mk + ' ' + g.short).includes(q)));
  const sf = garageSortFn();
  const brands = new Map();
  for (const g of cars) { if (!brands.has(g.mk)) brands.set(g.mk, []); brands.get(g.mk).push(g); }
  const blist = [...brands.entries()].map(([mk, cs]) => ({ mk, cs: cs.sort(sf), wins: cs.reduce((s, g) => s + g.wins, 0),
    races: cs.reduce((s, g) => s + g.races, 0), last: cs.reduce((m, g) => (g.last > m ? g.last : m), '') }));
  blist.sort((a, b) => (a.mk === UNMATCHED) - (b.mk === UNMATCHED) ||
    (G.sort === 'races' ? b.races - a.races : G.sort === 'last' ? b.last.localeCompare(a.last) : b.wins - a.wins || b.races - a.races));

  // 第一次進來：預設展開第一個廠牌、選第一台車
  if (!G.opened && blist.length) { G.opened = true; G.open.add(blist[0].mk); if (!G.car) G.car = blist[0].cs[0].key; }
  if (G.q && blist.length <= 3) blist.forEach(b => G.open.add(b.mk));

  document.getElementById('gStats').textContent = `${all.length} 台車 · ${new Set(all.map(g => g.mk)).size} 個廠牌 · 拿過第一 ${all.filter(g => g.wins).length} 台`;
  const list = document.getElementById('gList');
  if (!all.length) { list.innerHTML = '<div class="empty">還沒有紀錄。比完賽上傳截圖或手動輸入，開過的車就會出現在這裡。</div>'; renderGarageDetail(null); return; }
  if (!blist.length) { list.innerHTML = '<div class="empty">沒有符合的車</div>'; }
  else list.innerHTML = blist.map(b => {
    const open = G.open.has(b.mk), unmatched = b.mk === UNMATCHED;
    const ct = b.cs[0].c?.ct || '';
    return `<div class="gbrand ${open ? 'open' : ''}">
      <div class="gbh" data-brand="${esc(b.mk)}">
        <div class="gbadge" style="${unmatched ? 'background:#3a3e48;color:#dfe3ea' : brandStyle(b.mk)}">${esc(unmatched ? '清單外' : b.mk)}</div>
        ${CTRY_CC[ct] ? `<span class="fi fi-${CTRY_CC[ct]}"></span>` : ''}
        <div class="gbn">${esc(unmatched ? '車名對不到官方清單' : ct)}<small>${b.cs.length} 台車</small></div>
        ${unmatched ? '<button class="btn small" data-fixcars>整理名稱</button>' : ''}
        <div class="gbw ${b.wins ? '' : 'z'}">🏆 ${b.wins}</div><div class="garr">${open ? '▾' : '▸'}</div>
      </div>
      ${open ? `<div class="gcars">${b.cs.map(g => `<div class="gcar ${g.key === G.car ? 'sel' : ''}" data-car="${esc(g.key)}">
          <div class="gcn">${esc(g.short)}</div><div class="gcl">${esc(g.c ? CLS_LABEL[g.c.cls] || g.c.cls : '—')}</div>
          <div class="gcw ${g.wins ? '' : 'z'}">🏆 ${g.wins}</div><div class="gcr">${g.races} 場</div></div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  renderGarageDetail(all.find(g => g.key === G.car) || null);
}

function renderGarageDetail(g) {
  const d = document.getElementById('gDetail');
  if (!g) { d.innerHTML = '<div class="empty">從左邊選一台車</div>'; return; }
  const c = g.c, rs = [...g.recs].sort(posCmp);
  d.innerHTML = `<button class="btn icon gclose" data-gclose>✕</button>
    <div class="gmk">${c && CTRY_CC[c.ct] ? `<span class="fi fi-${CTRY_CC[c.ct]}"></span>` : ''}${esc(c ? [c.mk, c.ct, CLS_LABEL[c.cls] || c.cls, c.dt, 'PP ' + c.pp].join(' · ') : '清單外的車名')}</div>
    <div class="gnm">${esc(g.short)}</div>
    ${c && c.l !== c.s ? `<div class="gfull">${esc(c.l)}</div>` : ''}
    <div class="gkpi"><div><small>拿過第一</small><b class="g">${g.wins}</b></div><div><small>跑過</small><b>${g.races} 場</b></div>
      <div><small>賽道</small><b>${g.tracks}</b></div><div><small>最常跑</small><b class="ev">${esc(g.topEvent || '—')}</b></div></div>
    <h4 class="gh">全部戰績（依名次）· 點一筆跳到該賽道</h4>
    <div class="grecs">${rs.map(r => {
      const t = trackById(r.trackId), e = eventOfRec(r);
      // 配置名稱本身就含賽道名（例如「薩丁尼亞島 - 道路賽道 - A」），有配置就只顯示配置
      const meta = [r.layout || t?.zh || r.trackId, e ? evMeta(e) : (r.ppLimit ? 'PP ' + r.ppLimit : '')].filter(Boolean).join(' · ');
      const gap = /^\+/.test(r.time || '');
      return `<div class="grec" data-rec="${esc(r.id)}">${trophy(r.position)}
        <div class="m"><div class="e">${esc(r.event || '（未填賽事）')}</div><div class="t">${t?.cc ? `<span class="fi fi-${esc(t.cc)}"></span> ` : ''}${esc(meta)}</div></div>
        <div class="tm ${gap ? 'gap' : ''}">${esc(r.time || '')}<small>${esc(r.raceDate || '')}</small></div></div>`;
    }).join('')}</div>`;
}

function showGarage() {
  if (S.screen !== 'garage') S.prevScreen = S.screen;
  S.screen = 'garage';
  closePanel();
  ['worldScreen', 'regionScreen', 'homeScreen'].forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById('garageScreen').classList.remove('hidden');
  placeNav(); renderGarage(); renderTopbar();
}
function leaveGarage() {
  document.getElementById('garageScreen').classList.add('hidden');
  document.getElementById('gDetail').classList.remove('open');
  if (S.prevScreen === 'region') enterRegion(S.region, S.view); else if (S.prevScreen === 'world') showWorld(); else showHome();
}

function bindGarage() {
  document.getElementById('btnGarage').onclick = () => (S.screen === 'garage' ? leaveGarage() : showGarage());
  document.getElementById('gFilters').addEventListener('click', e => {
    const b = e.target.closest('[data-cls]'); if (!b) return;
    G.cls = b.dataset.cls;
    document.querySelectorAll('#gFilters [data-cls]').forEach(x => x.classList.toggle('on', x === b));
    renderGarage();
  });
  document.getElementById('gSort').onchange = e => { G.sort = e.target.value; renderGarage(); };
  document.getElementById('gSearch').oninput = e => { G.q = e.target.value; renderGarage(); };
  document.getElementById('gList').addEventListener('click', e => {
    if (e.target.closest('[data-fixcars]')) { e.stopPropagation(); return openCarFix(); }
    const car = e.target.closest('.gcar');
    if (car) { G.car = car.dataset.car; renderGarage(); document.getElementById('gDetail').classList.add('open'); return; }
    const bh = e.target.closest('.gbh');
    if (bh) { const mk = bh.dataset.brand; G.open.has(mk) ? G.open.delete(mk) : G.open.add(mk); renderGarage(); }
  });
  document.getElementById('gDetail').addEventListener('click', e => {
    if (e.target.closest('[data-gclose]')) return document.getElementById('gDetail').classList.remove('open');
    const row = e.target.closest('.grec'); if (!row) return;
    const r = S.records.find(x => x.id === row.dataset.rec); if (!r) return;
    document.getElementById('garageScreen').classList.add('hidden');
    document.getElementById('gDetail').classList.remove('open');
    const ev = eventOfRec(r);
    gotoTrack(r.trackId);
    if (ev) { S.panelEvent = evKey(ev); renderPanel(); }
  });
  document.getElementById('btnCarFixApply').onclick = applyCarFix;
}

/* ───────── 整理舊紀錄的車名 ───────── */
function openCarFix() {
  const names = {};
  S.records.forEach(r => { if (r.car && !carOf(r.car)) names[r.car] = (names[r.car] || 0) + 1; });
  const list = Object.entries(names).sort((a, b) => b[1] - a[1]);
  document.getElementById('carFixList').innerHTML = list.length ? list.map(([n, k], i) => {
    const cand = carCandidates(n, 8);
    // 只有「打的每個字都出現在候選車名裡」才預選，避免亂配；否則預設保持原樣
    const sure = cand[0] && carTokens(n).every(t => carTokens(cand[0].l).includes(t));
    return `<div class="cfrow"><div class="cfn"><b>${esc(n)}</b><small>${k} 筆${sure ? '' : ' · 請手動選'}</small></div>
      <select data-from="${esc(n)}"><option value="">（保持原樣）</option>${cand.map((c, j) => `<option value="${esc(c.l)}" ${sure && j === 0 ? 'selected' : ''}>${esc(c.l)}</option>`).join('')}</select></div>`;
  }).join('') : '<div class="empty">所有車名都已對應到官方清單 👍</div>';
  document.getElementById('carFixModal').classList.remove('hidden');
}
async function applyCarFix() {
  const maps = [...document.querySelectorAll('#carFixList select')].filter(s => s.value).map(s => [s.dataset.from, s.value]);
  const todo = S.records.filter(r => maps.some(([f]) => f === r.car));
  if (!todo.length) { document.getElementById('carFixModal').classList.add('hidden'); return; }
  const btn = document.getElementById('btnCarFixApply'); btn.disabled = true;
  try {
    let i = 0;
    for (const r of todo) {
      toast(`更新中… ${++i} / ${todo.length}`, 60000);
      await Api.saveRecord({ ...r, car: maps.find(([f]) => f === r.car)[1] });
    }
    toast(`已更新 ${todo.length} 筆紀錄的車名`, 3000);
    document.getElementById('carFixModal').classList.add('hidden');
    refreshAll();
  } catch (err) { toast('更新失敗：' + err.message, 6000); }
  finally { btn.disabled = false; }
}
