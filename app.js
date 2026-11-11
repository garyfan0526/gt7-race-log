// GT7 賽事戰績簿 — 前端主程式
// 畫面：世界賽道（三個地區轉盤）→ 地區地圖（可切子區域）→ 賽道面板
// 資料：沒設後端網址＝本機模式（localStorage）；有設＝Apps Script（Sheet＋Drive＋Gemini）

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const flag = cc => cc ? `<span class="fi fi-${esc(String(cc).toLowerCase())}"></span>` : '';

const LS_SETTINGS = 'gt7log.settings', LS_DATA = 'gt7log.data';
// iPhone 主畫面捷徑開啟時加上 class（舊版 iOS 不支援 display-mode 媒體查詢的備援）
if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) document.documentElement.classList.add('standalone');
// 預設後端（Apps Script，beeckham03 帳號）。資料由通關密碼保護；設定裡清空網址＝本機模式。
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbxQEzO0zwhfiIyvEwNiHLxUUqKYua8KqZMwLY-mQ8wlWjB8aCmEK9cjX164BNWC59Kl/exec';

const S = {
  settings: JSON.parse(localStorage.getItem(LS_SETTINGS) || JSON.stringify({ apiUrl: DEFAULT_API_URL })),
  records: [], customTracks: [], queue: [],
  screen: 'home', region: 'europe', view: null, hotRegion: 'europe', panelTrack: null, panelEvent: null,
  formQueue: [], formCur: null, placing: null,
};

/* ───────────────────────── 資料存取 ───────────────────────── */
const Api = {
  remote: () => !!S.settings.apiUrl,
  async post(action, payload = {}) {
    const res = await fetch(S.settings.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS 預檢
      body: JSON.stringify({ action, pass: S.settings.pass || '', ...payload }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '後端錯誤');
    return j;
  },
  persistLocal() {
    try { localStorage.setItem(LS_DATA, JSON.stringify({ records: S.records, customTracks: S.customTracks })); }
    catch (e) { toast('瀏覽器空間滿了，請改用雲端模式或匯出備份', 5000); throw e; }
  },
  async load() {
    if (this.remote()) {
      const j = await this.post('list');
      S.records = j.records || []; S.customTracks = j.customTracks || []; S.queue = j.queue || [];
    } else {
      const d = JSON.parse(localStorage.getItem(LS_DATA) || '{}');
      S.records = d.records || []; S.customTracks = d.customTracks || []; S.queue = [];
    }
  },
  async saveRecord(rec, queueId) {
    if (this.remote()) {
      rec = (await this.post('save', { record: rec, queueId })).record;
      if (queueId) S.queue = S.queue.filter(q => q.id !== queueId);
    }
    const i = S.records.findIndex(r => r.id === rec.id);
    if (i >= 0) S.records[i] = rec; else S.records.push(rec);
    if (!this.remote()) this.persistLocal();
    return rec;
  },
  async deleteRecord(id) {
    if (this.remote()) await this.post('delete', { id });
    S.records = S.records.filter(r => r.id !== id);
    if (!this.remote()) this.persistLocal();
  },
  async addTrack(t) {
    if (this.remote()) await this.post('addTrack', { track: { ...t, layouts: t.layouts.map(l => l[0]).join('|') } });
    S.customTracks.push({ ...t, layouts: t.layouts.map(l => l[0]).join('|') });
    if (!this.remote()) this.persistLocal();
  },
};

/* ───────────────────────── 賽道工具 ───────────────────────── */
const allTracks = () => [...BUILTIN_TRACKS, ...S.customTracks.map(t => ({
  ...t, lat: +t.lat, lon: +t.lon, custom: true,
  layouts: String(t.layouts || '').split('|').filter(Boolean).map(z => [z, '']),
}))];
const trackById = id => allTracks().find(t => t.id === id);
const regionOf = id => REGIONS.find(r => r.id === id);
const inBounds = (t, b) => t.lon >= b[0][0] && t.lon <= b[1][0] && t.lat >= b[0][1] && t.lat <= b[1][1];
const viewOf = t => { const r = regionOf(t.region); return (r.views.find(v => inBounds(t, v.bounds)) || r.views[0]).id; };

function trackStatus(id) {
  const rs = S.records.filter(r => r.trackId === id);
  const evs = eventsOf(id);
  const evWon = evs.filter(e => recsOfEvent(e).some(r => +r.position === 1)).length;
  if (!rs.length) return { cls: 'none', n: 0, evWon, evTotal: evs.length };
  const best = Math.min(...rs.map(r => +r.position || 99));
  return { cls: best === 1 ? 'gold' : best <= 3 ? 'silver' : 'gray', n: rs.length, best, evWon, evTotal: evs.length };
}

/* ───────── 賽事（每條賽道裡的賽事卡片） ───────── */
const normEv = s => String(s || '').toLowerCase().replace(/\(gt7\)/g, '').replace(/[^a-z0-9]/g, '');
const eventsOf = trackId => (typeof EVENTS === 'undefined' ? [] : EVENTS).filter(e => e.t === trackId);
const evKey = e => `${e.t}|${e.n}|${e.l}`;
// 紀錄屬於哪一場賽事：賽事名相同；同名有多個配置時再比配置
function eventOfRec(r) {
  const c = eventsOf(r.trackId).filter(e => normEv(e.n) === normEv(r.event));
  if (!c.length) return null;
  return c.find(e => e.l === r.layout) || (c.length === 1 ? c[0] : null);
}
const recsOfEvent = e => S.records.filter(r => r.trackId === e.t && eventOfRec(r) === e);
const evMeta = e => `${e.pp ? 'PP ' + e.pp : 'PP 不限'} / ${e.len}`;
const trophy = pos => { const p = +pos; return `<div class="trophy ${p >= 1 && p <= 3 ? 'p' + p : ''}">${esc(pos || '–')}</div>`; };

/* ───────────────────────── 頂列 ───────────────────────── */
function renderTopbar() {
  const ts = allTracks();
  $('#tbRecords').textContent = S.records.length;
  $('#tbGold').textContent = ts.filter(t => trackStatus(t.id).cls === 'gold').length;
  $('#tbTotal').textContent = ts.length;
  const cnt = {};
  S.records.forEach(r => { const k = carLabel(r.car); if (k) cnt[k] = (cnt[k] || 0) + 1; });
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  $('#tbCar').textContent = top ? `${top[0]}（${top[1]} 場）` : '—';
  $('#tbPlace').textContent = S.screen === 'home' ? 'GT7' : S.screen === 'garage' ? '車庫' : S.screen === 'world' ? '世界賽道' : regionOf(S.region).name;
  const inGarage = S.screen === 'garage';
  $('#garageIco').setAttribute('href', inGarage ? '#iMap' : '#iGarage');
  $('#garageTxt').textContent = inGarage ? 'MAP' : 'GARAGE';
  $('#btnGarage').classList.toggle('hidden', S.screen === 'home'); // 首頁已有左右兩個入口，頂列不重複放
  $('#btnQueue').classList.toggle('hidden', !S.queue.length);
  $('#queueCount').textContent = S.queue.length;
}
function tickClock() {
  const d = new Date();
  $('#tbTime').textContent = d.toTimeString().slice(0, 5);
  $('#tbDate').textContent = `${d.getMonth() + 1}月 ${d.getDate()}日`;
}
function renderBanner() {
  const b = $('#banner');
  b.classList.toggle('hidden', Api.remote());
  b.textContent = '本機模式：資料只存在這個瀏覽器、截圖不會自動辨識。到 ⚙ 設定填入後端網址即可改用雲端＋AI 辨識。';
}

/* ───────────────────────── 世界賽道（選區） ───────────────────────── */
let world;
async function loadWorld() {
  const topo = await d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json');
  world = topojson.feature(topo, topo.objects.countries);
}

function renderGlobe() {
  if (!world) return;
  const el = $('#worldScreen'), W = el.clientWidth, H = el.clientHeight;
  const proj = d3.geoNaturalEarth1().fitExtent([[-W * 0.05, H * 0.02], [W * 1.05, H * 1.0]], { type: 'Sphere' });
  const path = d3.geoPath(proj);
  const g = d3.select('#globe'); g.selectAll('*').remove();
  g.append('path').datum(d3.geoGraticule10()).attr('class', 'g-grat').attr('d', path);
  g.append('g').selectAll('path').data(world.features).join('path').attr('class', 'g-land').attr('d', path);
}

function dialSvg(gold, total, key) {
  const ticks = 60, lit = total ? Math.round(ticks * gold / total) : 0;
  let t = '';
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2 - Math.PI / 2, major = i % 5 === 0;
    const r1 = major ? 124 : 128, r2 = 138;
    const col = i < lit ? '#e2a91a' : '#4a5a72';
    t += `<line x1="${(Math.cos(a) * r1).toFixed(1)}" y1="${(Math.sin(a) * r1).toFixed(1)}" x2="${(Math.cos(a) * r2).toFixed(1)}" y2="${(Math.sin(a) * r2).toFixed(1)}" stroke="${col}" stroke-width="${major ? 3 : 2}" stroke-linecap="round"/>`;
  }
  return `<svg viewBox="-160 -160 320 320">
    <defs>
      <radialGradient id="ro${key}" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#dfe7f1"/><stop offset="1" stop-color="#a9b9cd"/></radialGradient>
      <radialGradient id="ri${key}" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#4f7fb8"/><stop offset="1" stop-color="#1b3c6c"/></radialGradient>
    </defs>
    <circle r="152" fill="url(#ro${key})"/>
    <circle r="150" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="2"/>
    ${t}
    <circle r="104" fill="#c7d4e3"/>
    <circle r="98" fill="url(#ri${key})" stroke="rgba(255,255,255,.35)" stroke-width="2"/>
  </svg>`;
}

function renderWorld() {
  const box = $('#dials'); box.innerHTML = '';
  for (const r of REGIONS) {
    const ts = allTracks().filter(t => t.region === r.id);
    const gold = ts.filter(t => trackStatus(t.id).cls === 'gold').length;
    const n = S.records.filter(x => trackById(x.trackId)?.region === r.id).length;
    const d = document.createElement('div');
    d.className = 'dial' + (r.id === S.hotRegion ? ' hot' : '');
    d.innerHTML = dialSvg(gold, ts.length, r.id) + `<div class="d-text">
      <div class="d-name">${esc(r.name)}</div>
      <div class="d-count">${gold}<small> / ${ts.length}</small></div>
      <div class="d-sub">拿過第一的地點</div>
      ${n ? `<div class="d-badge">${n} 筆紀錄</div>` : ''}</div>`;
    d.onmouseenter = () => { S.hotRegion = r.id; box.querySelectorAll('.dial').forEach(x => x.classList.toggle('hot', x === d)); renderAvail(); };
    d.onclick = () => enterRegion(r.id);
    box.appendChild(d);
  }
  renderAvail();
  renderRecent();
}

function renderAvail() {
  $('#availList').innerHTML = allTracks().filter(t => t.region === S.hotRegion)
    .map(t => `<span class="${trackStatus(t.id).cls === 'gold' ? 'won' : ''}">[${esc(t.zh)}]</span>`).join('');
}

function renderRecent() {
  const rs = [...S.records].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 12);
  $('#recentStrip').innerHTML = rs.length ? rs.map(r => {
    const t = trackById(r.trackId);
    return `<div class="rcard" data-track="${esc(r.trackId)}">${trophy(r.position)}<div class="info">
      <div class="t">${esc(t?.zh || r.trackId)}</div><div class="c">${esc(carLabel(r.car))}</div>
      <div class="d">${esc([r.event, r.raceDate].filter(Boolean).join(' · '))}</div></div></div>`;
  }).join('') : '<div class="recent-empty">還沒有紀錄 — 比完賽按右上角「📷 截圖」上傳結算畫面，或「✍ 手動」輸入</div>';
}
$('#recentStrip').addEventListener('click', e => {
  const c = e.target.closest('.rcard'); if (!c) return;
  gotoTrack(c.dataset.track);
});

function gotoTrack(id) {
  const t = trackById(id); if (!t) return;
  enterRegion(t.region, viewOf(t));
  openPanel(id);
}

/* ───────────────────────── 首頁（左世界賽道／右車庫） ───────────────────────── */
function showHome() {
  S.screen = 'home'; closePanel();
  ['worldScreen', 'regionScreen', 'garageScreen'].forEach(id => $('#' + id).classList.add('hidden'));
  $('#homeScreen').classList.remove('hidden');
  placeNav(); renderHome(); renderTopbar();
}
function renderHome() {
  const ts = allTracks(), gold = ts.filter(t => trackStatus(t.id).cls === 'gold').length;
  const evAll = typeof EVENTS === 'undefined' ? [] : EVENTS;
  const evWon = evAll.filter(e => recsOfEvent(e).some(r => +r.position === 1)).length;
  $('#hcWorldSub').textContent = `${ts.length} 個地點・${evAll.length} 場賽事`;
  $('#hcWorldStat').innerHTML = `<b>${gold}</b> / ${ts.length} 地點拿過第一<br><b>${evWon}</b> / ${evAll.length} 場賽事拿過第一`;
  const g = garageData(), top = [...g].sort((a, b) => b.wins - a.wins || b.races - a.races)[0];
  $('#hcGarageSub').textContent = `官方 ${CAR.length} 台車款`;
  $('#hcGarageStat').innerHTML = g.length
    ? `開過 <b>${g.length}</b> 台・拿過第一 <b>${g.filter(x => x.wins).length}</b> 台<br>王牌：<b class="car">${esc(top.short)}</b>（🏆 ${top.wins}）`
    : '還沒有紀錄<br>上傳截圖後，開過的車會出現在這裡';
  renderHomeGlobe();
}
// 首頁競技場外牆的拱門：沿橢圓下半圈排兩層，越靠兩側越窄（透視）
function renderHomeGlobe() {
  const g = $('#hArches');
  if (!g || g.childElementCount) return;
  const cx = 400, cy = 318, rx = 138, ry = 46, n = 15;
  let html = '';
  for (let i = 0; i < n; i++) {
    const t = Math.PI * (0.06 + 0.88 * (i + 0.5) / n);
    const x = cx - rx * Math.cos(t), y = cy + ry * Math.sin(t), w = 11 * Math.sin(t) + 2;
    for (const [dy, h] of [[10, 20], [36, 18]])
      html += `<rect x="${(x - w / 2).toFixed(1)}" y="${(y + dy).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${(w / 2).toFixed(1)}" fill="#4e3322" opacity=".85"/>`;
  }
  g.innerHTML = html;
}

function showWorld() {
  S.screen = 'world'; closePanel();
  $('#worldScreen').classList.remove('hidden'); $('#regionScreen').classList.add('hidden'); $('#garageScreen').classList.add('hidden'); $('#homeScreen').classList.add('hidden');
  placeNav(); renderGlobe(); renderWorld(); renderTopbar();
}

// 手機直放：把「◀ 世界賽道＋子區域」搬到頂列按鈕那一排，地圖可以從最上面開始
const navInTopbar = () => S.screen === 'region' && matchMedia('(max-width: 760px)').matches;
function placeNav() {
  const nav = $('#regionNav'), bar = $('.topbar');
  if (navInTopbar()) { if (nav.parentElement !== bar) bar.insertBefore(nav, $('.tb-actions')); }
  else if (nav.parentElement !== $('#regionScreen')) $('#regionScreen').insertBefore(nav, $('.legend'));
  bar.classList.toggle('with-nav', nav.parentElement === bar);
}

/* ───────────────────────── 地區地圖 ───────────────────────── */
let projection, transform = d3.zoomIdentity, zoomer, gLand, gLead, gPins, rafPending = false;
const svg = d3.select('#map');
const labelsEl = $('#labels');

function enterRegion(id, viewId) {
  S.screen = 'region'; S.region = id;
  S.view = viewId || regionOf(id).views[0].id;
  $('#worldScreen').classList.add('hidden'); $('#garageScreen').classList.add('hidden'); $('#homeScreen').classList.add('hidden'); $('#regionScreen').classList.remove('hidden');
  renderRegion();
}

function renderRegion() {
  placeNav(); renderViewTabs(); renderMap(); renderEvents(); renderTopbar();
}

function renderViewTabs() {
  const r = regionOf(S.region);
  $('#viewTabs').innerHTML = r.views.map(v => {
    const ts = allTracks().filter(t => t.region === r.id && viewOf(t) === v.id);
    const gold = ts.filter(t => trackStatus(t.id).cls === 'gold').length;
    return `<button data-view="${v.id}" class="${v.id === S.view ? 'active' : ''}">${esc(v.name)}<small>${gold}/${ts.length}</small></button>`;
  }).join('');
}
$('#viewTabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.view = b.dataset.view; renderViewTabs(); renderMap();
});

const viewTracks = () => allTracks().filter(t => t.region === S.region && viewOf(t) === S.view && Number.isFinite(t.lat) && Number.isFinite(t.lon));

function renderMap() {
  if (!world || S.screen !== 'region') return;
  const wrap = $('#regionScreen'), W = wrap.clientWidth, H = wrap.clientHeight;
  const v = regionOf(S.region).views.find(x => x.id === S.view);
  const narrow = W < 760;
  const top = navInTopbar() ? 30 : narrow ? 80 : 110, bottom = narrow ? 50 : (S.records.some(r => trackById(r.trackId)?.region === S.region) ? H * 0.24 : 40);
  projection = d3.geoMercator().fitExtent([[40, top], [W - 40, H - bottom]],
    { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: v.bounds } });
  const path = d3.geoPath(projection);

  svg.selectAll('*').remove();
  // 效能：不用 SVG 濾鏡；光暈改用漸層、陸地陰影改成一條位移的深色路徑
  const defs = svg.append('defs');
  for (const [id, c] of [['gl-none', '#ff4242'], ['gl-gold', '#f2c23a'], ['gl-silver', '#d4dbe6'], ['gl-gray', '#7c8496']]) {
    const g = defs.append('radialGradient').attr('id', id);
    g.append('stop').attr('offset', 0).attr('stop-color', c).attr('stop-opacity', .75);
    g.append('stop').attr('offset', 1).attr('stop-color', c).attr('stop-opacity', 0);
  }

  // 效能：只畫這個子區域附近的國家，並合併成單一路徑
  const [[x0, y0], [x1, y1]] = v.bounds, pad = 25;
  const near = world.features.filter(f => {
    const [[a0, b0], [a1, b1]] = f._b || (f._b = d3.geoBounds(f));
    if (b1 < y0 - pad || b0 > y1 + pad) return false;
    if (a0 > a1) return true; // 跨換日線的國家（如俄羅斯）直接保留
    return !(a1 < x0 - pad || a0 > x1 + pad);
  });
  const d = path({ type: 'FeatureCollection', features: near });
  gLand = svg.append('g');
  gLand.append('path').attr('class', 'land-shadow').attr('d', d).attr('transform', 'translate(0,3)');
  gLand.append('path').attr('class', 'land').attr('d', d);
  gLead = svg.append('g'); gPins = svg.append('g');

  zoomer = d3.zoom().scaleExtent([1, 14]).translateExtent([[-W, -H], [2 * W, 2 * H]])
    .on('zoom', e => { transform = e.transform; gLand.attr('transform', transform); schedulePins(); })
    .on('end', () => placePins(true));
  transform = d3.zoomIdentity;
  svg.call(zoomer).call(zoomer.transform, d3.zoomIdentity).on('dblclick.zoom', null);

  labelsEl.innerHTML = '';
  // 小螢幕（手機直放或橫放）用精簡卡片：只留一行「名稱＋🏆」
  labelsEl.classList.toggle('compact', W < 900 || H < 560);
  for (const t of viewTracks()) {
    const st = trackStatus(t.id);
    const el = document.createElement('div');
    el.className = `tlabel ${st.cls}` + (S.panelTrack === t.id ? ' active' : '');
    el.dataset.id = t.id;
    el.innerHTML = `<div class="tl-box">${st.n ? trophy(st.best) : '<div class="new"></div>'}</div>
      <div class="tl-txt"><div class="tl-cty">${flag(t.cc)}${esc(t.country || '')}${st.evTotal ? `<span class="tl-cnt ${st.evWon ? '' : 'dim'}">🏆${st.evWon}/${st.evTotal}</span>` : ''}</div>
      <div class="tl-nm">${esc(t.zh)}${st.evTotal ? `<span class="tl-cnt2 ${st.evWon ? '' : 'dim'}">🏆${st.evWon}/${st.evTotal}</span>` : ''}</div></div>`;
    el.onclick = () => openPanel(t.id);
    labelsEl.appendChild(el);
  }
  labelSize = {};
  placePins(true);
}

function schedulePins() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; placePins(false); });
}

// full=true：重新排版標籤（放開滑鼠/手指後）；false：拖動中只依上次的相對位置平移，很省效能
let labelSize = {}, labelOff = {}, labelShown = null, compactTop = 52, compactBottom = 4;
function placePins(full) {
  const wrap = $('#regionScreen'), W = wrap.clientWidth, H = wrap.clientHeight;
  const items = viewTracks().map(t => {
    const el = labelsEl.querySelector(`[data-id="${CSS.escape(t.id)}"]`);
    if (!el) return null; // 標籤還沒建好（初始化中）
    const [x, y] = transform.apply(projection([t.lon, t.lat]));
    const sz = labelSize[t.id] || (labelSize[t.id] = { w: el.offsetWidth, h: el.offsetHeight });
    return { t, px: x, py: y, el, w: sz.w, h: sz.h, st: trackStatus(t.id) };
  }).filter(Boolean);
  const visible = items.filter(it => it.px > -10 && it.px < W + 10 && it.py > -10 && it.py < H + 10);
  if (full || !labelShown || visible.some(it => !labelOff[it.t.id])) {
    layoutLabels(visible, W, H);
    visible.forEach(it => { labelOff[it.t.id] = [it.lx - it.px, it.ly - it.py]; });
    // 只有手機精簡模式才挑選/隱藏名稱；電腦版全部顯示（維持原本行為）
    labelShown = labelsEl.classList.contains('compact') ? pickLabels(visible, W) : new Set(visible.map(it => it.t.id));
  } else {
    visible.forEach(it => { const o = labelOff[it.t.id]; it.lx = it.px + o[0]; it.ly = it.py + o[1]; });
  }
  // 放不下的名稱先隱藏（點還在、一樣能點），放大地圖後會重新挑
  const withLabel = visible.filter(it => labelShown.has(it.t.id));
  items.forEach(it => { it.el.style.display = withLabel.includes(it) ? '' : 'none'; });
  const hidden = visible.length - withLabel.length;
  const note = $('#mapNote');
  note.textContent = hidden ? `還有 ${hidden} 個賽道名稱放不下：點紅點、或用兩指放大地圖` : '';
  note.classList.toggle('hidden', !hidden);

  const pins = gPins.selectAll('g.pin').data(visible, d => d.t.id).join(enter => {
    const g = enter.append('g').attr('class', 'pin');
    g.append('circle').attr('class', 'sel-ring').attr('r', 15);
    g.append('circle').attr('class', 'pin-glow').attr('r', 13);
    g.append('circle').attr('class', 'pin-core').attr('r', 4.5);
    g.append('circle').attr('class', 'pin-hit').attr('r', 16); // 加大觸控範圍
    return g;
  });
  pins.select('.pin-glow').attr('fill', d => `url(#gl-${d.st.cls})`);
  pins.attr('class', d => `pin ${d.st.cls}`).attr('transform', d => `translate(${d.px},${d.py})`)
    .on('click', (e, d) => { e.stopPropagation(); openPanel(d.t.id); });
  pins.select('.sel-ring').style('display', d => d.t.id === S.panelTrack ? '' : 'none');

  gLead.selectAll('line').data(withLabel, d => d.t.id).join('line').attr('class', 'leader')
    .attr('x1', d => d.px).attr('y1', d => d.py)
    .attr('x2', d => Math.max(d.lx, Math.min(d.px, d.lx + d.w)))
    .attr('y2', d => Math.max(d.ly, Math.min(d.py, d.ly + d.h)));

  for (const it of withLabel) { it.el.style.left = it.lx + 'px'; it.el.style.top = it.ly + 'px'; }
}

// 挑出要顯示名稱的賽道：有紀錄的優先、再來是選中的；跟已顯示的卡片重疊或蓋到點就先不顯示
function pickLabels(items, W) {
  const pad = 3, prio = it => (it.t.id === S.panelTrack ? 0 : it.st.n ? 1 : 2);
  const order = [...items].sort((a, b) => prio(a) - prio(b) || a.py - b.py);
  const placed = [], shown = new Set();
  for (const it of order) {
    const r = { x0: it.lx - pad, y0: it.ly - pad, x1: it.lx + it.w + pad, y1: it.ly + it.h + pad };
    const hitLabel = placed.some(p => r.x0 < p.x1 && p.x0 < r.x1 && r.y0 < p.y1 && p.y0 < r.y1);
    // 「蓋到別的點」只在手機精簡模式才算；電腦版維持原樣，只避免卡片互相重疊
    const hitPin = labelsEl.classList.contains('compact') && items.some(p => p !== it && p.px > r.x0 && p.px < r.x1 && p.py > r.y0 && p.py < r.y1);
    if (!hitLabel && (!hitPin || prio(it) === 0)) { placed.push(r); shown.add(it.t.id); }
  }
  return shown;
}

// 標籤排斥：互不重疊、不蓋住賽道點，盡量靠近自己的點
function layoutLabels(items, W, H) {
  const compact = labelsEl.classList.contains('compact');
  compactTop = navInTopbar() ? 6 : compact ? 40 : 52; compactBottom = compact ? 38 : 4; // 小螢幕底部留給提示條
  const gapX = 8, gapY = 6, R = 12, OFF = 26;
  if (!items.length) return;
  // 從賽道群中心往外推：每個標籤放在自己的點「遠離中心」的那一側
  const cx = d3.mean(items, d => d.px), cy = d3.mean(items, d => d.py);
  for (const it of items) {
    let dx = it.px - cx, dy = it.py - cy; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    if (items.length === 1) { dx = 1; dy = -0.5; }
    it.tx = it.px + dx * OFF - (dx < 0 ? it.w : 0) + (Math.abs(dx) < 0.3 ? -it.w / 2 : 0);
    it.ty = it.py + dy * OFF - it.h / 2 + (dy < -0.7 ? -it.h / 2 : dy > 0.7 ? it.h / 2 : 0);
    it.lx = it.tx; it.ly = it.ty;
  }
  for (let k = 0; k < 500; k++) {
    const final = k >= 380; // 最後階段只處理標籤互撞，確保不重疊
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const ox = Math.min(a.lx + a.w, b.lx + b.w) - Math.max(a.lx, b.lx) + gapX;
        const oy = Math.min(a.ly + a.h, b.ly + b.h) - Math.max(a.ly, b.ly) + gapY;
        if (ox > 0 && oy > 0) {
          if (ox < oy) { const s = (a.lx + a.w / 2 < b.lx + b.w / 2) ? -1 : 1; a.lx += s * ox / 2; b.lx -= s * ox / 2; }
          else { const s = (a.ly + a.h / 2 < b.ly + b.h / 2) ? -1 : 1; a.ly += s * oy / 2; b.ly -= s * oy / 2; }
        }
      }
    }
    for (const it of items) {
      for (const p of final ? [] : items) {
        if (p.px > it.lx - R && p.px < it.lx + it.w + R && p.py > it.ly - R && p.py < it.ly + it.h + R) {
          const dl = p.px + R - it.lx, dr = it.lx + it.w + R - p.px, du = p.py + R - it.ly, dd = it.ly + it.h + R - p.py;
          const m = Math.min(dl, dr, du, dd);
          if (m === dl) it.lx += dl * 0.6; else if (m === dr) it.lx -= dr * 0.6;
          else if (m === du) it.ly += du * 0.6; else it.ly -= dd * 0.6;
        }
      }
      if (k < 300) { it.lx += (it.tx - it.lx) * 0.01; it.ly += (it.ty - it.ly) * 0.01; }
      it.lx = Math.max(4, Math.min(W - it.w - 4, it.lx));
      it.ly = Math.max(compactTop, Math.min(H - it.h - compactBottom, it.ly));
    }
  }
}

svg.on('click', async e => {
  if (!S.placing) return;
  const [x, y] = transform.invert(d3.pointer(e));
  const [lon, lat] = projection.invert([x, y]);
  const t = { ...S.placing, lat: +lat.toFixed(3), lon: +lon.toFixed(3) };
  S.placing = null;
  $('#placingHint').classList.add('hidden'); $('#map').classList.remove('placing');
  try { await Api.addTrack(t); toast(`已新增賽道：${t.zh}`); renderRegion(); }
  catch (err) { toast('新增失敗：' + err.message, 5000); }
});

// 下方「本區賽事紀錄」（仿遊戲 Available Event Races）
function renderEvents() {
  const recs = S.records.filter(r => trackById(r.trackId)?.region === S.region);
  const groups = {};
  for (const r of recs) (groups[`${r.trackId}|${r.event}|${r.layout}`] ||= []).push(r);
  const rows = Object.values(groups).map(rs => rs.sort(posCmp)[0]).sort(posCmp);
  $('#eventStrip').classList.toggle('empty', !rows.length);
  $('#eventGrid').innerHTML = rows.map(r => {
    const t = trackById(r.trackId);
    return `<div class="ev-row" data-track="${esc(r.trackId)}"><div class="ev-name">${esc(r.event || r.layout || t?.zh)}
      <small>${esc(r.layout || t?.zh || '')} · ${esc(carLabel(r.car))}</small></div>
      <div class="ev-pp">${(() => { const pp = r.ppLimit || eventOfRec(r)?.pp; return pp ? 'PP ' + esc(pp) : 'PP 不限'; })()}</div>${trophy(r.position)}</div>`;
  }).join('');
}
$('#eventGrid').addEventListener('click', e => { const r = e.target.closest('.ev-row'); if (r) gotoTrack(r.dataset.track); });

/* ───────────────────────── 賽道面板 ───────────────────────── */
function openPanel(id) {
  if (S.panelTrack !== id) S.panelEvent = null;
  S.panelTrack = id;
  renderPanel();
  $('#panel').classList.add('open');
  labelsEl.querySelectorAll('.tlabel').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  if (gPins) gPins.selectAll('g.pin').select('.sel-ring').style('display', d => d.t.id === id ? '' : 'none');
}
function closePanel() {
  S.panelTrack = null; $('#panel').classList.remove('open');
  labelsEl.querySelectorAll('.tlabel').forEach(el => el.classList.remove('active'));
  if (gPins) gPins.selectAll('.sel-ring').style('display', 'none');
}

const imgUrl = r => r.imageId ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(r.imageId)}&sz=w1600` : (r.imageData || '');
const posCmp = (a, b) => (+a.position || 99) - (+b.position || 99) || String(b.raceDate || '').localeCompare(String(a.raceDate || ''));

function renderPanel() {
  const t = trackById(S.panelTrack);
  if (!t) return closePanel();
  $('#panelFlag').innerHTML = flag(t.cc);
  $('#panelTitle').textContent = t.zh;
  $('#panelEn').textContent = t.en || '';
  const st = trackStatus(t.id);
  $('#panelCountry').textContent = `${t.country || ''}　·　${st.evTotal} 場賽事，拿過第一 ${st.evWon} 場`;
  const body = $('#panelBody');
  const evs = eventsOf(t.id);

  // ── 單一賽事明細 ──
  const cur = S.panelEvent && evs.find(e => evKey(e) === S.panelEvent);
  if (cur) {
    const rs = recsOfEvent(cur).sort(posCmp);
    body.innerHTML = `<button class="btn small" data-back>◀ 全部賽事</button>
      <div class="ev-detail">${evCard(cur, true)}</div>
      <button class="btn primary ev-add" data-addev="${esc(evKey(cur))}">＋ 記錄這場</button>
      ${rs.length ? `<h4 class="others-h">全部紀錄 ${rs.length} 筆（依名次、日期排序；每筆都可以單獨編輯或刪除）</h4>
        <div class="group">${rs.map((r, i) => recRow(r, i === 0)).join('')}</div>` : '<div class="empty">這場還沒有紀錄</div>'}`;
    return;
  }

  // ── 賽事卡片（像遊戲裡點進賽道看到的那排） ──
  const order = c => c.best ? (c.best.position == 1 ? 0 : 1) : 2;
  const cards = evs.map(e => ({ e, best: recsOfEvent(e).sort(posCmp)[0] }))
    .sort((a, b) => order(a) - order(b) || a.e.n.localeCompare(b.e.n));
  const others = S.records.filter(r => r.trackId === t.id && !eventOfRec(r)).sort(posCmp);
  body.innerHTML = (cards.length ? `<div class="ev-grid">${cards.map(c => evCard(c.e, false, c.best)).join('')}</div>` : '')
    + (others.length ? `<h4 class="others-h">其他紀錄（對不到賽事清單）</h4><div class="group">${others.map(r => recRow(r, false, true)).join('')}</div>` : '')
    + (!cards.length && !others.length ? '<div class="empty">這條賽道還沒有紀錄</div>' : '');
}

function evCard(e, big, best) {
  if (best === undefined) best = recsOfEvent(e).sort(posCmp)[0];
  const p = best ? +best.position : 0;
  return `<div class="evcard ${p === 1 ? 'won' : best ? 'tried' : 'new'} ${big ? 'big' : ''}" data-ev="${esc(evKey(e))}">
    <div class="ec-top">${esc(evMeta(e))}</div>
    <div class="ec-name">${esc(e.n)}</div>
    <div class="ec-lo">${esc(e.l)}</div>
    ${e.cars || e.tyres ? `<div class="ec-rule">${esc([e.cars, e.tyres].filter(Boolean).join(' · '))}</div>` : ''}
    <div class="ec-res">${best ? `${trophy(best.position)}<div class="ec-car"><div>${esc(carLabel(best.car))}</div><small>${esc(best.time || '')}</small></div>${(() => { const n = recsOfEvent(e).length; return n > 1 && !big ? `<span class="ec-n">共 ${n} 筆</span>` : ''; })()}`
      : '<span class="ec-none">尚未紀錄</span>'}</div>
  </div>`;
}

function recRow(r, isBest, showEvent) {
  const url = imgUrl(r);
  return `<div class="rec ${isBest ? 'best' : ''}">
    ${trophy(r.position)}
    ${url ? `<img class="thumb" src="${esc(url)}" data-full="${esc(url)}" alt="" loading="lazy">` : ''}
    <div class="info">
      <div class="car">${esc(carLabel(r.car))}<span class="src">${r.source === 'ai' ? 'AI' : '手動'}</span></div>
      ${showEvent ? `<div class="meta">${esc([r.event || '（未填賽事）', r.layout].filter(Boolean).join(' · '))}</div>` : ''}
      <div class="meta">${[r.time, r.totalCars ? `${r.position}/${r.totalCars}` : '', r.laps ? r.laps + ' 圈' : '', r.raceDate].filter(Boolean).map(esc).join('　·　')}</div>
      ${r.fastestLap ? `<div class="meta">最速圈 ${esc(r.fastestLap)}</div>` : ''}
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
    </div>
    <div class="ops"><button data-edit="${esc(r.id)}">編輯</button><button data-del="${esc(r.id)}">刪除</button></div>
  </div>`;
}

$('#panelBody').addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.full) return showLightbox(t.dataset.full);
  if (t.closest('[data-back]')) { S.panelEvent = null; return renderPanel(); }
  const add = t.closest('[data-addev]');
  if (add) {
    const ev = EVENTS.find(x => evKey(x) === add.dataset.addev);
    S.formQueue = [{ source: 'manual', allowAttach: true, prefill: { trackId: ev.t, layout: ev.l, event: ev.n, ppLimit: ev.pp || '', laps: ev.laps || '' } }];
    formTotal = 0; return openNextForm();
  }
  const card = t.closest('.evcard:not(.big)');
  if (card) { S.panelEvent = card.dataset.ev; return renderPanel(); }
  if (t.dataset.edit) {
    const r = S.records.find(x => x.id === t.dataset.edit);
    S.formQueue = [{ edit: r, source: r.source, image: r.imageId || r.imageData ? { full: imgUrl(r), imageId: r.imageId, thumb: r.imageData, hash: r.imageHash } : null }];
    formTotal = 0; return openNextForm();
  }
  if (t.dataset.del) {
    if (!confirm('確定刪除這筆紀錄？（截圖也會一起丟進雲端硬碟垃圾桶，30 天內可還原）')) return;
    try { await Api.deleteRecord(t.dataset.del); refreshAll(); toast('已刪除'); }
    catch (err) { toast('刪除失敗：' + err.message, 5000); }
  }
});

/* ───────────────────────── 截圖處理 ───────────────────────── */
function loadImage(file) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img); img.onerror = () => fail(new Error('讀不到圖片'));
    img.src = URL.createObjectURL(file);
  });
}
function toJpeg(img, maxW, q) {
  const s = Math.min(1, maxW / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
async function hashFile(file) {
  const buf = await file.arrayBuffer();
  if (crypto.subtle) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 7) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  return 'f' + h.toString(16) + u.length.toString(16);
}
async function prepImage(file) {
  const [hash, img] = await Promise.all([hashFile(file), loadImage(file)]);
  const full = toJpeg(img, 1600, 0.85);
  return { hash, full, thumb: toJpeg(img, 720, 0.6), data: full.split(',')[1], mime: 'image/jpeg' };
}
const aiTrackContext = () => allTracks().map(t => ({ id: t.id, zh: t.zh, en: t.en || '', layouts: t.layouts,
  events: eventsOf(t.id).map(e => [e.n, e.l, e.laps || '']) }));

async function handleFiles(files) {
  files = [...files]; if (!files.length) return;
  let queued = 0, dup = 0;
  for (let i = 0; i < files.length; i++) {
    let img;
    try { img = await prepImage(files[i]); } catch (e) { toast(e.message); continue; }
    if (S.records.some(r => r.imageHash === img.hash)) { dup++; continue; }
    if (!Api.remote()) { S.formQueue.push({ image: img, source: 'manual' }); continue; }

    toast(`🤖 辨識中… ${i + 1} / ${files.length}`, 60000);
    try {
      const j = await Api.post('recognize', {
        data: img.data, mime: img.mime, hash: img.hash,
        playerName: S.settings.playerName || '', tracks: aiTrackContext(),
      });
      if (j.status === 'duplicate' || j.status === 'queued_already') { dup++; continue; }
      img.imageId = j.imageId;
      if (j.status === 'ok') S.formQueue.push({ image: img, prefill: j.result, source: 'ai' });
      else if (j.status === 'queued') queued++;
      else S.formQueue.push({ image: img, source: 'manual', warn: 'AI 辨識失敗，請手動填：' + (j.error || '') });
    } catch (e) {
      S.formQueue.push({ image: img, source: 'manual', warn: '連不到後端，請手動填：' + e.message });
    }
  }
  hideToast();
  const msg = [];
  if (dup) msg.push(`${dup} 張已經記過，略過`);
  if (queued) { msg.push(`Gemini 額度用完，${queued} 張已排入「待確認」，之後自動辨識`); await Api.load().catch(() => {}); renderTopbar(); }
  if (msg.length) toast(msg.join('；'), 5000);
  openNextForm();
}

/* ───────────────────────── 紀錄表單 ───────────────────────── */
const form = $('#recForm');

function fillTrackSelect() {
  form.trackId.innerHTML = '<option value="">— 選擇賽道 —</option>' + REGIONS.map(r =>
    `<optgroup label="${esc(r.name)}">${allTracks().filter(t => t.region === r.id)
      .map(t => `<option value="${esc(t.id)}">${esc(t.zh)}${t.en ? '　' + esc(t.en) : ''}</option>`).join('')}</optgroup>`).join('');
}
function fillLayouts(keep) {
  const t = trackById(form.trackId.value);
  const opts = (t?.layouts || []).map(l => l[0]);
  const used = S.records.filter(r => r.trackId === form.trackId.value).map(r => r.layout);
  const all = [...new Set([...opts, ...used, keep].filter(Boolean))];
  form.layout.innerHTML = '<option value="">（未指定）</option>' + all.map(z => {
    const en = t?.layouts.find(l => l[0] === z)?.[1];
    return `<option value="${esc(z)}">${esc(z)}${en ? '　' + esc(en) : ''}</option>`;
  }).join('');
  form.layout.value = keep && all.includes(keep) ? keep : (opts.length === 1 ? opts[0] : '');
}
function fillDatalists() {
  const uniq = arr => [...new Set(arr.filter(Boolean))].sort();
  fillCarList(); // 車名選項＝官方 580 台清單（garage.js）
  fillEventList();
}
// 賽事名稱的選項：先列這條賽道的賽事（含配置與圈數提示），再列其他用過的名稱
function fillEventList() {
  const evs = eventsOf(form.trackId.value);
  const used = [...new Set(S.records.map(r => r.event).filter(Boolean))].filter(n => !evs.some(e => e.n === n));
  $('#dlEvents').innerHTML = evs.map(e => `<option value="${esc(e.n)}" label="${esc(e.l + ' · ' + evMeta(e))}">`).join('')
    + used.map(v => `<option value="${esc(v)}">`).join('');
}
form.trackId.addEventListener('change', () => { fillLayouts(); fillEventList(); });
// 選了賽事 → 自動帶入配置、PP 上限、圈數（同名賽事在這條賽道有多個配置時，以目前選的配置為準）
form.event.addEventListener('change', () => {
  const c = eventsOf(form.trackId.value).filter(e => normEv(e.n) === normEv(form.event.value));
  const e = c.find(x => x.l === form.layout.value) || c[0];
  if (!e) return;
  form.event.value = e.n;
  fillLayouts(e.l);
  form.ppLimit.value = e.pp || '';
  if (e.laps && !form.laps.value) form.laps.value = e.laps;
});

let formTotal = 0;
function openNextForm() {
  const item = S.formQueue.shift();
  if (!item) { $('#formModal').classList.add('hidden'); formTotal = 0; return; }
  formTotal = Math.max(formTotal, S.formQueue.length + 1);
  S.formCur = item;
  form.reset(); fillTrackSelect(); fillDatalists();

  const p = item.edit || item.prefill || {};
  let trackId = p.trackId || item.trackId || '';
  if (trackId && !trackById(trackId)) trackId = '';
  form.trackId.value = trackId;
  fillLayouts(p.layout || ''); fillEventList();
  const v = { event: p.event, ppLimit: p.ppLimit, position: p.position, totalCars: p.totalCars, raceDate: p.raceDate || today(),
    car: p.car, time: p.time, laps: p.laps, fastestLap: p.fastestLap, note: p.note };
  for (const [k, val] of Object.entries(v)) if (form[k] && val != null) form[k].value = val;
  if (!v.ppLimit && v.event) form.event.dispatchEvent(new Event('change'));
  // 車名：對得到清單就換成標準名稱；編輯清單外的舊紀錄時預設勾「清單外」，可以不改直接存
  form.carCustom.checked = !!(item.edit && p.car && !carOf(p.car));
  updateCarHint(true);

  const img = item.image;
  $('#formImg').src = img?.full || '';
  $('.form-grid').classList.toggle('noimg', !img && !item.allowAttach);
  $('#formImgWrap').style.display = img || item.allowAttach ? '' : 'none';

  const isAi = item.source === 'ai' && !item.edit;
  $('#formTitle').textContent = item.edit ? '編輯紀錄' : isAi ? '確認 AI 辨識結果' : '新增紀錄';
  const badge = $('#formBadge');
  badge.className = 'badge' + (isAi ? ' ai' : '');
  badge.textContent = isAi ? '🤖 AI 已填好，請核對' : item.edit ? '' : img ? '手動填寫（截圖對照）' : '手動輸入';
  let prog = formTotal > 1 ? `第 ${formTotal - S.formQueue.length} / ${formTotal} 張` : '';
  if (item.warn) prog = `⚠ ${item.warn}　${prog}`;
  if (isAi && p.trackName && !trackId) prog = `⚠ AI 讀到賽道「${p.trackName}」，對不到清單，請手動選　${prog}`;
  $('#formProgress').textContent = prog;
  $('#formSkip').style.display = formTotal > 1 ? '' : 'none';
  $('#formModal').classList.remove('hidden');
}
$('#formSkip').onclick = () => openNextForm();

$('#formImgInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const img = await prepImage(f);
  S.formCur.image = img;
  $('#formImg').src = img.full;
};
const openManual = trackId => { S.formQueue = [{ source: 'manual', trackId: trackId || '', allowAttach: true }]; formTotal = 0; openNextForm(); };
$('#btnManual').onclick = () => openManual(S.panelTrack);
$('#panelAdd').onclick = () => openManual(S.panelTrack);

form.onsubmit = async e => {
  e.preventDefault();
  const item = S.formCur, fd = Object.fromEntries(new FormData(form));
  const car = carForSave();
  if (!car) { toast('車名對不到官方清單：請從下方候選點一台，或勾選「清單沒有這台」', 5000); form.car.focus(); return; }
  const btn = form.querySelector('[type=submit]'); btn.disabled = true;
  try {
    const img = item.image;
    let imageId = img?.imageId || '', imageData = '';
    if (img && !imageId) {
      if (Api.remote()) imageId = (await Api.post('saveImage', { data: img.data, mime: img.mime, hash: img.hash })).imageId;
      else imageData = img.thumb;
    }
    const base = item.edit || {};
    const rec = {
      ...base,
      id: base.id || uid(), createdAt: base.createdAt || new Date().toISOString(),
      trackId: fd.trackId, layout: fd.layout || '', event: fd.event.trim(), ppLimit: fd.ppLimit,
      position: fd.position, totalCars: fd.totalCars, raceDate: fd.raceDate, car,
      time: fd.time.trim(), laps: fd.laps, fastestLap: fd.fastestLap.trim(), note: fd.note.trim(),
      imageId, imageHash: img?.hash || base.imageHash || '',
      source: item.edit ? base.source : item.source,
    };
    if (imageData) rec.imageData = imageData;
    if (!imageId && !imageData && base.imageData) rec.imageData = base.imageData;
    await Api.saveRecord(rec, item.queueId);
    toast(`已儲存：${trackById(rec.trackId)?.zh || ''} 第 ${rec.position} 名`);
    const more = S.formQueue.length;
    if (!more) gotoTrack(rec.trackId); else refreshAll();
    openNextForm();
  } catch (err) { toast('儲存失敗：' + err.message, 6000); }
  finally { btn.disabled = false; }
};

/* ───────────────────────── 待確認清單 ───────────────────────── */
function renderQueue() {
  $('#queueList').innerHTML = S.queue.length ? S.queue.map(q => {
    const url = q.imageId ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(q.imageId)}&sz=w400` : '';
    const st = q.status === 'ready' ? '✅ 已辨識，待確認' : q.status === 'failed' ? '❌ 辨識失敗：' + esc(q.error || '') : '⏳ 等待額度重置';
    return `<div class="qitem">${url ? `<img src="${url}" alt="">` : ''}<div class="info">${st}<div class="muted">${esc(String(q.createdAt || '').slice(0, 16).replace('T', ' '))}</div></div>
      <button class="btn small ${q.status === 'ready' ? 'primary' : ''}" data-q="${esc(q.id)}">${q.status === 'ready' ? '確認' : '手動填'}</button></div>`;
  }).join('') : '<div class="empty">沒有待確認的截圖</div>';
}
$('#btnQueue').onclick = () => { renderQueue(); $('#queueModal').classList.remove('hidden'); };
$('#queueList').addEventListener('click', e => {
  const id = e.target.dataset.q; if (!id) return;
  const q = S.queue.find(x => x.id === id);
  let prefill = null; try { prefill = q.result ? (typeof q.result === 'string' ? JSON.parse(q.result) : q.result) : null; } catch { }
  const full = `https://drive.google.com/thumbnail?id=${encodeURIComponent(q.imageId)}&sz=w1600`;
  S.formQueue = [{ queueId: q.id, prefill, source: prefill ? 'ai' : 'manual', image: { full, imageId: q.imageId, hash: q.imageHash } }];
  formTotal = 0;
  $('#queueModal').classList.add('hidden');
  openNextForm();
});
$('#btnRetryQueue').onclick = async () => {
  toast('🔄 重試辨識中…', 60000);
  try { const j = await Api.post('processQueue'); await Api.load(); renderQueue(); renderTopbar(); toast(`完成：${j.done || 0} 張辨識好，${j.left || 0} 張仍在等待`, 4000); }
  catch (err) { toast('失敗：' + err.message, 5000); }
};

/* ───────────────────────── 設定 ───────────────────────── */
const sf = $('#settingsForm'), tf = $('#trackForm');
$('#btnSettings').onclick = () => {
  // 顯示目前載入的版本與開啟方式，方便確認 iPhone 是否抓到新版
  $('#verInfo').textContent = `版本 v${(document.querySelector('script[src^="app.js"]')?.getAttribute('src') || '').split('v=')[1] || '?'} · ${document.documentElement.classList.contains('standalone') ? '主畫面模式' : '瀏覽器模式'}`;
  for (const k of ['playerName', 'apiUrl', 'pass']) sf[k].value = S.settings[k] || '';
  tf.region.innerHTML = REGIONS.map(r => `<option value="${r.id}" ${r.id === S.region ? 'selected' : ''}>${r.name}</option>`).join('');
  $('#settingsModal').classList.remove('hidden');
};
sf.onsubmit = async e => {
  e.preventDefault();
  S.settings = { playerName: sf.playerName.value.trim(), apiUrl: sf.apiUrl.value.trim(), pass: sf.pass.value };
  localStorage.setItem(LS_SETTINGS, JSON.stringify(S.settings));
  $('#settingsModal').classList.add('hidden');
  await boot();
};
tf.onsubmit = e => {
  e.preventDefault();
  const zh = tf.zh.value.trim();
  const layouts = tf.layouts.value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  S.placing = {
    id: 'c-' + uid(), zh, en: tf.en.value.trim(), region: tf.region.value,
    country: tf.country.value.trim(), cc: tf.cc.value.trim().toLowerCase(),
    layouts: (layouts.length ? layouts : [zh]).map(z => [z, '']),
  };
  tf.reset();
  $('#settingsModal').classList.add('hidden');
  enterRegion(S.placing.region);
  toast('可用上方子區域切換、或縮放地圖找到位置', 4000);
  $('#placingHint').classList.remove('hidden'); $('#map').classList.add('placing');
};
$('#cancelPlace').onclick = () => { S.placing = null; $('#placingHint').classList.add('hidden'); $('#map').classList.remove('placing'); };
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: S.records, customTracks: S.customTracks }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `gt7-戰績-${today()}.json`; a.click();
};

/* ───────────────────────── 共用 ───────────────────────── */
let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').classList.add('hidden'); }
function showLightbox(url) { const lb = $('#lightbox'); $('img', lb).src = url; lb.classList.remove('hidden'); }
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');
$('#formImg').onclick = e => e.target.src && showLightbox(e.target.src);
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal').classList.add('hidden'));
$('#panelClose').onclick = closePanel;
$('#btnBack').onclick = showWorld;
$('#btnHome').onclick = showHome;
$('#goWorld').onclick = showWorld;
$('#goGarage').onclick = () => showGarage();
$('#fileInput').onchange = e => { handleFiles(e.target.files).finally(() => { e.target.value = ''; }); };

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); handleFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('image/'))); });
window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(() => { placeNav(); if (S.screen === 'world') renderGlobe(); else if (S.screen === 'region') renderMap(); else if (S.screen === 'home') renderHomeGlobe(); }, 150); });

function refreshAll() {
  renderTopbar();
  if (S.screen === 'home') renderHome(); else if (S.screen === 'world') renderWorld(); else if (S.screen === 'garage') renderGarage(); else renderRegion();
  if (S.panelTrack) renderPanel();
}

async function boot() {
  renderBanner(); tickClock();
  try { await Api.load(); }
  catch (e) { toast('讀取資料失敗：' + e.message + '（請檢查 ⚙ 設定）', 8000); }
  if (!world) { try { await loadWorld(); } catch (e) { toast('地圖載入失敗，請檢查網路', 6000); } }
  if (S.screen === 'home') showHome(); else if (S.screen === 'world') showWorld(); else if (S.screen === 'garage') showGarage(); else renderRegion();
  if (!S.settings.playerName) toast('第一次使用：請先到 ⚙ 設定填入遊戲內的玩家名稱', 6000);
}
setInterval(tickClock, 30000);
bindCarField(); bindGarage(); // garage.js
boot();
