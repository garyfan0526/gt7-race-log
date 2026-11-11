/**
 * GT7 賽事戰績簿 — Google Apps Script 後端
 *
 * 第一次部署：
 *  1. 專案設定 → 指令碼屬性，新增：
 *       GEMINI_API_KEY = 你的 Gemini 金鑰
 *       PASSCODE       = 自訂通關密碼（前端 ⚙ 設定要填一樣的）
 *     （可選）GEMINI_MODELS = gemini-flash-latest,gemini-flash-lite-latest   ← 依序嘗試，額度滿就換下一個
 *  2. 在編輯器選 setup 函式按「執行」，授權後會建立 Sheet、Drive 資料夾、每小時排程。
 *  3. 部署 → 新增部署作業 → 網頁應用程式：執行身分「我」、存取權「所有人」→ 複製 /exec 網址貼到前端設定。
 */

const SHEET_REC = '紀錄', SHEET_TRK = '自訂賽道', SHEET_Q = '排隊';
const REC_COLS = ['id', 'createdAt', 'raceDate', 'trackId', 'layout', 'event', 'ppLimit', 'position', 'totalCars',
  'car', 'time', 'laps', 'fastestLap', 'note', 'imageId', 'imageHash', 'source'];
const TRK_COLS = ['id', 'zh', 'en', 'country', 'cc', 'region', 'lat', 'lon', 'layouts'];
const Q_COLS = ['id', 'createdAt', 'imageId', 'imageHash', 'status', 'result', 'error', 'context'];
const DEFAULT_MODELS = 'gemini-flash-latest,gemini-flash-lite-latest';

const props = () => PropertiesService.getScriptProperties();

/* ───────── 初始化 ───────── */
function setup() {
  const p = props();
  let ss;
  if (p.getProperty('SHEET_ID')) ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
  else { ss = SpreadsheetApp.create('GT7 賽事紀錄'); p.setProperty('SHEET_ID', ss.getId()); }
  ensureSheet_(ss, SHEET_REC, REC_COLS);
  ensureSheet_(ss, SHEET_TRK, TRK_COLS);
  ensureSheet_(ss, SHEET_Q, Q_COLS);
  const def = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (!p.getProperty('FOLDER_ID')) p.setProperty('FOLDER_ID', DriveApp.createFolder('GT7 截圖').getId());

  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processQueue')) {
    ScriptApp.newTrigger('processQueue').timeBased().everyHours(1).create();
  }
  Logger.log('Sheet：' + ss.getUrl());
  Logger.log('Drive 資料夾：' + DriveApp.getFolderById(p.getProperty('FOLDER_ID')).getUrl());
  if (!p.getProperty('GEMINI_API_KEY')) Logger.log('⚠ 還沒設定 GEMINI_API_KEY');
  if (!p.getProperty('PASSCODE')) Logger.log('⚠ 還沒設定 PASSCODE');
}

function ensureSheet_(ss, name, cols) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(cols); sh.setFrozenRows(1); }
  return sh;
}
const ss_ = () => SpreadsheetApp.openById(props().getProperty('SHEET_ID'));
const sheet_ = name => ss_().getSheetByName(name);

/* ───────── HTTP 入口 ───────── */
function doGet() { return json_({ ok: true, msg: 'GT7 race log API' }); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const pass = props().getProperty('PASSCODE');
    if (!pass || req.pass !== pass) throw new Error('通關密碼錯誤');
    const fn = ACTIONS[req.action];
    if (!fn) throw new Error('未知的動作：' + req.action);
    return json_(Object.assign({ ok: true }, fn(req)));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}
const json_ = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

const ACTIONS = {
  list() {
    return {
      records: readAll_(SHEET_REC, REC_COLS),
      customTracks: readAll_(SHEET_TRK, TRK_COLS),
      queue: readAll_(SHEET_Q, Q_COLS).map(q => { delete q.context; return q; }),
    };
  },

  save(req) {
    const rec = req.record;
    if (!rec || !rec.id) throw new Error('缺少紀錄');
    delete rec.imageData;
    withLock_(() => {
      upsert_(SHEET_REC, REC_COLS, rec);
      if (req.queueId) deleteRow_(SHEET_Q, req.queueId);
    });
    return { record: rec };
  },

  delete(req) { withLock_(() => deleteRow_(SHEET_REC, req.id)); return {}; },

  addTrack(req) {
    const t = Object.assign({}, req.track);
    if (Array.isArray(t.layouts)) t.layouts = t.layouts.map(l => Array.isArray(l) ? l[0] : l).join('|');
    withLock_(() => upsert_(SHEET_TRK, TRK_COLS, t));
    return {};
  },

  saveImage(req) { return { imageId: saveImage_(req.data, req.mime, req.hash) }; },

  recognize(req) {
    const dupRec = readAll_(SHEET_REC, REC_COLS).find(r => r.imageHash && r.imageHash === req.hash);
    if (dupRec) return { status: 'duplicate', record: dupRec };
    if (readAll_(SHEET_Q, Q_COLS).some(q => q.imageHash === req.hash)) return { status: 'queued_already' };

    const imageId = saveImage_(req.data, req.mime, req.hash);
    const context = { playerName: req.playerName || '', tracks: req.tracks || [] };
    try {
      const result = recognize_(req.data, req.mime, context);
      return { status: 'ok', imageId, result };
    } catch (err) {
      if (err.quota) {
        withLock_(() => appendRow_(SHEET_Q, Q_COLS, {
          id: Utilities.getUuid(), createdAt: new Date().toISOString(), imageId, imageHash: req.hash,
          status: 'pending', result: '', error: '', context: JSON.stringify(context),
        }));
        return { status: 'queued', imageId };
      }
      return { status: 'error', imageId, error: String(err.message || err) };
    }
  },

  processQueue() { return processQueue(); },
};

/* ───────── 排隊自動重試（每小時觸發） ───────── */
function processQueue() {
  const items = readAll_(SHEET_Q, Q_COLS).filter(q => q.status === 'pending');
  let done = 0;
  for (const q of items) {
    try {
      const blob = DriveApp.getFileById(q.imageId).getBlob();
      const result = recognize_(Utilities.base64Encode(blob.getBytes()), blob.getContentType(), JSON.parse(q.context || '{}'));
      withLock_(() => upsert_(SHEET_Q, Q_COLS, Object.assign(q, { status: 'ready', result: JSON.stringify(result), error: '' })));
      done++;
    } catch (err) {
      if (err.quota) break; // 額度還沒恢復，下次再試
      withLock_(() => upsert_(SHEET_Q, Q_COLS, Object.assign(q, { status: 'failed', error: String(err.message || err) })));
    }
  }
  return { done, left: items.length - done };
}

/* ───────── Gemini 辨識 ───────── */
function recognize_(b64, mime, ctx) {
  const key = props().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('後端還沒設定 GEMINI_API_KEY');
  const trackList = (ctx.tracks || []).map(t => {
    const lays = (t.layouts || []).map(l => Array.isArray(l) ? (l[1] ? `${l[0]}（${l[1]}）` : l[0]) : l).join(' / ');
    return `- ${t.id}: ${t.zh}${t.en ? ' / ' + t.en : ''}${lays ? '\n    配置: ' + lays : ''}`;
  }).join('\n');

  const prompt = `這是 Gran Turismo 7（跑車浪漫旅 7）的比賽結算畫面截圖，介面可能是中文或英文。請讀出以下資料，只回傳 JSON。

玩家本人在遊戲裡的名稱是「${ctx.playerName || '（未提供）'}」。結算表中玩家本人那一列的名字通常用金色／黃色字顯示（和其他白色名字不同）。
請找出玩家本人那一列，回報他的名次、車輛、時間欄位。若名稱對不上，以金色／黃色字那一列為準。

欄位說明：
- event：畫面上方的賽事名稱（例如 World Touring Car 800）
- trackName：畫面上看到的賽道／佈局原文（例如 Spa 24h Layout）
- trackId：從下方賽道清單中挑出最符合的 id（畫面可能顯示中文或英文名稱）；真的找不到就給空字串
- layout：從該賽道的「配置」清單中挑最符合的，回傳括號前的中文名稱；清單沒有就照畫面原文
- position：玩家名次（整數）
- totalCars：結算表總共幾列（整數）
- car：玩家車輛名稱，照畫面原文
- time：玩家那一列 Time 欄的原文（第一名是總時間，其他是 +差距 或 "1 Lap"）
- laps：圈數（畫面下方 Laps 的數字，沒有就給 0）
- fastestLap：最速圈「車手名 時間」，例如 "I. Fraga 2:14.130"
- ppLimit：賽事名稱或畫面上的 PP 上限數字，沒有就給 0

賽道清單：
${trackList}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      event: { type: 'STRING' }, trackName: { type: 'STRING' }, trackId: { type: 'STRING' }, layout: { type: 'STRING' },
      position: { type: 'INTEGER' }, totalCars: { type: 'INTEGER' }, car: { type: 'STRING' }, time: { type: 'STRING' },
      laps: { type: 'INTEGER' }, fastestLap: { type: 'STRING' }, ppLimit: { type: 'INTEGER' },
    },
    required: ['event', 'trackName', 'trackId', 'layout', 'position', 'totalCars', 'car', 'time'],
  };
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime || 'image/jpeg', data: b64 } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
  };

  const models = (props().getProperty('GEMINI_MODELS') || DEFAULT_MODELS).split(',').map(s => s.trim()).filter(Boolean);
  let lastMsg = '';
  for (const m of models) {
    const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    const code = res.getResponseCode(), text = res.getContentText();
    if (code === 200) {
      const j = JSON.parse(text);
      const out = JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
      ['laps', 'ppLimit'].forEach(k => { if (!out[k]) out[k] = ''; });
      out.model = m;
      return out;
    }
    lastMsg = `${m} → ${code}`;
    if (code === 429 || code === 503 || code === 404) continue; // 額度滿 / 忙碌 / 模型下架 → 換下一個
    throw new Error(`Gemini ${code}: ${text.slice(0, 300)}`);
  }
  const err = new Error('Gemini 額度用完或暫時無法使用（' + lastMsg + '）');
  err.quota = true;
  throw err;
}

/* ───────── Drive ───────── */
function saveImage_(b64, mime, hash) {
  const folder = DriveApp.getFolderById(props().getProperty('FOLDER_ID'));
  const name = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '-' + String(hash || '').slice(0, 8) + '.jpg';
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime || 'image/jpeg', name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); // 前端縮圖要能直接顯示
  return file.getId();
}

/* ───────── Sheet 工具 ───────── */
function readAll_(name, cols) {
  const sh = sheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, cols.length).getDisplayValues()
    .map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])))
    .filter(o => o.id);
}
// 一律存成純文字，避免 Sheet 把 1:01:36.266、日期、+47.427 自動轉格式
function writeRow_(sh, r, cols, obj) {
  sh.getRange(r, 1, 1, cols.length).setNumberFormat('@')
    .setValues([cols.map(c => obj[c] == null ? '' : String(obj[c]))]);
}
function appendRow_(name, cols, obj) {
  const sh = sheet_(name);
  writeRow_(sh, sh.getLastRow() + 1, cols, obj);
}
function findRow_(name, id) {
  const sh = sheet_(name), n = sh.getLastRow();
  if (n < 2) return -1;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues().map(r => String(r[0]));
  const i = ids.indexOf(String(id));
  return i < 0 ? -1 : i + 2;
}
function upsert_(name, cols, obj) {
  const r = findRow_(name, obj.id);
  if (r < 0) appendRow_(name, cols, obj);
  else writeRow_(sheet_(name), r, cols, obj);
}
function deleteRow_(name, id) {
  const r = findRow_(name, id);
  if (r > 0) sheet_(name).deleteRow(r);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
