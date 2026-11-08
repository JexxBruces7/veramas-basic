// Veramas - server lokal untuk Indodax
// Menyimpan API key di komputer Anda, mengambil data real-time Indodax,
// menjalankan bot, dan mengirim order (mode simulasi atau live).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const IND = require('./public/ind.js'); // indikator: dipakai bot dan chart

// ---------- konfigurasi (.env) ----------
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* .env opsional */ }
}
loadEnv(path.join(__dirname, '.env'));
const E = process.env;
const EDITION = 'basic'; // paket: basic | pro | max (tetap, tidak dibaca dari .env)
const BASIC_BLOCK = /^\/api\/(order|sell|close|deposit|limit|backtest|cancel|botdash|botlog\/clear|reset|connect|link|unlink|links\/refresh|disconnect|x\/(order|orders|cancel)|dex\/(jup\/swap|kyber\/build|log))(\/|$)/;
const CFG = {
  port: +E.PORT || 3000,
  host: E.HOST || '127.0.0.1',
  key: (E.INDODAX_API_KEY || '').trim(),
  secret: (E.INDODAX_SECRET_KEY || '').trim(),
  live: String(E.LIVE_TRADING || 'false').toLowerCase() === 'true',
  paperIdr: +E.PAPER_BALANCE_IDR || 10000000,
  maxOrder: null, // ukuran trade bot tidak dibatasi (dulu MAX_ORDER_IDR); batas rugi harian tetap berlaku
  dailyLoss: +E.DAILY_LOSS_LIMIT_IDR || 200000,
  base: (E.INDODAX_BASE || 'https://indodax.com').replace(/\/$/, ''),
  base2: (E.INDODAX_API2_BASE || 'https://api.indodax.com').replace(/\/$/, ''), // Trade API V2
  wsUrl: E.INDODAX_WS || 'wss://ws3.indodax.com/ws/',
  wsToken: E.INDODAX_WS_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE5NDY2MTg0MTV9.UR1lBM6Eqh0yWz-PVirw1uPCxe60FdchR8eNVdsskeo',
  dataDir: E.DATA_DIR || path.join(__dirname, 'data'),
};
let LIVE = CFG.live && !!CFG.key && !!CFG.secret;
if (CFG.live && !LIVE) console.warn('⚠️  LIVE_TRADING=true tetapi API key/secret kosong. Bot berjalan dalam mode SIMULASI.');
// Lisensi: mode simulasi gratis; mode LIVE dan order beli baru butuh lisensi aktif (lihat license.js).
const LIC_MSG = 'Lisensi tidak aktif: order beli LIVE diblokir. Aktifkan atau perpanjang lisensi di menu Lisensi. Mode simulasi tetap bisa dipakai, dan order jual untuk menutup posisi tetap berjalan.';
const LIC = require('./license').createLicense({ dataDir: CFG.dataDir, serverUrl: E.LICENSE_SERVER || '', graceDays: +E.LICENSE_GRACE_DAYS || 30,
  version: (() => { try { return require('./package.json').version || 'dev'; } catch (e) { return 'dev'; } })(), onChange: () => { try { pushState(); } catch (e) { } } });
if (LIVE && !LIC.canLive()) { LIVE = false; console.warn('⚠️  Lisensi tidak aktif: LIVE_TRADING diabaikan, berjalan dalam mode SIMULASI. Aktifkan lisensi lewat menu Lisensi.'); }

let WSImpl = null;
try { WSImpl = require('ws'); } catch (e) { WSImpl = globalThis.WebSocket || null; }

// timeframe: sec = lebar candle; src = timeframe sumber di Indodax bila harus digabung (2J dari 1J; 3H dan 1M dari 1H)
const TF_DEF = { '1': { sec: 60 }, '15': { sec: 900 }, '30': { sec: 1800 }, '60': { sec: 3600 }, '120': { sec: 7200, src: '60' }, '240': { sec: 14400 },
  '1D': { sec: 86400 }, '3D': { sec: 259200, src: '1D' }, '1W': { sec: 604800, src: '1D' } };
const TF_SEC = Object.fromEntries(Object.entries(TF_DEF).map(([k, v]) => [k, v.sec]));
const WIB = 7 * 3600;
// awal candle yang memuat ts. Hari dan pekan mengikuti WIB (pekan mulai Senin)
// simbol non-Indodax: hanya untuk dilihat di chart & compare, tidak bisa ditradingkan
const EXT = { usdtd: { id: 'usdtd', coin: 'usdt.d', symbol: 'USDT.D', desc: 'USDT Dominance: porsi USDT dari total market cap kripto (%)', ext: true } };
// aset non-kripto dari Yahoo Finance (saham IDX, forex, komoditas, properti): id = 'yh:' + simbol Yahoo, mis. yh:BBCA.JK
const YH_RE = /^yh:[\^A-Za-z0-9=.\-]{1,24}$/;
const extOf = id => EXT[id] || (YH_RE.test(String(id || '')) ? (EXT[id] = { id, coin: id.slice(3), symbol: id.slice(3).replace(/\.JK$/, '').replace(/=X$/, '').replace(/=F$/, ''), desc: id.slice(3), ext: true, yahoo: id.slice(3) }) : null);
const chartPair = id => (typeof PAIRS !== 'undefined' && PAIRS[id]) || extOf(id) || null;
const pairIdOk = id => /^[a-z0-9]{2,20}$/.test(id) || YH_RE.test(id);
function bucketOf(ts, tf) {
  const sec = TF_SEC[tf] || 60;
  if (tf === '3D') return Math.floor((ts + WIB) / sec) * sec - WIB;
  if (tf === '1W') { const d = Math.floor((ts + WIB) / 86400), mon = d - ((d + 3) % 7); return mon * 86400 - WIB; }
  return Math.floor(ts / sec) * sec;
}
function aggregate(k, tf) {
  const out = []; let cur = null;
  for (const c of k) {
    const b = bucketOf(c.time, tf);
    if (cur && cur.time === b) { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume; }
    else { cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; out.push(cur); }
  }
  return out;
}
// strategi bot (hanya strategi Anda)
const NEW_STRATS = ['stoch_low', 'macd_green', 'fib_rebound', 'bb_band'];
const STRATS = NEW_STRATS;
// pengaturan bot: jenis order masuk, waktu cek sinyal, dan parameter + timeframe tiap strategi
const BOT_DEF = { entry: 'market', limOff: 0.3, limExp: 3, check: 'close', cfg: {
  stoch_low: { tf: '15', k: 14, sm: 3, d: 3, os: 20, cross: false, noLL: false, llN: 5 },
  macd_green: { tf: '15', f: 12, s: 26, g: 9, noLL: true, llN: 5 },
  fib_rebound: { tf: '15', zone: 0.236, tgt: '0.618', slMode: 'pct', noLL: false, llN: 5 },
  bb_band: { tf: '15', bbP: 20, bbK: 2, noLL: false, llN: 5 }, } };
const BOT_INT = { k: [2, 100], sm: [1, 50], d: [1, 50], os: [1, 50], f: [2, 100], s: [3, 200], g: [2, 100], llN: [2, 50], limExp: [1, 100], bbP: [5, 200] };
const BOT_NUM = { zone: [0.01, 0.9], limOff: [0, 10], bbK: [0.5, 5] };
const BOT_EN = { tgt: ['0.5', '0.618', 'both'], slMode: ['pct', 'low'], entry: ['market', 'limit'], check: ['close', 'live'] };
function botVal(k, v, strict) { // satu nilai pengaturan bot -> nilai valid, atau galat (strict) / undefined
  const bad = m => { if (strict) throw new Error(m); };
  if (k === 'tf') { if (TF_SEC[v]) return String(v); return bad('Timeframe tidak dikenal'); }
  if (k === 'cross' || k === 'noLL') { if (typeof v === 'boolean') return v; return bad('Nilai ' + k + ' tidak valid'); }
  if (k in BOT_INT) { const [a, b] = BOT_INT[k], n = Math.round(+v); if (n >= a && n <= b) return n; return bad('Nilai ' + k + ' harus ' + a + ' sampai ' + b); }
  if (k in BOT_NUM) { const [a, b] = BOT_NUM[k], n = +v; if (Number.isFinite(n) && n >= a && n <= b) return Math.round(n * 1e4) / 1e4; return bad('Nilai ' + k + ' harus ' + a + ' sampai ' + b); }
  if (k in BOT_EN) { if (BOT_EN[k].includes(String(v))) return String(v); return bad('Pilihan ' + k + ' tidak valid'); }
  return bad('Pengaturan bot tidak dikenal: ' + k);
}
function normBot(src) { // isi bawaan, buang nilai rusak (untuk state lama)
  const o = JSON.parse(JSON.stringify(BOT_DEF)); src = src || {};
  for (const k of ['entry', 'limOff', 'limExp', 'check']) { const v = src[k] != null ? botVal(k, src[k], false) : undefined; if (v !== undefined) o[k] = v; }
  for (const [s, def] of Object.entries(o.cfg)) { const c = (src.cfg || {})[s] || {}; for (const k of Object.keys(def)) { const v = c[k] != null ? botVal(k, c[k], false) : undefined; if (v !== undefined) def[k] = v; } if (def.f >= def.s) { def.f = 12; def.s = 26; } }
  return o;
}
function patchBot(cur, p) {
  if (!p || typeof p !== 'object') throw new Error('Pengaturan bot tidak valid');
  const nx = JSON.parse(JSON.stringify(cur));
  for (const [k, v] of Object.entries(p)) {
    if (k === 'cfg') {
      for (const [s, c] of Object.entries(v || {})) {
        if (!nx.cfg[s]) throw new Error('Strategi tidak dikenal: ' + s);
        for (const [ck, cv] of Object.entries(c || {})) { if (!(ck in nx.cfg[s])) throw new Error('Strategi ini tidak punya pengaturan ' + ck); nx.cfg[s][ck] = botVal(ck, cv, true); }
        if (nx.cfg[s].f >= nx.cfg[s].s) throw new Error('MACD: periode cepat harus lebih kecil dari lambat');
      }
    } else if (['entry', 'limOff', 'limExp', 'check'].includes(k)) nx[k] = botVal(k, v, true);
    else throw new Error('Pengaturan bot tidak dikenal: ' + k);
  }
  return nx;
}
// parameter indikator (tampilan chart + strategi). sp = pasangan [cepat, lambat] untuk strategi crossover
const DEF_IND = { maOn: false, maP: 14, ema1On: false, ema1P: 21, ema2On: false, ema2P: 50,
  macdOn: false, macdF: 12, macdS: 26, macdG: 9, stochOn: false, stochK: 14, stochD: 3, stochSm: 3, stochOb: 80, stochOs: 20,
  fibOn: false, fibN: 100, fibLvl: 0.618, volOn: false, volMaOn: true, volMaP: 9, sp: { ma_crossover: [5, 15], ema_cross: [9, 21] },
  // daftar SMA/EMA (jumlah garis bebas, maks 8); maOn/maP/ema1*/ema2* tetap ada sebagai alias garis pertama/kedua
  smaList: [{ p: 14, col: '#fbb040', on: false, w: 2 }], emaList: [{ p: 21, col: '#4dd0e1', on: false, w: 2 }, { p: 50, col: '#b388ff', on: false, w: 2 }],
  bbOn: false, bbP: 20, bbK: 2, rsiOn: false, rsiP: 14, rsiOb: 70, rsiOs: 30, obOn: false, obLen: 5, bosOn: false, bosLen: 5, xOn: false, xFast: 9, xSlow: 21, xW: 2,
  col: { ma: '#fbb040', ema1: '#4dd0e1', ema2: '#b388ff', macd: '#26c6da', sig: '#ff7043', hUp: '#00e676', hUp2: '#b2dfdb', hDn2: '#ffcdd2', hDn: '#ff4466', stK: '#5b8dfc', stD: '#ff9800', fib: '#fbb040', fib2: '#9c8cff', volUp: '#26a69a', volDn: '#ef5350', volMa: '#ffd54f',
    bbU: '#5b8dfc', bbM: '#ff9800', bbL: '#5b8dfc', rsi: '#b388ff', obUp: '#00e676', obDn: '#ff4466', bosUp: '#26c6da', bosDn: '#ff7043', xF: '#ffd54f', xS: '#7c4dff', xBuy: '#00e676', xSell: '#ff4466' } };
const LINE_COLS = ['#fbb040', '#4dd0e1', '#b388ff', '#ff7043', '#69f0ae', '#ffd54f', '#f06292', '#90caf9'];
const HEX = /^#[0-9a-f]{6}$/i;
// validasi Fibonacci gambar manual (needPts = harus ada dua titik) atau template gayanya
const FIB_KEYS = { bool: ['trend', 'reverse', 'prices', 'lvlShow', 'bg', 'locked'], en: { extend: ['none', 'left', 'right', 'both'], lvlAs: ['values', 'percents'], labelH: ['left', 'center', 'right'], labelV: ['top', 'middle', 'bottom'] }, int: { lineW: [1, 4], lineStyle: [0, 2], bgOp: [0, 100], fontSize: [9, 20] } };
function normFib(d, needPts) {
  if (!d || typeof d !== 'object') throw new Error('Data Fibonacci tidak valid');
  const o = JSON.parse(JSON.stringify(IND.FIB_STYLE));
  for (const k of FIB_KEYS.bool) if (d[k] != null) { if (typeof d[k] !== 'boolean') throw new Error('Pilihan Fibonacci ' + k + ' tidak valid'); o[k] = d[k]; }
  for (const [k, list] of Object.entries(FIB_KEYS.en)) if (d[k] != null) { if (!list.includes(d[k])) throw new Error('Pilihan Fibonacci ' + k + ' tidak valid'); o[k] = d[k]; }
  for (const [k, [a, b]] of Object.entries(FIB_KEYS.int)) if (d[k] != null) { const n = Math.round(+d[k]); if (!(n >= a && n <= b)) throw new Error('Nilai Fibonacci ' + k + ' harus ' + a + ' sampai ' + b); o[k] = n; }
  if (d.trendCol != null) { if (!HEX.test(d.trendCol)) throw new Error('Warna garis tren tidak valid'); o.trendCol = d.trendCol.toLowerCase(); }
  if (d.levels != null) {
    if (!Array.isArray(d.levels) || !d.levels.length || d.levels.length > 24) throw new Error('Daftar level Fibonacci tidak valid');
    o.levels = d.levels.map(l => {
      const r = +(l && l.r);
      if (!(Number.isFinite(r) && r >= -10 && r <= 10)) throw new Error('Level Fibonacci harus angka -10 sampai 10');
      if (!HEX.test(l.col)) throw new Error('Warna level Fibonacci tidak valid');
      return { r: Math.round(r * 10000) / 10000, on: !!l.on, col: l.col.toLowerCase() };
    });
  }
  if (needPts) {
    for (const k of ['p1', 'p2']) {
      const p = d[k] || {}, t = Math.round(+p.t), pr = +p.price;
      if (!(t > 1e9 && t < 4e9 && pr > 0 && Number.isFinite(pr))) throw new Error('Titik Fibonacci tidak valid');
      o[k] = { t, price: pr };
    }
    if (o.p1.price === o.p2.price) throw new Error('Dua titik Fibonacci harus berbeda harga');
  }
  return o;
}
const IND_INT = { maP: [2, 200], ema1P: [2, 300], ema2P: [2, 300], macdF: [2, 100], macdS: [3, 200], macdG: [2, 100], stochK: [2, 100], stochD: [1, 50], stochSm: [1, 50], stochOb: [51, 99], stochOs: [1, 49], fibN: [10, 300], volMaP: [2, 200],
  bbP: [5, 200], rsiP: [2, 100], rsiOb: [51, 99], rsiOs: [1, 49], obLen: [2, 20], bosLen: [2, 20], xFast: [2, 200], xSlow: [3, 400], xW: [1, 4] };
const IND_DISPLAY = ['volMaP', 'volMaOn', 'volOn', 'smaList', 'emaList', 'bbOn', 'bbP', 'bbK', 'rsiOn', 'rsiP', 'rsiOb', 'rsiOs', 'obOn', 'obLen', 'bosOn', 'bosLen', 'xOn', 'xFast', 'xSlow', 'xW']; // hanya tampilan chart: boleh diubah saat bot berjalan
const IND_BOOL = ['maOn', 'ema1On', 'ema2On', 'macdOn', 'stochOn', 'fibOn', 'volOn', 'volMaOn', 'bbOn', 'rsiOn', 'obOn', 'bosOn', 'xOn'];
// daftar garis SMA/EMA: [{ p, col, on }], 1 sampai 8 garis, periode 2..400
function normLines(a, strict, max) {
  const bad = m => { if (strict) throw new Error(m); return null; };
  if (!Array.isArray(a) || !a.length || a.length > 8) return bad('Jumlah garis harus 1 sampai 8');
  const out = [];
  for (const [i, x] of a.entries()) {
    const p = Math.round(+(x && x.p)); if (!(p >= 2 && p <= (max || 400))) return bad('Periode garis harus 2 sampai ' + (max || 400));
    const col = HEX.test((x && x.col) || '') ? x.col.toLowerCase() : strict && x && x.col != null ? bad('Kode warna tidak valid') : LINE_COLS[i % LINE_COLS.length];
    const w = Math.round(+(x && x.w)); out.push({ p, col, on: !(x && x.on === false), w: w >= 1 && w <= 4 ? w : 2 });
  }
  return out;
}
// alias lama (maOn/maP, ema1On/ema1P, ema2On/ema2P, warna ma/ema1/ema2) disamakan dengan garis pertama/kedua daftar
function syncLegacy(o) {
  const s0 = o.smaList[0], e0 = o.emaList[0], e1 = o.emaList[1];
  o.maOn = !!s0.on; o.maP = Math.min(200, s0.p); o.col.ma = s0.col;
  o.ema1On = !!e0.on; o.ema1P = Math.min(300, e0.p); o.col.ema1 = e0.col;
  o.ema2On = !!(e1 && e1.on); o.ema2P = e1 ? Math.min(300, e1.p) : 50; if (e1) o.col.ema2 = e1.col;
  return o;
}
function normInd(src) { // isi nilai bawaan dan pastikan semuanya valid (untuk state lama)
  const o = JSON.parse(JSON.stringify(DEF_IND)); src = src || {};
  for (const k of IND_BOOL) if (typeof src[k] === 'boolean') o[k] = src[k];
  for (const [k, [a, b]] of Object.entries(IND_INT)) { const v = Math.round(+src[k]); if (v >= a && v <= b) o[k] = v; }
  if (+src.fibLvl >= 0.1 && +src.fibLvl <= 0.95) o.fibLvl = +src.fibLvl;
  for (const k of Object.keys(o.sp)) { const a = (src.sp || {})[k]; if (Array.isArray(a) && a.length === 2 && a[0] >= 2 && a[1] <= 300 && a[0] < a[1]) o.sp[k] = [Math.round(a[0]), Math.round(a[1])]; }
  if (!(o.macdF < o.macdS)) { o.macdF = DEF_IND.macdF; o.macdS = DEF_IND.macdS; }
  if (!(o.stochOs < o.stochOb)) { o.stochOs = DEF_IND.stochOs; o.stochOb = DEF_IND.stochOb; }
  if (!(o.rsiOs < o.rsiOb)) { o.rsiOs = DEF_IND.rsiOs; o.rsiOb = DEF_IND.rsiOb; }
  if (!(o.xFast < o.xSlow)) { o.xFast = DEF_IND.xFast; o.xSlow = DEF_IND.xSlow; }
  if (+src.bbK >= 0.5 && +src.bbK <= 5) o.bbK = Math.round(+src.bbK * 100) / 100;
  for (const k of Object.keys(o.col)) { const v = (src.col || {})[k]; if (HEX.test(v || '')) o.col[k] = v.toLowerCase(); }
  // daftar SMA/EMA; state lama tanpa daftar dibangun dari MA/EMA 1/EMA 2
  o.smaList = normLines(src.smaList, false) || [{ p: o.maP, col: o.col.ma, on: o.maOn }];
  o.emaList = normLines(src.emaList, false) || [{ p: o.ema1P, col: o.col.ema1, on: o.ema1On }, { p: o.ema2P, col: o.col.ema2, on: o.ema2On }];
  return syncLegacy(o);
}
// validasi perubahan dari pengguna (melempar galat yang jelas); mengembalikan objek ind baru
function patchInd(cur, patch, botActive) {
  if (!patch || typeof patch !== 'object') throw new Error('Pengaturan indikator tidak valid');
  const nx = JSON.parse(JSON.stringify(cur));
  const LEG = { maOn: ['smaList', 0, 'on'], maP: ['smaList', 0, 'p'], ema1On: ['emaList', 0, 'on'], ema1P: ['emaList', 0, 'p'], ema2On: ['emaList', 1, 'on'], ema2P: ['emaList', 1, 'p'] }, LEGC = { ma: ['smaList', 0], ema1: ['emaList', 0], ema2: ['emaList', 1] };
  const legSet = (k, v) => { const [l, i, f] = LEG[k]; while (nx[l].length <= i) nx[l].push({ p: 50, col: LINE_COLS[nx[l].length % LINE_COLS.length], on: false }); nx[l][i][f] = v; };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'smaList' || k === 'emaList') { nx[k] = normLines(v, true); continue; }
    if (k === 'bbK') { const n = +v; if (!(Number.isFinite(n) && n >= 0.5 && n <= 5)) throw new Error('Pengali Bollinger harus 0,5 sampai 5'); nx.bbK = Math.round(n * 100) / 100; continue; }
    if (IND_BOOL.includes(k)) { if (typeof v !== 'boolean') throw new Error('Nilai ' + k + ' tidak valid'); nx[k] = v; if (LEG[k]) legSet(k, v); continue; }
    if (k === 'col') { // warna hanya tampilan, boleh diubah saat bot berjalan
      for (const [ck, cv] of Object.entries(v || {})) { if (!(ck in nx.col)) throw new Error('Warna ' + ck + ' tidak dikenal'); if (!HEX.test(cv || '')) throw new Error('Kode warna tidak valid'); nx.col[ck] = cv.toLowerCase(); if (LEGC[ck] && nx[LEGC[ck][0]][LEGC[ck][1]]) nx[LEGC[ck][0]][LEGC[ck][1]].col = nx.col[ck]; }
      continue;
    }
    if (botActive && !IND_DISPLAY.includes(k)) throw new Error('Matikan bot dulu untuk mengubah parameter indikator atau strategi');
    if (k in IND_INT) { const [a, b] = IND_INT[k], n = Math.round(+v); if (!(n >= a && n <= b)) throw new Error('Nilai ' + k + ' harus ' + a + ' sampai ' + b); nx[k] = n; if (LEG[k]) legSet(k, n); }
    else if (k === 'fibLvl') { if (!(+v >= 0.1 && +v <= 0.95)) throw new Error('Level Fibonacci harus 0,1 sampai 0,95'); nx.fibLvl = +v; }
    else if (k === 'sp') {
      for (const [sk, a] of Object.entries(v || {})) {
        if (!(sk in nx.sp)) throw new Error('Strategi ' + sk + ' tidak punya parameter cepat/lambat');
        if (!Array.isArray(a) || a.length !== 2 || !(+a[0] >= 2 && +a[1] <= 300 && +a[0] < +a[1])) throw new Error('Periode cepat harus lebih kecil dari periode lambat (2 sampai 300)');
        nx.sp[sk] = [Math.round(+a[0]), Math.round(+a[1])];
      }
    } else throw new Error('Parameter tidak dikenal: ' + k);
  }
  if (!(nx.macdF < nx.macdS)) throw new Error('MACD: periode cepat harus lebih kecil dari lambat');
  if (!(nx.stochOs < nx.stochOb)) throw new Error('Stochastic: batas oversold harus lebih kecil dari overbought');
  if (!(nx.rsiOs < nx.rsiOb)) throw new Error('RSI: batas oversold harus lebih kecil dari overbought');
  if (!(nx.xFast < nx.xSlow)) throw new Error('EMA cross: EMA cepat harus lebih kecil dari EMA lambat');
  return syncLegacy(nx);
}
const log = (...a) => console.log(new Date().toLocaleTimeString('id-ID'), ...a);

// ---------- tampilan chart: jenis, warna candle ----------
const CHART_TYPES = ['candles', 'hollow', 'bars', 'volume', 'line', 'area', 'heikin'];
const CHART_DEF = { type: 'candles', body: true, border: true, wick: true, upBody: '#00e676', dnBody: '#ff4466', upBorder: '#00e676', dnBorder: '#ff4466', upWick: '#00e676', dnWick: '#ff4466', line: '#5b8dfc', bg: '#12121f', grid: true };
function normChart(src, strict) {
  const o = { ...CHART_DEF }, base = strict ? { ...src.__cur } : o; src = src || {};
  const out = strict ? base : o;
  for (const [k, v] of Object.entries(src)) {
    if (k === '__cur') continue;
    if (!(k in CHART_DEF)) { if (strict) throw new Error('Pengaturan chart tidak dikenal: ' + k); continue; }
    if (k === 'type') { if (CHART_TYPES.includes(v)) out.type = v; else if (strict) throw new Error('Jenis chart tidak dikenal'); }
    else if (typeof CHART_DEF[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v; else if (strict) throw new Error('Nilai ' + k + ' tidak valid'); }
    else if (HEX.test(v || '')) out[k] = v.toLowerCase(); else if (strict) throw new Error('Kode warna tidak valid');
  }
  return out;
}
// ---------- layout multi-chart: panel 0 = chart utama (aset & timeframe trading), panel lain bebas ----------
const LAYOUT_N = { '1': 1, '2v': 2, '2h': 2, '3c': 3, '3r': 3, '3l': 3, '3rr': 3, '3t': 3, '3b': 3, '4g': 4, '4r': 4, '4c': 4, '4l': 4, '4rr': 4, '4t': 4, '4b': 4, '4m': 4 };
function normLayout(src, strict) {
  src = src || {}; const bad = m => { if (strict) throw new Error(m); };
  let id = String(src.id || '1'); if (!LAYOUT_N[id]) { bad('Layout tidak dikenal'); id = '1'; }
  const n = LAYOUT_N[id], panes = [];
  for (let i = 0; i < n; i++) {
    const p = (src.panes || [])[i] || {}, prev = panes[i - 1] || {};
    let pair = String(p.pair || prev.pair || 'btcidr'), tf = String(p.tf || '60');
    let known = {}; try { known = PAIRS; } catch (e) { } // saat state dimuat, daftar pair belum ada
    if (!pairIdOk(pair) || (Object.keys(known).length && !known[pair] && !(i > 0 && extOf(pair))) || (YH_RE.test(pair) && i === 0)) { bad(i === 0 && extOf(pair) ? extOf(pair).symbol + ' hanya grafik dan tidak bisa jadi chart trading' : 'Aset panel ' + (i + 1) + ' tidak dikenal'); pair = 'btcidr'; }
    if (i === 0 && EXT[pair]) { bad(EXT[pair].symbol + ' hanya grafik dan tidak bisa jadi chart trading'); pair = 'btcidr'; }
    if (!TF_SEC[tf]) { bad('Timeframe panel ' + (i + 1) + ' tidak dikenal'); tf = '60'; }
    panes.push({ pair, tf });
  }
  return { id, panes };
}
// ---------- compare: aset lain ditumpuk di chart yang sama ----------
// mode: pct = skala % sama, scale = skala harga baru (kiri), pane = panel baru di bawah
const CMP_MODES = ['pct', 'scale', 'pane'], CMP_TYPES = ['line', 'area', 'candles', 'hollow', 'bars', 'heikin'];
function normCompare(arr, strict) {
  const bad = m => { if (strict) throw new Error(m); return null; };
  if (arr == null) return [];
  if (!Array.isArray(arr)) return bad('Data compare tidak valid') || [];
  if (arr.length > 8) { bad('Maksimal 8 aset pembanding'); arr = arr.slice(0, 8); }
  let known = {}; try { known = PAIRS; } catch (e) { }
  const out = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') { bad('Data compare tidak valid'); continue; }
    const id = String(c.id || ''); if (!/^[a-z0-9_-]{1,40}$/i.test(id) || out.some(x => x.id === id)) { bad('Id compare tidak valid'); continue; }
    const pane = Math.round(+c.pane || 0); if (!(pane >= 0 && pane <= 3)) { bad('Panel compare tidak valid'); continue; }
    const pair = String(c.pair || ''); if (!pairIdOk(pair) || (Object.keys(known).length && !known[pair] && !extOf(pair))) { bad('Aset pembanding tidak dikenal'); continue; }
    if (!CMP_MODES.includes(c.mode)) { bad('Mode compare tidak dikenal'); continue; }
    if (!CMP_TYPES.includes(c.type)) { bad('Jenis chart compare tidak dikenal'); continue; }
    if (!HEX.test(c.col || '')) { bad('Warna compare tidak valid'); continue; }
    out.push({ id, pane, pair, mode: c.mode, type: c.type, col: c.col.toLowerCase() });
  }
  return out;
}
// ---------- gambar di chart (selain Fibonacci strategi) per aset ----------
const DR_N = { trend: 2, ray: 2, hline: 1, rect: 2, brush: 0, text: 1, emoji: 1 };
function normDrawings(arr) {
  if (!Array.isArray(arr)) throw new Error('Data gambar tidak valid');
  if (arr.length > 300) throw new Error('Terlalu banyak gambar di satu aset (maksimal 300)');
  return arr.map(d => {
    if (!d || !(d.type in DR_N)) throw new Error('Jenis gambar tidak dikenal');
    const id = String(d.id || ''); if (!/^[a-z0-9_-]{1,40}$/i.test(id)) throw new Error('Id gambar tidak valid');
    const need = DR_N[d.type], pts = Array.isArray(d.pts) ? d.pts : [];
    if (need ? pts.length !== need : (pts.length < 2 || pts.length > 1500)) throw new Error('Titik gambar tidak valid');
    const o = { id, type: d.type, pts: pts.map(p => { const t = Math.round(+p.t), pr = +p.price; if (!(t > 1e9 && t < 4e9 && pr > 0 && Number.isFinite(pr))) throw new Error('Titik gambar tidak valid'); return { t, price: pr }; }) };
    o.col = HEX.test(d.col || '') ? d.col.toLowerCase() : '#5b8dfc';
    o.w = Math.min(8, Math.max(1, Math.round(+d.w || 2)));
    o.dash = [0, 1, 2].includes(+d.dash) ? +d.dash : 0;
    if (d.locked === true) o.locked = true;
    if (d.type === 'rect') { o.fill = HEX.test(d.fill || '') ? d.fill.toLowerCase() : o.col; o.op = Math.min(100, Math.max(0, Math.round(+d.op >= 0 ? +d.op : 15))); }
    if (d.type === 'trend') o.ext = ['none', 'right', 'both'].includes(d.ext) ? d.ext : 'none';
    if (d.type === 'hline') o.label = d.label !== false;
    if (d.type === 'text') { o.text = String(d.text || '').slice(0, 300); if (!o.text) throw new Error('Teks kosong'); }
    if (d.type === 'emoji') o.ch = [...String(d.ch || '⭐')].slice(0, 4).join('');
    if (d.type === 'text' || d.type === 'emoji') o.size = Math.min(96, Math.max(8, Math.round(+d.size || (d.type === 'emoji' ? 28 : 14))));
    return o;
  });
}

// ---------- state tersimpan ----------
fs.mkdirSync(CFG.dataDir, { recursive: true });
let STATE_FILE = path.join(CFG.dataDir, LIVE ? 'state-live.json' : 'state-paper.json');
const S = {
  settings: { pair: 'btcidr', tf: '1D', strategy: 'stoch_low', botSize: 100000, botSl: 1.5, botTp: 3, botSlOn: true, botTpOn: true, botMarket: 'spot', botLev: 10, botMM: 'isolated', futLev: 10, futMM: 'isolated', botActive: false, ind: normInd(), bot: normBot() },
  paper: { idr: CFG.paperIdr, deposited: CFG.paperIdr },
  positions: [], orders: [], history: [], totalPnl: 0, dayKey: '', dayPnl: 0,
};
try { Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { }
S.settings.botActive = false; // bot selalu mati saat server baru dinyalakan
S.settings.ind = normInd(S.settings.ind);
S.settings.bot = normBot(S.settings.bot);
S.settings.chart = normChart(S.settings.chart);
S.settings.layout = normLayout(S.settings.layout);
S.settings.compare = normCompare(S.settings.compare);
S.settings.mainView = typeof S.settings.mainView === 'string' && extOf(S.settings.mainView) ? S.settings.mainView : null;
S.settings.drawings = (() => { const o = {}; for (const [k, v] of Object.entries(S.settings.drawings || {})) { try { o[k] = normDrawings(v); } catch (e) { } } return o; })();
S.settings.fibDraw = (() => { const o = {}; for (const [k, v] of Object.entries(S.settings.fibDraw || {})) { try { o[k] = normFib(v, true); } catch (e) { } } return o; })();
try { S.settings.fibTpl = S.settings.fibTpl ? normFib(S.settings.fibTpl, false) : null; } catch (e) { S.settings.fibTpl = null; }
S.orders = Array.isArray(S.orders) ? S.orders : [];
S.orders.forEach(o => { o.cancelling = false; }); S.positions.forEach(p => { p.closing = false; }); // penanda sementara tidak boleh terbawa setelah restart
if (!STRATS.includes(S.settings.strategy)) S.settings.strategy = 'stoch_low';
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S, null, 1)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch (e) { log('Gagal simpan state:', e.message); } }, 300); }
const wibDay = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
function rollDay() { const d = wibDay(); if (S.dayKey !== d) { S.dayKey = d; S.dayPnl = 0; } }

// ---------- HTTP ke Indodax ----------
async function getJson(url, ms = 10000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'TradeBotPro/1.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function tapi(method, params = {}, creds) {
  const key = creds ? creds.key : CFG.key, secret = creds ? creds.secret : CFG.secret;
  if (!key || !secret) throw new Error('API key Indodax belum diisi');
  const body = new URLSearchParams({ method, ...params, timestamp: String(Date.now()), recvWindow: '10000' }).toString();
  const sign = crypto.createHmac('sha512', secret).update(body).digest('hex');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(CFG.base + '/tapi', { method: 'POST', body, signal: ac.signal, headers: { Key: key, Sign: sign, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await r.json().catch(() => ({ success: 0, error: 'Respons Indodax tidak bisa dibaca (HTTP ' + r.status + ')' }));
    if (!j || j.success != 1) throw new Error((j && (j.error || j.message)) || 'Permintaan ke Indodax gagal');
    return j.return;
  } finally { clearTimeout(t); }
}

// Trade API V2 (kunci baru dari indodax.com/trade_api): host api.indodax.com, header X-APIKEY, tanda tangan HMAC-SHA256 (hex)
// atas query string (GET) atau body (POST). Kunci V2 TIDAK bisa dipakai di API lama (/tapi), dan sebaliknya.
let CLOCK_OFF = 0; // selisih jam server Indodax - jam komputer (ms), dipelajari dari header Date tiap respons
async function tapi2(method, route, params = {}, creds, retried) {
  const key = creds ? creds.key : CFG.key, secret = creds ? creds.secret : CFG.secret;
  if (!key || !secret) throw new Error('API key Indodax belum diisi');
  const qs = new URLSearchParams({ ...params, timestamp: String(Date.now() + CLOCK_OFF), recvWindow: '15000' }).toString();
  const sign = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const headers = { 'X-APIKEY': key, Sign: sign, Accept: 'application/json' };
  const init = { method };
  let url = CFG.base2 + route;
  if (method === 'POST') { init.body = qs; headers['Content-Type'] = 'application/x-www-form-urlencoded'; } else url += '?' + qs;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000); init.signal = ac.signal; init.headers = headers;
  try {
    const r = await fetch(url, init);
    const dh = Date.parse(r.headers.get('date') || ''); if (dh > 0) CLOCK_OFF = dh - Date.now(); // header Date dibulatkan ke detik (selisih <1 dtk, masih dalam recvWindow)
    const j = await r.json().catch(() => null);
    if (!retried && j && j.code === -1021 && dh > 0) { clearTimeout(t); return tapi2(method, route, params, creds, true); } // jam beda: ulangi sekali dengan jam server
    const bad =!r.ok || (j && typeof j.code === 'number' && j.code !== 0 && j.msg !== undefined && j.orderId === undefined);
    if (bad) { const e = new Error(((j && j.msg) || ('HTTP ' + r.status)) + (j && j.code ? ' [kode ' + j.code + ']' : '')); e.code = j && j.code; e.http = r.status; throw e; }
    if (j === null) throw new Error('Respons Indodax tidak bisa dibaca (HTTP ' + r.status + ')');
    return j;
  } finally { clearTimeout(t); }
}
// saldo dinormalkan: { idr, hold, coins:{btc:n} } untuk kedua versi API
async function balancesV2(creds) {
  const r = await tapi2('GET', '/api/v2/account', {}, creds);
  const o = { idr: 0, hold: 0, coins: {}, canTrade: r.canTrade, canWithdraw: r.canWithdraw };
  for (const b of r.balances || []) { const a = String(b.asset || '').toLowerCase(), f = +b.free || 0, l = +b.locked || 0; if (a === 'idr') { o.idr = f; o.hold = l; } else if (f > 0) o.coins[a] = f; }
  return o;
}
async function balancesV1(creds) {
  const r = await tapi('getInfo', {}, creds);
  const o = { idr: +(r.balance || {}).idr || 0, hold: +(r.balance_hold || {}).idr || 0, coins: {} };
  for (const [k, v] of Object.entries(r.balance || {})) if (+v > 0 && k !== 'idr') o.coins[k] = +v;
  return o;
}
const isNetErr = e => /fetch failed|abort|ECONN|ENOTFOUND|ETIMEDOUT/i.test(String(e && (e.message + ' ' + (e.cause && e.cause.code || ''))));
// coba V2 dulu, lalu V1. Mengembalikan { ver, bal }
async function detectVer(creds) {
  let e2;
  try { return { ver: 'v2', bal: await balancesV2(creds) }; } catch (e) { if (isNetErr(e)) throw e; e2 = e; }
  try { return { ver: 'v1', bal: await balancesV1(creds) }; } catch (e) {
    if (isNetErr(e)) throw e;
    const err = new Error('API V2: ' + e2.message + ' | API V1: ' + e.message); err.e2 = e2; err.e1 = e; throw err;
  }
}
let API_VER = null, verP = null;
async function getVer() {
  if (API_VER) return API_VER;
  if (!verP) verP = detectVer().then(d => { API_VER = d.ver; return d.ver; }).finally(() => { verP = null; });
  return verP;
}
async function balances() { return (await getVer()) === 'v2' ? balancesV2() : balancesV1(); }

// ---------- daftar pair ----------
let PAIRS = {};
async function loadPairs() {
  try {
    const a = await getJson(CFG.base + '/api/pairs');
    const m = {};
    for (const p of a) {
      if (!p || !p.id || p.base_currency !== 'idr') continue;
      m[p.id] = { id: p.id, ticker: p.ticker_id || (p.traded_currency + '_idr'), coin: String(p.traded_currency || '').toLowerCase(), symbol: p.symbol || p.id.toUpperCase(), desc: p.description || p.id,
        minIdr: +p.trade_min_base_currency || 10000, minCoin: +p.trade_min_traded_currency || 0, priceDec: Number.isFinite(+p.price_round) && p.price_round !== '' && p.price_round != null ? +p.price_round : null, qtyDec: Number.isFinite(+p.volume_precision) && p.volume_precision !== '' && p.volume_precision != null ? Math.min(8, +p.volume_precision) : 8, fee: (+p.trade_fee_percent_taker || +p.trade_fee_percent || 0.3) / 100, maint: !!(+p.is_market_suspended || +p.is_maintenance) }; // hanya info: tanda ini bisa menyala walau pasar tetap jalan (misal maintenance dompet), jadi order tidak diblokir di sini
    }
    if (Object.keys(m).length) PAIRS = m;
    log('Pair Indodax dimuat:', Object.keys(PAIRS).length);
  } catch (e) { log('Gagal memuat pair:', e.message); }
  if (!PAIRS[S.settings.pair]) PAIRS[S.settings.pair] = PAIRS[S.settings.pair] || { id: S.settings.pair, ticker: S.settings.pair.replace(/idr$/, '') + '_idr', coin: S.settings.pair.replace(/idr$/, ''), symbol: S.settings.pair.toUpperCase(), desc: S.settings.pair.toUpperCase(), minIdr: 10000, minCoin: 0, fee: 0.003 };
}
const P = () => PAIRS[S.settings.pair];

// ---------- data pasar ----------
const M = { candles: [], cur: null, price: 0, ch24: null, ref24: 0, lastTick: 0, wsOk: false, src: '-' };
function tfSec() { return TF_SEC[S.settings.tf] || 60; }
// ---------- sumber candle chart: Indodax (utama) dengan cadangan Binance / OKX / Crypto.com, dikonversi ke rupiah ----------
// Pilihan disimpan di S.settings.chartSrc: auto (Indodax, otomatis pindah bila gagal/kosong) | indodax | binance | okx | cdc
const CH_SRC = ['auto', 'indodax', 'binance', 'okx', 'cdc'], CH_NAME = { indodax: 'Indodax', binance: 'Binance', okx: 'OKX', cdc: 'Crypto.com' };
const CH_TF = { binance: { '1': '1m', '15': '15m', '30': '30m', '60': '1h', '240': '4h', '1D': '1d' }, okx: { '1': '1m', '15': '15m', '30': '30m', '60': '1H', '240': '4H', '1D': '1Dutc' }, cdc: { '1': '1m', '15': '15m', '30': '30m', '60': '1h', '240': '4h', '1D': '1D' } };
async function idrRate() { if (M.usdIdr > 0) return M.usdIdr; const q = (await yQuotes([['IDR=X', 'USD/IDR']]))[0]; if (q && q.last > 0) return q.last; throw new Error('kurs USD/IDR tidak tersedia'); }
async function extSrcCandles(src, coin, tf, count) {
  const C = String(coin || '').toUpperCase(), stf = (TF_DEF[tf] || {}).src || tf, iv = (CH_TF[src] || {})[stf];
  if (!/^[A-Z0-9]{2,12}$/.test(C) || C === 'USDT') throw new Error('koin tidak tersedia di ' + CH_NAME[src]); if (!iv) throw new Error('timeframe tidak tersedia di ' + CH_NAME[src]);
  const want = Math.ceil(count * (TF_SEC[tf] || 60) / (TF_SEC[stf] || 60)), H = { Accept: 'application/json' }; let k = [];
  if (src === 'binance') { const a = await getJsonH((E.BINANCE_DATA || 'https://data-api.binance.vision') + '/api/v3/klines?symbol=' + C + 'USDT&interval=' + iv + '&limit=' + Math.min(1000, want), 12000, H); k = (Array.isArray(a) ? a : []).map(x => ({ time: Math.floor(+x[0] / 1000), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] || 0 })); }
  else if (src === 'okx') { const j = await getJsonH((E.OKX_BASE || 'https://www.okx.com') + '/api/v5/market/candles?instId=' + C + '-USDT&bar=' + iv + '&limit=' + Math.min(300, want), 12000, H); k = ((j && j.data) || []).map(x => ({ time: Math.floor(+x[0] / 1000), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] || 0 })); }
  else if (src === 'cdc') { const j = await getJsonH(MK.cdc + '/public/get-candlestick?instrument_name=' + C + '_USDT&timeframe=' + iv + '&count=' + Math.min(300, want), 12000, H); k = (((j && j.result) || {}).data || []).map(x => ({ time: Math.floor(+x.t / 1000), open: +x.o, high: +x.h, low: +x.l, close: +x.c, volume: +x.v || 0 })); }
  else throw new Error('sumber tidak dikenal');
  const seen = new Set(); k = k.filter(c => c.time > 0 && c.close > 0 && !seen.has(c.time) && seen.add(c.time)).sort((a, b) => a.time - b.time);
  if (!k.length) throw new Error('data ' + CH_NAME[src] + ' kosong');
  const r = await idrRate(); let out = k.map(c => ({ time: c.time, open: c.open * r, high: c.high * r, low: c.low * r, close: c.close * r, volume: c.volume }));
  if (stf !== tf) out = aggregate(out, tf);
  return out;
}
// candle chart dengan sumber pilihan + cadangan otomatis. Hasil berupa array; properti .src = sumber yang dipakai
async function fetchCandles(p, tf, count) {
  const pref = CH_SRC.includes(S.settings.chartSrc) ? S.settings.chartSrc : 'auto', tag = (k, s) => { k.src = s; return k; };
  if (pref !== 'auto' && pref !== 'indodax') { try { return tag(await extSrcCandles(pref, p.coin, tf, count), pref); } catch (e) { log('Sumber chart ' + CH_NAME[pref] + ' gagal (' + e.message + '), pakai Indodax'); } }
  let err;
  try { const kk = await indodaxCandles(p, tf, count); if (pref === 'indodax' || kk.length >= Math.min(30, Math.floor(count / 4))) return tag(kk, 'indodax'); err = new Error('data Indodax hanya ' + kk.length + ' candle'); }
  catch (e) { err = e; if (pref === 'indodax') throw e; }
  for (const s2 of ['binance', 'okx', 'cdc']) { if (s2 === pref) continue; try { const k = await extSrcCandles(s2, p.coin, tf, count); log('Candle ' + p.symbol + ' ' + tf + ' dari ' + CH_NAME[s2] + ' (Indodax: ' + err.message + ')'); return tag(k, s2); } catch (e) { } }
  throw err;
}
// ambil sekitar `count` candle terakhir dari Indodax (candle yang belum tutup ikut di ujung)
async function indodaxCandles(p, tf, count) {
  const sec = TF_SEC[tf] || 60, src = (TF_DEF[tf] || {}).src || tf, to = Math.floor(Date.now() / 1000), from = to - sec * count;
  const a = await getJson(`${CFG.base}/tradingview/history_v2?from=${from}&symbol=${encodeURIComponent(p.symbol)}&tf=${encodeURIComponent(src)}&to=${to}`, 25000);
  const k = (Array.isArray(a) ? a : []).map(c => ({ time: +c.Time, open: +c.Open, high: +c.High, low: +c.Low, close: +c.Close, volume: +c.Volume || 0 }))
    .filter(c => c.time > 0 && c.close > 0).sort((x, y) => x.time - y.time);
  const seen = new Set(); let kk = k.filter(c => !seen.has(c.time) && seen.add(c.time));
  if (src !== tf) kk = aggregate(kk, tf);
  return kk;
}
async function loadHistory() {
  const p = P(), tf = S.settings.tf;
  try {
    const kk = await fetchCandles(p, tf, 300);
    M.candles = kk.slice(-400); M.chSrc = kk.src || 'indodax';
    const now = bucketOf(Math.floor(Date.now() / 1000), tf);
    if (M.candles.length && M.candles[M.candles.length - 1].time >= now) M.cur = M.candles.pop(); else M.cur = null;
    const last = M.cur || M.candles[M.candles.length - 1];
    if (last) M.price = last.close;
    log(`Riwayat ${p.symbol} tf ${S.settings.tf}: ${M.candles.length} candle`);
  } catch (e) { log('Gagal memuat riwayat chart:', e.message); M.candles = []; M.cur = null; }
}
function onTick(ts, price, vol) {
  if (!(price > 0)) return;
  const b = bucketOf(ts, S.settings.tf);
  M.price = price; M.lastTick = Date.now();
  if (M.cur && b > M.cur.time) {
    M.candles.push(M.cur); if (M.candles.length > 400) M.candles.shift();
    M.cur = null;
  }
  if (!M.cur || b > M.cur.time) M.cur = { time: b, open: price, high: price, low: price, close: price, volume: 0 };
  else if (b === M.cur.time) { M.cur.high = Math.max(M.cur.high, price); M.cur.low = Math.min(M.cur.low, price); M.cur.close = price; }
  M.cur.volume += +vol || 0;
  if (M.ref24 > 0) M.ch24 = (price / M.ref24 - 1) * 100;
  checkSlTp(); checkPaperOrders(); botTick(ts, price); xTick(S.settings.pair, ts, price, vol);
  broadcast({ t: 'tick', price, ch24: M.ch24, candle: M.cur, ts });
}

// WebSocket Indodax (Centrifugo)
let ws = null, wsTimer = null, wsPing = null, wsId = 10, wsBack = 1000;
function wsSend(o) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch (e) { } }
// langganan tick: pair utama + pair di panel chart lain + pair yang punya alert aktif
const SUBS = new Set();
function wsWant() { const w = new Set([S.settings.pair]); for (const k of xwKeys()) if (!extOf(k.split("|")[0])) w.add(k.split('|')[0]); for (const a of ALERTS) if (a.on) w.add(a.pair); return w; }
function wsSync() {
  if (!M.wsOk) return; const want = wsWant();
  for (const p of [...SUBS]) if (!want.has(p)) { wsSend({ method: 2, params: { channel: 'chart:tick-' + p }, id: ++wsId }); SUBS.delete(p); }
  for (const p of want) if (!SUBS.has(p)) { wsSend({ method: 1, params: { channel: 'chart:tick-' + p }, id: ++wsId }); SUBS.add(p); }
}
function wsSub() { SUBS.clear(); wsSend({ method: 1, params: { channel: 'market:summary-24h' }, id: ++wsId }); wsSync(); }
function wsResub() { wsSync(); }
function wsConnect() {
  if (!WSImpl) { log('WebSocket tidak tersedia di Node ini; memakai polling ticker.'); return; }
  clearTimeout(wsTimer);
  try { ws = new WSImpl(CFG.wsUrl); } catch (e) { log('WS gagal dibuat:', e.message); wsTimer = setTimeout(wsConnect, wsBack); return; }
  ws.onopen = () => { wsBack = 1000; wsSend({ params: { token: CFG.wsToken }, id: 1 }); };
  ws.onmessage = ev => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.id === 1 && m.result) { M.wsOk = true; M.src = 'WebSocket'; wsSub(); log('Terhubung ke WebSocket Indodax'); broadcast({ t: 'conn', ok: true, src: M.src }); clearInterval(wsPing); wsPing = setInterval(() => wsSend({ method: 7, id: ++wsId }), 20000); continue; }
      const r = m.result; if (!r || !r.channel || !r.data) continue;
      const rows = (r.data && r.data.data) || [];
      if (r.channel === 'chart:tick-' + S.settings.pair) { for (const d of rows) onTick(+d[0], +d[2], d[3]); }
      else if (r.channel.startsWith('chart:tick-')) { const pr = r.channel.slice(11); for (const d of rows) xTick(pr, +d[0], +d[2], d[3]); }
      else if (r.channel === 'market:summary-24h') { for (const d of rows) if (d[0] === S.settings.pair && +d[5] > 0) { M.ref24 = +d[5]; if (M.price) M.ch24 = (M.price / M.ref24 - 1) * 100; } }
    }
  };
  ws.onclose = () => { M.wsOk = false; SUBS.clear(); clearInterval(wsPing); broadcast({ t: 'conn', ok: false, src: 'polling' }); wsTimer = setTimeout(wsConnect, wsBack); wsBack = Math.min(wsBack * 2, 30000); };
  ws.onerror = () => { try { ws.close(); } catch (e) { } };
}
// cadangan: polling ticker bila WebSocket putus
setInterval(async () => {
  if (M.wsOk && Date.now() - M.lastTick < 30000) return;
  try { const j = await getJson(`${CFG.base}/api/ticker/${S.settings.pair}`, 6000); const t = j && j.ticker; if (t && +t.last > 0) { M.src = M.wsOk ? 'WebSocket' : 'polling'; onTick(+t.server_time || Math.floor(Date.now() / 1000), +t.last, 0); } } catch (e) { }
}, 4000);

// cadangan polling untuk pair lain (panel chart tambahan & alert)
setInterval(async () => {
  const want = [...wsWant()].filter(p => p !== S.settings.pair && PAIRS[p]).slice(0, 10);
  for (const p of want) {
    const t = XT[p]; if (M.wsOk && t && Date.now() - t.at < 30000) continue;
    try { const j = await getJson(`${CFG.base}/api/ticker/${p}`, 6000), tk = j && j.ticker; if (tk && +tk.last > 0) xTick(p, +tk.server_time || Math.floor(Date.now() / 1000), +tk.last, 0); } catch (e) { }
  }
}, 4000);

// ---------- panel chart tambahan: candle aset/timeframe lain ----------
const XW = {}; // 'pair|tf' -> { pair, tf, candles, cur, sentAt }
const XT = {}; // pair -> { at, price } tick terakhir
function xwKeys() { // panel chart tambahan + aset pembanding (timeframe mengikuti panelnya)
  const L = (S.settings.layout || {}).panes || [], k = L.slice(1).map(p => p.pair + '|' + p.tf);
  if (S.settings.mainView) k.push(S.settings.mainView + '|' + S.settings.tf); // chart utama sedang menampilkan aset non-kripto
  for (const c of S.settings.compare || []) { const tf = c.pane === 0 ? S.settings.tf : c.pane < L.length ? L[c.pane].tf : null; if (tf) k.push(c.pair + '|' + tf); }
  return [...new Set(k)];
}
async function xwLoad(key) {
  const [pair, tf] = String(key).split('|'), p = chartPair(pair);
  if (!p || !TF_SEC[tf]) throw new Error('Aset atau timeframe tidak dikenal');
  let w = XW[key]; if (w && w.candles) return w; if (w && w.loading) return w.loading;
  w = XW[key] = { pair, tf, candles: null, cur: null, sentAt: 0 };
  w.loading = (async () => {
    try {
      const kk = p.ext ? await extCandles(pair, tf, 300) : await fetchCandles(p, tf, 300), now = bucketOf(Math.floor(Date.now() / 1000), tf);
      w.cur = kk.length && kk[kk.length - 1].time >= now ? kk.pop() : null; w.candles = kk.slice(-400); return w;
    } catch (e) { if (XW[key] === w) delete XW[key]; throw e; } finally { w.loading = null; }
  })();
  return w.loading;
}
function xwSync() {
  const keep = new Set(xwKeys());
  for (const k of Object.keys(XW)) if (!keep.has(k) && !XW[k].adhoc) delete XW[k];
  for (const k of keep) xwLoad(k).catch(e => log('Gagal memuat chart ' + k + ':', e.message));
  if ([...keep].some(k => k.startsWith('usdtd|')) && Date.now() - UD.at > 60000) usdtdTick().catch(() => { });
  wsSync();
}
function xTick(pair, ts, price, vol) {
  if (!(price > 0)) return; XT[pair] = { at: Date.now(), price };
  for (const w of Object.values(XW)) {
    if (w.pair !== pair || !w.candles) continue;
    const b = bucketOf(ts, w.tf); let closed = null;
    if (w.cur && b > w.cur.time) { closed = w.cur; w.candles.push(closed); if (w.candles.length > 400) w.candles.shift(); w.cur = null; }
    if (!w.cur || b > w.cur.time) w.cur = { time: b, open: price, high: price, low: price, close: price, volume: 0 };
    else { w.cur.high = Math.max(w.cur.high, price); w.cur.low = Math.min(w.cur.low, price); w.cur.close = price; } // b <= cur.time: tetap candle berjalan (jam sedikit berbeda)
    w.cur.volume += +vol || 0;
    if (closed || Date.now() - w.sentAt > 700) { w.sentAt = Date.now(); broadcast({ t: 'xc', key: w.pair + '|' + w.tf, candle: w.cur, closed, price }); }
  }
  checkAlerts(pair, price);
}
const histCache = {};

// ---------- USDT.D: dominasi USDT (% dari total market cap kripto) ----------
// Nilai terkini: CoinGecko /global (cadangan CoinPaprika). Riwayat: market cap USDT dibagi perkiraan total market cap,
// yaitu jumlah market cap 8 koin terbesar dibagi porsi mereka saat ini; titik terakhir dikalibrasi ke nilai resmi.
const CG_KEY = E.COINGECKO_API_KEY || '', CG_BASE = (E.COINGECKO_BASE || (CG_KEY && /^true$/i.test(E.COINGECKO_PRO || '') ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3')).replace(/\/$/, '');
const PAPRIKA = (E.COINPAPRIKA_BASE || 'https://api.coinpaprika.com/v1').replace(/\/$/, '');
const CG_GAP = Math.max(0, +(E.COINGECKO_GAP_MS || (CG_KEY ? 2100 : 2600))); // jeda antar panggilan agar tidak kena batas akses gratis
let CGQ = Promise.resolve(), CG_LAST = 0;
function cgRaw(q) {
  const run = async () => {
    const w = CG_LAST + CG_GAP - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w));
    CG_LAST = Date.now(); const ac = new AbortController(), t = setTimeout(() => ac.abort(), 15000);
    try {
      const h = { 'User-Agent': 'TradeBotPro/1.0', Accept: 'application/json' }; if (CG_KEY) h[/pro-api/.test(CG_BASE) ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = CG_KEY;
      const r = await fetch(CG_BASE + q, { signal: ac.signal, headers: h });
      if (r.status === 429) throw new Error('batas akses gratis CoinGecko tercapai, dicoba lagi nanti');
      if (!r.ok) throw new Error('CoinGecko HTTP ' + r.status); return await r.json();
    } finally { clearTimeout(t); }
  };
  const p = CGQ.then(run, run); CGQ = p.catch(() => { }); return p;
}

let CG_DOWN = 0, CGB = { top: null, at: 0, src: '' };
const CG_KEEP_FILE = path.join(CFG.dataDir, 'cg_last.json'); let CG_KEEP = {}; try { CG_KEEP = JSON.parse(fs.readFileSync(CG_KEEP_FILE, 'utf8')) || {}; } catch (e) { }
function cg(q) { // CoinGecko; bila gagal atau diblokir: pasar, global, trending, kategori dari CoinMarketCap (bila CMC_API_KEY diisi) / CoinPaprika / DefiLlama; treasury dari data terakhir yang tersimpan
  const fb = /^\/(coins\/markets\?(?!.*[?&]ids=).*per_page=100|global$|search\/trending|coins\/categories|companies\/public_treasury\/bitcoin)/.test(q);
  if (!fb) return cgRaw(q);
  const keep = j => { if (q.startsWith('/companies/public_treasury/bitcoin') && j && Array.isArray(j.companies)) { CG_KEEP.treas = { at: Date.now(), j }; try { fs.writeFileSync(CG_KEEP_FILE, JSON.stringify(CG_KEEP)); } catch (e) { } } return j; };
  if (Date.now() < CG_DOWN) return cgBackup(q).catch(() => cgRaw(q).then(keep));
  return cgRaw(q).then(keep).catch(e => { CG_DOWN = Date.now() + 120e3; return cgBackup(q).catch(e2 => { throw new Error(e.message + '; cadangan: ' + e2.message); }); });
}
const CMC_KEY = () => String(E.CMC_API_KEY || '').trim();
async function cgbTop() { // 100 koin teratas dalam bentuk yang sama dengan CoinGecko
  if (CGB.top && Date.now() - CGB.at < 90e3) return CGB.top;
  let out = null, src = '', er = [];
  if (CMC_KEY()) { try {
    const j = await xFetch(XB.cmc + '/v1/cryptocurrency/listings/latest?limit=100&convert=USD', { headers: { 'X-CMC_PRO_API_KEY': CMC_KEY() } }, 12000);
    out = (j.data || []).map(c => { const u = (c.quote || {}).USD || {}; return { id: c.slug, symbol: String(c.symbol || '').toLowerCase(), name: c.name, image: 'https://s2.coinmarketcap.com/static/img/coins/64x64/' + c.id + '.png', current_price: u.price, price_change_percentage_1h_in_currency: u.percent_change_1h, price_change_percentage_24h_in_currency: u.percent_change_24h, price_change_percentage_24h: u.percent_change_24h, price_change_percentage_7d_in_currency: u.percent_change_7d, price_change_percentage_30d_in_currency: u.percent_change_30d, market_cap: u.market_cap, total_volume: u.volume_24h, market_cap_rank: c.cmc_rank, high_24h: null, low_24h: null }; }).filter(c => c.current_price > 0);
    if (out.length) src = 'CoinMarketCap'; else out = null;
  } catch (e) { er.push('CoinMarketCap: ' + e.message); } }
  if (!out) { try {
    const a = await getJson(PAPRIKA + '/tickers?quotes=USD&limit=100', 20000);
    out = (Array.isArray(a) ? a : []).filter(t => t && t.quotes && t.quotes.USD && +t.quotes.USD.price > 0 && +t.rank > 0).sort((x, y) => x.rank - y.rank).slice(0, 100).map(t => { const u = t.quotes.USD; return { id: String(t.id).split('-').slice(1).join('-') || t.id, symbol: String(t.symbol || '').toLowerCase(), name: t.name, image: 'https://static.coinpaprika.com/coin/' + t.id + '/logo.png', current_price: u.price, price_change_percentage_1h_in_currency: u.percent_change_1h, price_change_percentage_24h_in_currency: u.percent_change_24h, price_change_percentage_24h: u.percent_change_24h, price_change_percentage_7d_in_currency: u.percent_change_7d, price_change_percentage_30d_in_currency: u.percent_change_30d, market_cap: u.market_cap, total_volume: u.volume_24h, market_cap_rank: t.rank, high_24h: null, low_24h: null }; });
    if (out.length) src = 'CoinPaprika'; else out = null;
  } catch (e) { er.push('CoinPaprika: ' + e.message); } }
  if (!out) throw new Error(er.join('; ') || 'tidak ada sumber cadangan');
  try { const j = await getJsonH(MK.cdc + '/public/get-tickers', 8000), m = {}; // tertinggi/terendah 24 jam dari Crypto.com
    for (const x of ((j.result || {}).data || [])) { const mm = /^([A-Z0-9]+)_(USDT|USD)$/.exec(x.i || ''); if (mm && !(m[mm[1]] && mm[2] === 'USDT')) m[mm[1]] = x; }
    for (const c of out) { const x = m[String(c.symbol).toUpperCase()]; if (x && +x.h > 0 && +x.l > 0 && c.current_price > 0 && Math.abs(+x.a / c.current_price - 1) < 0.1) { c.high_24h = +x.h; c.low_24h = +x.l; } }
  } catch (e) { }
  CGB = { top: out, at: Date.now(), src }; log('Data pasar kripto dari cadangan:', src); return out;
}
async function cgbGlobal() {
  const top = await cgbTop(), pct = (sym, tot) => { const c = top.find(x => x.symbol === sym); return c && tot > 0 ? +c.market_cap / tot * 100 : null; };
  if (CGB.src === 'CoinMarketCap') { try {
    const j = await xFetch(XB.cmc + '/v1/global-metrics/quotes/latest', { headers: { 'X-CMC_PRO_API_KEY': CMC_KEY() } }, 12000), d = j.data || {}, u = (d.quote || {}).USD || {}, tot = +u.total_market_cap;
    if (tot > 0) return { data: { total_market_cap: { usd: tot }, total_volume: { usd: u.total_volume_24h }, market_cap_change_percentage_24h_usd: u.total_market_cap_yesterday_percentage_change, market_cap_percentage: { btc: +d.btc_dominance, eth: +d.eth_dominance, usdt: pct('usdt', tot) }, active_cryptocurrencies: d.active_cryptocurrencies } };
  } catch (e) { } }
  const g = await getJson(PAPRIKA + '/global', 12000), tot = +g.market_cap_usd; if (!(tot > 0)) throw new Error('data global kosong');
  return { data: { total_market_cap: { usd: tot }, total_volume: { usd: +g.volume_24h_usd }, market_cap_change_percentage_24h_usd: +g.market_cap_change_24h, market_cap_percentage: { btc: +g.bitcoin_dominance_percentage || pct('btc', tot), eth: pct('eth', tot), usdt: pct('usdt', tot) }, active_cryptocurrencies: g.cryptocurrencies_number } };
}
async function cgbTrend() { // pengganti trending: koin top 100 dengan gerak harga 24 jam terbesar (stablecoin dibuang)
  const top = await cgbTop(), a = top.filter(c => isFinite(c.price_change_percentage_24h_in_currency) && !STABLE.has(c.symbol)).sort((x, y) => Math.abs(y.price_change_percentage_24h_in_currency) - Math.abs(x.price_change_percentage_24h_in_currency)).slice(0, 10);
  return { coins: a.map(c => ({ item: { id: c.id, name: c.name, symbol: c.symbol, market_cap_rank: c.market_cap_rank, data: { price: c.current_price, price_change_percentage_24h: { usd: c.price_change_percentage_24h_in_currency } } } })) };
}
const CAT_SECT = { 'Layer 1': 'eth sol ada avax dot trx ton sui apt near atom algo icp hbar sei kas etc egld hype', 'Layer 2': 'arb op pol matic imx stx mnt strk zk', 'DeFi': 'uni aave mkr sky crv ldo ena pendle jup ray cake inj dydx comp snx gmx morpho',
  'Meme': 'doge shib pepe bonk wif floki trump fartcoin brett popcat pengu', 'AI & Big Data': 'fet tao render wld virtual akt grt theta', 'Real World Assets': 'ondo om plume', 'Exchange Token': 'bnb okb cro leo kcs gt bgb',
  'Pembayaran': 'xrp xlm ltc bch', 'Privasi': 'xmr zec dash', 'Oracle & Infrastruktur': 'link pyth fil ar qnt', 'Gaming & Metaverse': 'sand mana axs gala ape' };
async function stableLlama() { // total pasokan stablecoin (USD) dan perubahan 24 jam dari DefiLlama, tanpa kunci
  const j = await getJsonH(LLAMA_ST + '/stablecoins?includePrices=false', 15000, { Accept: 'application/json' }); let now = 0, prev = 0;
  for (const x of (j && j.peggedAssets) || []) { const c = +((x.circulating || {}).peggedUSD) || 0, p = +((x.circulatingPrevDay || {}).peggedUSD) || 0; if (c > 0 && p > 0) { now += c; prev += p; } }
  return now > 0 && prev > 0 ? { id: 'stablecoins', name: 'Stablecoins', market_cap: now, market_cap_change_24h: (now / prev - 1) * 100, volume_24h: null, top_3_coins_id: [] } : null;
}
async function cgbCats() { // kategori/narasi: CoinMarketCap (bila ada kunci), atau perkiraan sektor dari 100 koin teratas; stablecoin dari DefiLlama
  let out = null;
  if (CMC_KEY()) { try {
    const j = await xFetch(XB.cmc + '/v1/cryptocurrency/categories?limit=200', { headers: { 'X-CMC_PRO_API_KEY': CMC_KEY() } }, 12000);
    const a = (j.data || []).map(c => ({ id: /^stablecoins?$/i.test(String(c.name).trim()) ? 'stablecoins' : 'cmc-' + c.id, name: c.name, market_cap: +c.market_cap, market_cap_change_24h: +c.market_cap_change, volume_24h: +c.volume || null, top_3_coins_id: [] })).filter(c => c.market_cap > 0 && isFinite(c.market_cap_change_24h));
    if (a.length) { out = a; out._src = 'CoinMarketCap'; }
  } catch (e) { } }
  if (!out) {
    const top = await cgbTop(); out = [];
    for (const [name, list] of Object.entries(CAT_SECT)) {
      const set = new Set(list.split(' ')), mem = top.filter(c => set.has(c.symbol) && c.market_cap > 0 && isFinite(c.price_change_percentage_24h_in_currency)); if (mem.length < 2) continue;
      const mc = mem.reduce((t, c) => t + c.market_cap, 0), prev = mem.reduce((t, c) => t + c.market_cap / (1 + c.price_change_percentage_24h_in_currency / 100), 0);
      out.push({ id: 'sek-' + name.toLowerCase().replace(/\W+/g, '-'), name, market_cap: mc, market_cap_change_24h: (mc / prev - 1) * 100, volume_24h: mem.reduce((t, c) => t + (+c.total_volume || 0), 0), top_3_coins_id: mem.sort((x, y) => y.market_cap - x.market_cap).slice(0, 3).map(c => c.id) });
    }
    out._src = 'perkiraan dari 100 koin teratas (' + (CGB.src || 'cadangan') + ')';
  }
  if (!out.some(c => c.id === 'stablecoins')) { try { const st = await stableLlama(); if (st) out.push(st); } catch (e) { } }
  if (!out.length) throw new Error('data kategori cadangan kosong');
  return out;
}
async function cgBackup(q) {
  if (q.startsWith('/coins/categories')) return cgbCats();
  if (q.startsWith('/companies/public_treasury/bitcoin')) { if (CG_KEEP.treas && CG_KEEP.treas.j) return { ...CG_KEEP.treas.j, _stale: CG_KEEP.treas.at }; throw new Error('belum ada data treasury tersimpan'); }
  if (q.startsWith('/coins/markets')) return cgbTop();
  if (q === '/global') return cgbGlobal();
  if (q.startsWith('/search/trending')) return cgbTrend();
  throw new Error('tidak ada cadangan');
}
const UD = { now: null, at: 0, src: '', err: '' }, UD_FILE = path.join(CFG.dataDir, 'usdtd.json');
let UDH = {}; try { const j = JSON.parse(fs.readFileSync(UD_FILE, 'utf8')); for (const [d, v] of Object.entries(j || {})) if (v && Array.isArray(v.pts)) UDH[d] = { at: +v.at || 0, pts: v.pts }; } catch (e) { }
function saveUd() { try { const o = {}; for (const [d, v] of Object.entries(UDH)) if (v.pts) o[d] = { at: v.at, pts: v.pts }; fs.writeFileSync(UD_FILE + '.tmp', JSON.stringify(o)); fs.renameSync(UD_FILE + '.tmp', UD_FILE); } catch (e) { } }
// USDT.D sumber kedua tanpa CoinGecko: CoinPaprika (nilai & supply sekarang) + Yahoo Finance (riwayat harga koin teratas)
// + DefiLlama (riwayat supply USDT). Riwayat = market cap USDT ÷ perkiraan total market cap, titik terakhir dikalibrasi.
const LLAMA_ST = (E.LLAMA_STABLE_BASE || 'https://stablecoins.llama.fi').replace(/\/$/, '');
const YCRYPTO = new Set('BTC ETH XRP BNB SOL DOGE TRX ADA LINK AVAX XLM SUI BCH HBAR LTC DOT SHIB TON'.split(' '));
const udSrc = () => (S.settings && S.settings.usdtdSrc) || 'auto';
async function usdtdAlt(days) {
  const [g, tk] = await Promise.all([getJson(PAPRIKA + '/global', 12000), getJson(PAPRIKA + '/tickers?quotes=USD&limit=40', 15000)]);
  const total = +g.market_cap_usd, list = (Array.isArray(tk) ? tk : []).filter(t => t && t.quotes && t.quotes.USD && +t.quotes.USD.market_cap > 0);
  const usdt = list.find(t => t.id === 'usdt-tether' || t.symbol === 'USDT'), uMc = usdt ? +usdt.quotes.USD.market_cap : 0;
  if (!(total > 0 && uMc > 0)) throw new Error('data CoinPaprika kosong');
  const pick = list.filter(t => YCRYPTO.has(String(t.symbol).toUpperCase()) && +t.quotes.USD.price > 0).slice(0, 8);
  if (!pick.length) throw new Error('daftar koin CoinPaprika kosong');
  const share = (pick.reduce((a, t) => a + +t.quotes.USD.market_cap, 0) + uMc) / total, [rg, iv] = days <= 1 ? ['1d', '5m'] : days <= 90 ? ['3mo', '60m'] : ['1y', '1d'];
  const ser = await mapLimit(pick, 4, async t => { const sup = +t.quotes.USD.market_cap / +t.quotes.USD.price; try { const { pts } = await yChart(String(t.symbol).toUpperCase() + '-USD', rg, iv); return pts.filter(p => p.c > 0).map(p => [p.t, p.c * sup]); } catch (e) { return null; } });
  let uh = null; try { const a = await getJsonH(LLAMA_ST + '/stablecoincharts/all?stablecoin=1', 15000, { Accept: 'application/json' }); uh = (Array.isArray(a) ? a : []).map(r => [+r.date, +(((r.totalCirculatingUSD || r.totalCirculating) || {}).peggedUSD)]).filter(r => r[0] > 0 && r[1] > 0).sort((x, y) => x[0] - y[0]); } catch (e) { }
  const base = ser[0]; if (!base || base.length < 2) throw new Error('riwayat harga Yahoo kosong');
  const near = (a, t) => { let lo = 0, hi = a.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m][0] <= t) lo = m; else hi = m - 1; } return a[lo][1]; };
  const pts = [];
  for (const [t] of base) {
    const u = uh && uh.length && t >= uh[0][0] ? near(uh, t) : uMc; let sum = u;
    pick.forEach((x, i) => { const a = ser[i]; sum += a && a.length ? near(a, t) : +x.quotes.USD.market_cap; });
    if (sum > 0) pts.push([t, u / (sum / share) * 100]);
  }
  const now = uMc / total * 100; if (pts.length) { const k = now / pts[pts.length - 1][1]; if (k > 0.6 && k < 1.6) for (const q of pts) q[1] = +(q[1] * k).toFixed(5); }
  Object.assign(UD, { now, at: Date.now(), src: 'CoinPaprika', err: '' }); UD.hist = 'CoinPaprika + Yahoo + DefiLlama';
  return pts;
}
async function usdtdNow() {
  if (udSrc() === 'alt') { try { const g = await getJson(PAPRIKA + '/global', 10000), t = await getJson(PAPRIKA + '/tickers/usdt-tether', 10000), v = +t.quotes.USD.market_cap / +g.market_cap_usd * 100; if (v > 0 && v < 100) { Object.assign(UD, { now: v, at: Date.now(), src: 'CoinPaprika', err: '' }); return v; } } catch (e) { UD.err = 'CoinPaprika: ' + e.message; } return null; }
  try { const g = await cg('/global'), v = +((g.data || {}).market_cap_percentage || {}).usdt; if (v > 0) { Object.assign(UD, { now: v, at: Date.now(), src: 'CoinGecko', err: '' }); return v; } throw new Error('data kosong'); }
  catch (e) { UD.err = e.message; }
  try {
    const g = await getJson(PAPRIKA + '/global', 10000), t = await getJson(PAPRIKA + '/tickers/usdt-tether', 10000);
    const v = +t.quotes.USD.market_cap / +g.market_cap_usd * 100; if (v > 0 && v < 100) { Object.assign(UD, { now: v, at: Date.now(), src: 'CoinPaprika', err: '' }); return v; }
  } catch (e) { UD.err += ' · CoinPaprika: ' + e.message; }
  return null;
}
function usdtdSeries(days) {
  const c = UDH[days], ttl = days <= 1 ? 5 * 60e3 : days <= 90 ? 30 * 60e3 : 6 * 3600e3;
  if (c && c.pts && c.pts.length && Date.now() - c.at < ttl) return Promise.resolve(c.pts);
  if (c && c.p) return c.p;
  const p = (async () => {
    try {
      if (udSrc() === 'alt') { const pts = await usdtdAlt(days); UDH[days] = { at: Date.now(), pts, src: 'alt' }; saveUd(); return pts; }
      try {
      const g = await cg('/global'), d = g.data || {}, total = +(d.total_market_cap || {}).usd, pu = +(d.market_cap_percentage || {}).usdt;
      if (!(total > 0 && pu > 0)) throw new Error('data global CoinGecko kosong');
      Object.assign(UD, { now: pu, at: Date.now(), src: 'CoinGecko', err: '' });
      const mk = await cg('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=8&page=1');
      const top = (Array.isArray(mk) ? mk : []).filter(x => x && x.id && +x.market_cap > 0).slice(0, 8);
      if (!top.some(x => x.id === 'tether')) top.push({ id: 'tether', market_cap: pu / 100 * total });
      const share = top.reduce((t, x) => t + +x.market_cap, 0) / total; // porsi koin teratas dalam total market cap sekarang
      const ser = {};
      for (const x of top) { const j = await cg('/coins/' + x.id + '/market_chart?vs_currency=usd&days=' + days); ser[x.id] = (j.market_caps || []).map(r => [Math.floor(+r[0] / 1000), +r[1]]).filter(r => r[0] > 0 && r[1] > 0); }
      const base = ser.tether || [], gap = days <= 1 ? 900 : days <= 90 ? 3 * 3600 : 2 * 86400, ix = {}, pts = [];
      if (base.length < 2) throw new Error('riwayat market cap USDT kosong');
      for (const [t, mu] of base) {
        let sum = 0;
        for (const x of top) {
          const a = ser[x.id]; if (!a || !a.length) continue; let i = ix[x.id] || 0;
          while (i < a.length - 1 && Math.abs(a[i + 1][0] - t) <= Math.abs(a[i][0] - t)) i++; ix[x.id] = i;
          if (Math.abs(a[i][0] - t) <= gap) sum += a[i][1]; else sum += +x.market_cap * (mu / base[base.length - 1][1]); // koin tanpa data di waktu itu: perkiraan kasar
        }
        if (sum > 0) pts.push([t, mu / (sum / share) * 100]);
      }
      if (pts.length) { const k = pu / pts[pts.length - 1][1]; if (k > 0.7 && k < 1.4) for (const q of pts) q[1] = +(q[1] * k).toFixed(5); }
      UD.hist = 'CoinGecko'; UDH[days] = { at: Date.now(), pts }; saveUd(); return pts;
      } catch (e0) { // CoinGecko kena batas / gagal: otomatis pakai sumber kedua (kecuali dipaksa CoinGecko)
        if (udSrc() === 'coingecko') throw e0;
        try { const pts = await usdtdAlt(days); UDH[days] = { at: Date.now(), pts, src: 'alt' }; saveUd(); return pts; } catch (e1) { throw new Error(e0.message + '; sumber kedua: ' + e1.message); }
      }
    } catch (e) {
      UD.err = e.message;
      if (c && c.pts && c.pts.length) { UDH[days] = { at: Date.now() - ttl + 2 * 60e3, pts: c.pts }; return c.pts; } // pakai data lama, coba lagi 2 menit lagi
      UDH[days] = {}; throw new Error('Data USDT.D belum bisa diambil (' + e.message + ')');
    }
  })();
  UDH[days] = { ...(c || {}), p };
  return p;
}
// titik (waktu, nilai) -> candle per timeframe; celah diisi candle datar agar waktunya sejajar dengan chart lain
function ptsToCandles(pts, tf, n) {
  const sec = TF_SEC[tf] || 60, out = [], now = bucketOf(Math.floor(Date.now() / 1000), tf); let cur = null;
  const fill = until => { while (cur && out.length < 20000) { const nx = bucketOf(cur.time + sec + (tf === '1W' ? 3600 : 0), tf); if (nx >= until) break; cur = { time: nx, open: cur.close, high: cur.close, low: cur.close, close: cur.close, volume: 0 }; out.push(cur); } };
  for (const [t, v] of pts.slice().sort((a, b) => a[0] - b[0])) {
    const b = bucketOf(t, tf);
    if (cur && b === cur.time) { cur.high = Math.max(cur.high, v); cur.low = Math.min(cur.low, v); cur.close = v; continue; }
    if (cur && b < cur.time) continue;
    if (cur) fill(b);
    const o = cur ? cur.close : v; cur = { time: b, open: o, high: Math.max(o, v), low: Math.min(o, v), close: v, volume: 0 }; out.push(cur);
  }
  if (cur) fill(now + 1);
  return out.slice(-n);
}
// candle Yahoo Finance per timeframe chart (2H/4H dari 1 jam, 3D dari harian)
const YH_TF = { '1': ['1m', '5d'], '15': ['15m', '60d'], '30': ['30m', '60d'], '60': ['60m', '1y'], '120': ['60m', '2y'], '240': ['60m', '2y'], '1D': ['1d', '5y'], '3D': ['1d', '10y'], '1W': ['1wk', 'max'] };
async function yahooCandles(sym, tf, n) {
  const [iv, rg] = YH_TF[tf] || ['60m', '1y'];
  const { pts } = await cached('yc:' + sym + '|' + iv + '|' + rg, 45e3, () => yChart(sym, rg, iv));
  let k = pts.filter(p => p.o != null && p.h != null && p.l != null).map(p => ({ time: p.t, open: +p.o, high: +p.h, low: +p.l, close: +p.c, volume: +p.v || 0 }));
  if (['120', '240', '1D', '3D', '1W'].includes(tf) || iv === '1d') k = aggregate(k, tf);
  if (!k.length) throw new Error('Data chart ' + sym + ' kosong');
  return k.slice(-n);
}
async function extCandles(pair, tf, n) {
  if (YH_RE.test(pair)) return yahooCandles(pair.slice(3), tf, n);
  if (pair !== 'usdtd') throw new Error('Simbol tidak dikenal');
  const sec = TF_SEC[tf] || 60, days = sec < 3600 ? 1 : sec < 86400 ? 90 : 365, pts = (await usdtdSeries(days)).slice();
  if (UD.now > 0 && Date.now() - UD.at < 15 * 60e3) pts.push([Math.floor(UD.at / 1000), UD.now]);
  return ptsToCandles(pts, tf, n);
}
// nilai USDT.D terbaru tiap menit selama ada chart/compare yang memakainya
async function usdtdTick() { if (!xwKeys().some(k => k.startsWith('usdtd|'))) return; const v = await usdtdNow(); if (v > 0) xTick('usdtd', Math.floor(Date.now() / 1000), v, 0); }
setInterval(() => usdtdTick().catch(() => { }), Math.max(2000, +(E.USDTD_POLL_MS || 60000)));
// harga terbaru aset Yahoo tiap 30 detik selama ada panel/compare yang memakainya
setInterval(async () => {
  const want = [...new Set(xwKeys().map(k => k.split('|')[0]).filter(p => YH_RE.test(p)))].slice(0, 12);
  for (const pr of want) { try { const { meta, pts } = await yChart(pr.slice(3), '1d', '1m'); const last = meta.regularMarketPrice != null ? +meta.regularMarketPrice : pts.length ? pts[pts.length - 1].c : null; if (last > 0) xTick(pr, Math.floor(Date.now() / 1000), last, 0); } catch (e) { } }
}, Math.max(5000, +(E.YAHOO_POLL_MS || 30000)));
async function histCandles(pair, tf, n) { // riwayat panjang untuk replay
  const p = chartPair(pair); if (!p || !TF_SEC[tf]) throw new Error('Aset atau timeframe tidak dikenal');
  const key = pair + '|' + tf + '|' + n; if (histCache[key] && Date.now() - histCache[key].at < 30000) return histCache[key].c;
  const c = p.ext ? await extCandles(pair, tf, n) : await fetchCandles(p, tf, n); histCache[key] = { at: Date.now(), c }; return c;
}

// ---------- alert harga ----------
const ALERT_FILE = path.join(CFG.dataDir, 'alerts.json');
let ALERTS = []; try { ALERTS = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); if (!Array.isArray(ALERTS)) ALERTS = []; } catch (e) { }
function saveAlerts() { try { fs.writeFileSync(ALERT_FILE + '.tmp', JSON.stringify(ALERTS, null, 1)); fs.renameSync(ALERT_FILE + '.tmp', ALERT_FILE); } catch (e) { log('Gagal simpan alert:', e.message); } }
const ALERT_COND = ['cross', 'up', 'down', 'area'];
const knownPrice = pair => pair === S.settings.pair && M.price > 0 ? M.price : (XT[pair] || {}).price || null;
function normAlert(b, cur) {
  const o = { ...(cur || {}) };
  if (b.pair != null || !cur) { const pr = String(b.pair || S.settings.pair); if (!PAIRS[pr]) throw new Error('Aset alert tidak dikenal'); o.pair = pr; }
  if (b.cond != null || !cur) { if (!ALERT_COND.includes(b.cond || 'cross')) throw new Error('Kondisi alert tidak dikenal'); o.cond = b.cond || 'cross'; }
  if (b.price != null || !cur) { const v = +b.price; if (!(v > 0 && Number.isFinite(v))) throw new Error('Isi harga alert yang valid'); o.price = v; }
  if (o.cond === 'area') { const v = b.price2 != null ? +b.price2 : o.price2; if (!(v > 0 && Number.isFinite(v)) || v === o.price) throw new Error('Area alert butuh dua harga yang berbeda'); o.price2 = v; } else delete o.price2;
  if (b.freq != null || !cur) { if (!['once', 'every'].includes(b.freq || 'every')) throw new Error('Frekuensi alert tidak dikenal'); o.freq = b.freq || 'every'; }
  if (b.note != null) o.note = String(b.note).slice(0, 120);
  if (b.sound != null) o.sound = !!b.sound; if (o.sound == null) o.sound = true;
  if (b.on != null) { o.on = !!b.on; if (o.on) { o.armed = true; o.lastPx = knownPrice(o.pair); } }
  return o;
}
const condTxt = a => a.cond === 'area' ? 'masuk area ' + fmtPx(Math.min(a.price, a.price2)) + ' – ' + fmtPx(Math.max(a.price, a.price2)) : (a.cond === 'up' ? 'naik ke ' : a.cond === 'down' ? 'turun ke ' : 'menyentuh ') + fmtPx(a.price);
function checkAlerts(pair, price) {
  let changed = false;
  for (const a of ALERTS) {
    if (!a.on || a.pair !== pair) continue;
    const prev = a.lastPx; a.lastPx = price; let hit = false, dir = '';
    if (a.cond === 'area') {
      const lo = Math.min(a.price, a.price2), hi = Math.max(a.price, a.price2), inside = price >= lo && price <= hi;
      if (inside && a.armed !== false) { hit = true; a.armed = false; } else if (!inside && a.armed === false) { a.armed = true; changed = true; }
    } else if (prev != null && prev > 0) {
      const upX = prev < a.price && price >= a.price, dnX = prev > a.price && price <= a.price;
      hit = a.cond === 'up' ? upX : a.cond === 'down' ? dnX : (upX || dnX); dir = upX ? 'naik' : dnX ? 'turun' : '';
      if (hit && a.firedAt && Date.now() - a.firedAt < 30000) hit = false; // jeda 30 detik agar tidak berbunyi terus saat harga bolak-balik di garis
    }
    if (!hit) continue;
    a.fires = (a.fires || 0) + 1; a.firedAt = Date.now(); if (a.freq === 'once') a.on = false; changed = true;
    const p = PAIRS[pair], msg = '🔔 Alert ' + (p ? p.coin.toUpperCase() : pair) + '/IDR: harga ' + condTxt(a) + ' · sekarang ' + fmtPx(price) + (dir ? ' (' + dir + ')' : '') + (a.note ? ' · ' + a.note : '');
    log(msg); broadcast({ t: 'alert', id: a.id, msg, sound: a.sound !== false, price, pair });
  }
  if (changed) { saveAlerts(); pushState(); wsSync(); }
}

// ---------- strategi baru: Stochastic bawah, MACD hijau, Fibonacci pantul ----------
const f1 = v => (+v).toFixed(1).replace('.', ',');
// "tidak membuat LL": low candle terakhir tidak lebih rendah dari low terendah N candle sebelumnya
function noLL(c, i, N) { if (i < N) return false; let m = Infinity; for (let j = i - N; j < i; j++) m = Math.min(m, c[j].low); return c[i].low >= m; }
const fibRange = fd => { const lo = Math.min(fd.p1.price, fd.p2.price), hi = Math.max(fd.p1.price, fd.p2.price); return { lo, hi }; };
const fpx = v => fmtPx(v);
// hasil: { sig: 'buy'|'hold', why, tps (harga target mutlak per bagian), slPrice (mutlak), checks: [{ label, val, ok }], gap (jarak ke sinyal) }
// o = { fd (Fibonacci gambar), cfg (pengaturan strategi), sl (Bot SL %), bt (sedang backtest) }
function evalStrat(c, st, o) {
  if (!NEW_STRATS.includes(st) || !o.cfg) return { sig: 'hold', why: '', checks: [] };
  const n = c.length, i = n - 1, cf = o.cfg, nz = IND.nz, checks = [];
  const out = (sig, why, extra) => ({ sig, why: why || '', checks, ...(extra || {}) });
  if (n < 30) return out('hold', 'Data candle belum cukup');
  const llCheck = () => {
    if (!cf.noLL) return true;
    let m = Infinity; for (let j = Math.max(0, i - cf.llN); j < i; j++) m = Math.min(m, c[j].low);
    const ok = noLL(c, i, cf.llN); checks.push({ label: 'Tidak membuat LL: low ≥ harga terendah ' + cf.llN + ' candle sebelumnya', val: fpx(c[i].low) + ' vs ' + fpx(m), ok }); return ok;
  };
  const llTxt = cf.noLL ? ', tidak membuat LL (' + cf.llN + ' candle)' : '';
  if (st === 'stoch_low') {
    const { k, d } = IND.stoch(c, cf.k, cf.d, cf.sm); if (!nz(k[i]) || !nz(d[i])) return out('hold');
    let ok = k[i] <= cf.os, why = 'Stochastic %K ' + f1(k[i]) + ' di bawah ' + cf.os;
    checks.push({ label: 'Stochastic %K ≤ ' + cf.os, val: '%K ' + f1(k[i]) + ' · %D ' + f1(d[i]), ok: k[i] <= cf.os });
    if (cf.cross) {
      ok = i >= 1 && nz(k[i - 1]) && nz(d[i - 1]) && k[i - 1] <= d[i - 1] && k[i] > d[i] && Math.min(k[i - 1], d[i - 1]) <= cf.os; why = 'Stochastic %K memotong naik %D dari bawah ' + cf.os;
      checks.push({ label: '%K memotong naik %D dari bawah ' + cf.os, val: ok ? 'ya' : 'belum', ok });
    }
    const ll = llCheck(), gap = k[i] > cf.os ? '%K perlu turun ' + f1(k[i] - cf.os) + ' poin lagi' : '';
    if (!ok) return out('hold', 'Stochastic %K ' + f1(k[i]) + ' (menunggu di bawah ' + cf.os + ')', { gap });
    if (!ll) return out('hold', 'Stochastic di bawah, tetapi candle membuat LL');
    return out('buy', why + llTxt);
  }
  if (st === 'macd_green') {
    const h = IND.macd(c.map(x => x.close), cf.f, cf.s, cf.g).hist;
    if (!(i >= 1 && nz(h[i]) && nz(h[i - 1]))) return out('hold');
    const turned = h[i - 1] <= 0 && h[i] > 0;
    checks.push({ label: 'Histogram candle sebelumnya merah (≤ 0)', val: f1(h[i - 1]), ok: h[i - 1] <= 0 });
    checks.push({ label: 'Histogram candle ini hijau (> 0)', val: f1(h[i]), ok: h[i] > 0 });
    const ll = llCheck();
    if (!turned) return out('hold', h[i] > 0 ? 'Histogram MACD sudah hijau (menunggu cross baru)' : 'Histogram MACD masih merah', { gap: h[i] > 0 ? 'Menunggu histogram merah lalu hijau lagi' : 'Histogram perlu naik ' + f1(-h[i]) + ' ke atas 0' });
    if (!ll) return out('hold', 'MACD baru hijau, tetapi candle membuat LL');
    return out('buy', 'MACD cross naik, histogram jadi hijau' + llTxt);
  }
  if (st === 'fib_rebound') {
    const fd = o.fd; if (!fd) { checks.push({ label: 'Fibonacci ditarik di chart', val: 'belum ada', ok: false }); return out('hold', 'Belum ada Fibonacci. Tarik dulu dengan tombol 📐 di chart'); }
    const fl = IND.fibLine(fd), k = c[i], { lo, hi } = fibRange(fd); if (!fl) return out('hold');
    if (o.bt && k.time < Math.max(fd.p1.t, fd.p2.t)) return out('hold'); // backtest: Fibonacci baru ada setelah titik keduanya
    const zoneTop = lo + cf.zone * (hi - lo), lv = cf.tgt === 'both' ? [0.5, 0.618] : [+cf.tgt], tps = lv.map(r => fl.at(r));
    checks.push({ label: 'Harga di zona bawah (≤ ' + fpx(zoneTop) + ')', val: fpx(k.close), ok: k.close <= zoneTop });
    checks.push({ label: 'Tidak menembus low Fibonacci (' + fpx(lo) + ')', val: 'low ' + fpx(k.low), ok: k.low >= lo });
    const ll = llCheck(), tpOk = tps.every(t => t > k.close * 1.004);
    checks.push({ label: 'Target ' + lv.map(r => String(r).replace('.', ',')).join(' & ') + ' di atas harga', val: tps.map(fpx).join(' · '), ok: tpOk });
    const gap = k.close > zoneTop ? 'Harga perlu turun ' + ((k.close / zoneTop - 1) * 100).toFixed(2).replace('.', ',') + '% lagi ke zona beli' : '';
    if (k.close > zoneTop) return out('hold', 'Menunggu harga turun ke zona bawah Fibonacci (di bawah ' + fmtPx(zoneTop) + ')', { gap });
    if (k.low < lo) return out('hold', 'Harga menembus low Fibonacci (membuat LL)');
    if (!ll) return out('hold', 'Di zona bawah, tetapi candle membuat LL');
    if (!tpOk) return out('hold', 'Target Fibonacci terlalu dekat dengan harga');
    const slPrice = cf.slMode === 'low' ? lo * (1 - o.sl / 100) : null;
    return out('buy', 'Harga di zona bawah Fibonacci dan tidak membuat LL · target ' + lv.map(r => String(r).replace('.', ',')).join(' & '), { tps, slPrice });
  }
  if (st === 'bb_band') { // beli saat candle menyentuh pita bawah Bollinger, jual saat menyentuh pita atas
    const b = IND.bb(c.map(x => x.close), cf.bbP, cf.bbK), k = c[i]; if (!nz(b.lo[i]) || !nz(b.up[i])) return out('hold');
    const touchUp = k.high >= b.up[i], touchLo = k.low <= b.lo[i];
    checks.push({ label: 'Low candle menyentuh pita bawah (' + fpx(b.lo[i]) + ')', val: 'low ' + fpx(k.low), ok: touchLo });
    checks.push({ label: 'High candle menyentuh pita atas (' + fpx(b.up[i]) + ') → jual', val: 'high ' + fpx(k.high), ok: touchUp });
    if (touchUp) return out('sell', 'Candle menyentuh pita atas Bollinger (' + fmtPx(b.up[i]) + ') → jual');
    const gap = 'Harga perlu turun ' + ((k.low / b.lo[i] - 1) * 100).toFixed(2).replace('.', ',') + '% lagi ke pita bawah';
    if (!touchLo) return out('hold', 'Menunggu candle menyentuh pita bawah Bollinger (' + fmtPx(b.lo[i]) + ')', { gap });
    if (!llCheck()) return out('hold', 'Menyentuh pita bawah, tetapi candle membuat LL');
    return out('buy', 'Candle menyentuh pita bawah Bollinger (' + fmtPx(b.lo[i]) + ')' + llTxt);
  }
  return out('hold');
}
const stratOpts = (extra) => ({ I: S.settings.ind, fd: (S.settings.fibDraw || {})[S.settings.pair] || null, cfg: S.settings.bot.cfg[S.settings.strategy], sl: S.settings.botSl, ...(extra || {}) });

// ---------- uji strategi di data lalu (backtest) ----------
// Meniru bot: masuk market di harga tutup candle bersinyal, atau limit X% di bawahnya yang kedaluwarsa setelah N candle.
// Stop Loss / Take Profit dicek di tiap candle berikutnya; bila keduanya tersentuh di candle yang sama dianggap kena Stop Loss (asumsi terburuk).
function backtest(c, st, o) {
  const trades = []; let legs = [], pend = null, cum = 0, peak = 0, maxDd = 0;
  const shut = (leg, k, exit, why) => {
    const proceeds = leg.amount * exit * (1 - o.fee), pnl = proceeds - leg.idr;
    trades.push({ in: leg.t, out: k.time, entry: leg.entry, exit, pnl, pct: pnl / leg.idr * 100, why });
    cum += pnl; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum);
  };
  const open = (plan, e, k, i) => plan.map(p => { const x = exits(e, o.sl, o.tp, p.slAbs, p.tpAbs); return { t: k.time, i, entry: e, idr: p.idr, amount: p.idr * (1 - o.fee) / e, sl: x.slPrice, tp: x.tpPrice }; });
  for (let i = 30; i < c.length; i++) {
    const k = c[i];
    if (pend) { if (k.low <= pend.price) { legs = open(pend.plan, Math.min(pend.price, k.open), k, i); pend = null; } else if (i > pend.until) pend = null; }
    legs = legs.filter(l => {
      if (k.low <= l.sl) { shut(l, k, k.open <= l.sl ? k.open : l.sl, 'Stop Loss'); return false; }
      if (i > l.i && k.high >= l.tp) { shut(l, k, k.open >= l.tp ? k.open : l.tp, 'Take Profit'); return false; }
      return true;
    });
    const r = evalStrat(c.slice(Math.max(0, i - 399), i + 1), st, { ...o.so, bt: true });
    if (r.sig === 'sell') { legs.forEach(l => shut(l, k, k.close, 'Sinyal jual')); legs = []; pend = null; }
    else if (r.sig === 'buy' && !legs.length && !pend) {
      const n = r.tps ? r.tps.length : 1, part = Math.floor(o.size / n);
      const plan = Array.from({ length: n }, (_, j) => ({ idr: j === n - 1 ? o.size - part * (n - 1) : part, tpAbs: r.tps ? r.tps[j] : null, slAbs: r.slPrice || null }));
      if (o.entry === 'limit') pend = { plan, price: k.close * (1 - o.limOff / 100), until: i + o.limExp };
      else legs = open(plan, k.close, k, i);
    }
  }
  const last = c[c.length - 1];
  const opn = legs.length ? (() => { const v = legs.reduce((s, l) => s + l.amount * last.close * (1 - o.fee) - l.idr, 0); return { in: legs[0].t, entry: legs[0].entry, now: last.close, pnl: v, pct: v / o.size * 100 }; })() : null;
  const wins = trades.filter(t => t.pnl > 0).length, pnl = trades.reduce((s, t) => s + t.pnl, 0);
  return { strategy: st, trades: trades.length, wins, winRate: trades.length ? wins / trades.length * 100 : null, pnl, pnlPct: pnl / o.size * 100, maxDd, open: opn, list: trades.slice(-60).reverse() };
}
const btCache = {};
async function btCandles(p, tf) {
  const key = p.id + '|' + tf; if (btCache[key] && Date.now() - btCache[key].at < 60000) return btCache[key].c;
  let c; try { c = await fetchCandles(p, tf, 1000); } catch (e) { throw new Error('Gagal mengambil data harga lalu dari Indodax: ' + e.message); }
  const now = bucketOf(Math.floor(Date.now() / 1000), tf); if (c.length && c[c.length - 1].time >= now) c.pop(); // hanya candle yang sudah tutup
  btCache[key] = { at: Date.now(), c }; return c;
}
async function runBacktest(b) {
  const p = P(), st = S.settings, bot = st.bot;
  const size = b.size != null ? Math.floor(+b.size) : st.botSize, sl = b.sl != null ? +b.sl : st.botSl, tp = b.tp != null ? +b.tp : st.botTp;
  if (!(size >= p.minIdr && size <= 1e10)) throw new Error('Ukuran per trade minimal ' + fmt(p.minIdr));
  if (!(sl > 0 && sl < 50) || !(tp > 0 && tp < 100)) throw new Error('Isi Stop Loss dan Take Profit yang valid');
  const list = b.strategy === 'all' ? STRATS : [b.strategy == null ? st.strategy : b.strategy]; // bawaan: hanya strategi yang dipakai bot
  if (!list.every(s => STRATS.includes(s))) throw new Error('Strategi tidak dikenal');
  const fd = (st.fibDraw || {})[p.id] || null, results = [];
  for (const s of list) {
    const cfg = bot.cfg[s], c = await btCandles(p, cfg.tf);
    if (c.length < 60) { results.push({ strategy: s, tf: cfg.tf, error: 'Data harga lalu terlalu sedikit (' + c.length + ' candle)' }); continue; }
    const o = { size, sl, tp, fee: p.fee, entry: bot.entry, limOff: bot.limOff, limExp: bot.limExp, so: { I: st.ind, fd, cfg, sl } };
    const first = c[30].close, last = c[c.length - 1].close;
    results.push({ ...backtest(c, s, o), tf: cfg.tf, from: c[30].time, to: c[c.length - 1].time, candles: c.length - 30, hold: (last * (1 - p.fee) * (1 - p.fee) / first - 1) * 100 });
  }
  return { pair: p.id, coin: p.coin, size, sl, tp, fee: p.fee, manualFib: !!fd, entry: bot.entry, limOff: bot.limOff, limExp: bot.limExp, results };
}

// ---------- log aktivitas bot (untuk dashboard) ----------
const hhmm = ms => new Date(ms + 7 * 3600e3).toISOString().slice(11, 16);
function blog(kind, msg) {
  S.botLog = Array.isArray(S.botLog) ? S.botLog : [];
  const e = { t: Date.now(), kind, msg }; S.botLog.unshift(e); if (S.botLog.length > 300) S.botLog.length = 300;
  save(); broadcast({ t: 'blog', e });
}
// data dashboard bot: syarat di candle tutup & candle berjalan, grafik kecil indikator, posisi/order bot, statistik, log
function botDash() {
  const st = S.settings, tf = BOT.tf, now = Math.floor(Date.now() / 1000), o = stratOpts();
  const all = BOT.cur ? [...BOT.candles, BOT.cur] : BOT.candles.slice();
  const closed = BOT.candles.length ? evalStrat(BOT.candles, st.strategy, o) : null, live = all.length ? evalStrat(all, st.strategy, o) : null;
  const N = 80, tail = a => a.slice(-N), cf = o.cfg; let spark = null;
  if (all.length >= 30) {
    if (st.strategy === 'stoch_low') { const { k, d } = IND.stoch(all, cf.k, cf.d, cf.sm); spark = { kind: 'stoch', a: tail(k), b: tail(d), lines: [cf.os], min: 0, max: 100 }; }
    else if (st.strategy === 'macd_green') { const h = IND.macd(all.map(x => x.close), cf.f, cf.s, cf.g).hist; spark = { kind: 'hist', a: tail(h), lines: [0] }; }
    else if (st.strategy === 'bb_band') { const b = IND.bb(all.map(x => x.close), cf.bbP, cf.bbK), j = all.length - 1; spark = { kind: 'price', a: tail(all.map(x => x.close)), lines: [b.lo[j], b.mid[j], b.up[j]].filter(v => v != null) }; }
    else { const cl = tail(all.map(x => x.close)), fd = o.fd; let lines = []; if (fd) { const fl = IND.fibLine(fd), { lo, hi } = fibRange(fd); lines = [lo, lo + cf.zone * (hi - lo), ...(cf.tgt === 'both' ? [0.5, 0.618] : [+cf.tgt]).map(r => fl.at(r))]; } spark = { kind: 'price', a: cl, lines }; }
  }
  const hist = S.history.filter(h => h.isBot), day = wibDay(), isToday = h => new Date(h.closedAt + 7 * 3600e3).toISOString().slice(0, 10) === day;
  const pos = S.positions.filter(p => p.isBot), fee = (P() || {}).fee || 0.003;
  const open = pos.map(p => ({ ...p, now: p.pair === st.pair ? M.price : null, upnl: p.pair === st.pair ? p.amount * M.price * (1 - fee) - p.cost : 0 }));
  return { strategy: st.strategy, tf, active: st.botActive, entry: st.bot.entry, check: st.bot.check, limOff: st.bot.limOff, size: st.botSize, sl: st.botSl, tp: st.botTp,
    pair: st.pair, coin: (P() || {}).coin, price: M.price, now, nextClose: bucketOf(now, tf) + (TF_SEC[tf] || 60), ready: BOT.candles.length > 0,
    closed: closed && { ...closed, time: BOT.candles[BOT.candles.length - 1].time }, live: live && { ...live, time: all[all.length - 1].time }, spark,
    stats: { trades: hist.length, wins: hist.filter(h => h.pnl > 0).length, pnl: hist.reduce((a, h) => a + h.pnl, 0), today: hist.filter(isToday).length, todayPnl: hist.filter(isToday).reduce((a, h) => a + h.pnl, 0), openPnl: open.reduce((a, p) => a + p.upnl, 0) },
    positions: open, orders: S.orders.filter(x => x.isBot), recent: hist.slice(0, 20), log: (S.botLog || []).slice(0, 150) };
}

// ---------- mesin bot: candle sendiri sesuai timeframe strategi ----------
const BOT = { key: '', tf: '15', candles: [], cur: null, loading: false, failAt: 0, lastEval: 0, entryBucket: 0, why: '', busy: false };
let lastSignal = 'hold';
async function botLoad(force) {
  const tf = (S.settings.bot.cfg[S.settings.strategy] || {}).tf || '15', key = S.settings.pair + '|' + tf;
  if (!force && BOT.key === key && BOT.candles.length) return;
  BOT.key = key; BOT.tf = tf; BOT.loading = true;
  try {
    let kk;
    if (tf === S.settings.tf && M.candles.length) kk = [...M.candles, ...(M.cur ? [{ ...M.cur }] : [])].map(x => ({ ...x }));
    else kk = await fetchCandles(P(), tf, 300);
    if (BOT.key !== key) return; // pengaturan berubah saat memuat
    const now = bucketOf(Math.floor(Date.now() / 1000), tf);
    BOT.cur = kk.length && kk[kk.length - 1].time >= now ? kk.pop() : null; BOT.candles = kk.slice(-400);
    log('Bot: ' + BOT.candles.length + ' candle ' + tf + ' untuk ' + P().symbol);
  } catch (e) { BOT.key = ''; BOT.failAt = Date.now(); log('Bot gagal memuat candle:', e.message); }
  finally { if (BOT.key === key || !BOT.key) BOT.loading = false; }
  botRefresh();
}
function botRefresh() { // sinyal untuk tampilan (candle yang sudah tutup)
  const r = BOT.candles.length ? evalStrat(BOT.candles, S.settings.strategy, stratOpts()) : { sig: 'hold', why: BOT.loading ? 'Memuat candle…' : '' };
  lastSignal = r.sig; BOT.why = r.why || ''; broadcast({ t: 'signal', signal: lastSignal, why: BOT.why, tf: BOT.tf });
}
function botTick(ts, price) {
  if (EDITION === 'basic') return; // Basic: tanpa bot
  if (!BOT.key) { if (Date.now() - BOT.failAt > 30000) botLoad(); return; }
  if (BOT.loading) return;
  const b = bucketOf(ts, BOT.tf);
  if (BOT.cur && b > BOT.cur.time) {
    const closed = BOT.cur; BOT.candles.push(closed); if (BOT.candles.length > 400) BOT.candles.shift(); BOT.cur = null;
    botRefresh();
    if (S.settings.botActive) blog(lastSignal === 'buy' ? 'signal' : 'eval', 'Candle ' + hhmm(closed.time * 1000) + ' (' + BOT.tf + ') tutup · ' + (lastSignal === 'buy' ? 'SINYAL BELI' : 'tahan') + (BOT.why ? ' · ' + BOT.why : ''));
    if (S.settings.bot.check === 'close') botEval(BOT.candles, closed.time);
  }
  if (!BOT.cur || b > BOT.cur.time) BOT.cur = { time: b, open: price, high: price, low: price, close: price, volume: 0 };
  else if (b === BOT.cur.time) { BOT.cur.high = Math.max(BOT.cur.high, price); BOT.cur.low = Math.min(BOT.cur.low, price); BOT.cur.close = price; }
  if (S.settings.bot.check === 'live' && Date.now() - BOT.lastEval > 2000) { BOT.lastEval = Date.now(); botEval([...BOT.candles, BOT.cur], BOT.cur.time); }
  botExpire();
}
let expAt = 0;
function botExpire() { // batalkan limit beli bot yang belum terisi setelah N candle
  if (Date.now() - expAt < 3000) return; expAt = Date.now();
  for (const o of S.orders) if (o.isBot && o.kind === 'buy' && o.expAt && Date.now() > o.expAt && !o.cancelling) cancelOrder(o.id, true).then(() => toast('🤖 Limit beli bot kedaluwarsa, dibatalkan', 'info')).catch(e => log('Gagal batalkan limit bot:', e.message));
}
async function botEval(c, bucket) {
  const st = S.settings; if (!st.botActive || BOT.busy) return;
  const r = evalStrat(c, st.strategy, stratOpts());
  const mine = S.positions.filter(p => p.isBot && p.pair === st.pair), pend = S.orders.filter(o => o.isBot && o.kind === 'buy' && o.pair === st.pair);
  if (r.sig === 'sell') { pend.forEach(o => cancelOrder(o.id, true).catch(() => { })); mine.forEach(p => closePos(p.id, 'Sinyal bot')); return; }
  if (r.sig !== 'buy' || mine.length || pend.length || BOT.entryBucket === bucket) return;
  BOT.entryBucket = bucket; BOT.busy = true; // satu kali masuk per candle
  try { toast('🤖 ' + r.why + ' (' + st.strategy + ', ' + BOT.tf + ')', 'info'); blog('signal', 'Sinyal beli: ' + r.why); await botEnter(r); }
  catch (e) { toast('🤖 Bot gagal beli: ' + e.message, 'error'); blog('error', 'Gagal beli: ' + e.message); }
  finally { BOT.busy = false; }
}
async function botEnter(r) {
  const st = S.settings, b = st.bot, p = P(), size = st.botSize, n = r.tps ? r.tps.length : 1, part = Math.floor(size / n);
  if (n > 1 && part < p.minIdr) throw new Error('Ukuran trade terlalu kecil untuk dibagi dua target (minimal ' + fmt(p.minIdr * 2) + ')');
  for (let j = 0; j < n; j++) {
    const fut = st.botMarket === 'futures';
    const leg = { idr: j === n - 1 ? size - part * (n - 1) : part, sl: st.botSlOn !== false ? st.botSl : null, tp: st.botTpOn !== false ? st.botTp : null, isBot: true, tpPrice: r.tps ? r.tps[j] : null, slPrice: st.botSlOn !== false ? r.slPrice || null : null, tag: st.strategy + (n > 1 ? ' #' + (j + 1) : ''),
      ...(fut ? { market: 'futures', side: 'long', lev: st.botLev || 10, mm: st.botMM || 'isolated' } : {}) };
    if (b.entry === 'limit' && !fut) { const o = await placeLimit({ side: 'buy', ...leg, price: M.price * (1 - b.limOff / 100), expAt: Date.now() + b.limExp * (TF_SEC[BOT.tf] || 60) * 1000 }); blog('order', 'Limit beli dipasang ' + fmt(o.idr) + ' di ' + fmtPx(o.price) + (o.tpAbs ? ' · target ' + fmtPx(o.tpAbs) : '') + ' · batal otomatis setelah ' + b.limExp + ' candle'); }
    else { const p = await openPos(leg); blog('fill', (p.type === 'futures' ? 'Long futures ' + p.lev + 'x margin ' + fmt(p.margin) : 'Beli market ' + fmt(p.cost)) + ' di ' + fmtPx(p.entryPrice) + ' · SL ' + pxOr(p.slPrice) + ' · TP ' + pxOr(p.tpPrice) + (p.liqPrice ? ' · likuidasi ' + fmtPx(p.liqPrice) : '')); }
  }
}

// ---------- order live (V2 dan V1) ----------
// tunggu order V2 mencapai status akhir (market order biasanya langsung FILLED); null bila tak terbaca
async function waitOrder(p, oid) {
  if (oid == null) return null; let o = null;
  for (let i = 0; i < 8; i++) {
    await sleep(i ? 1000 : 600);
    try { o = await tapi2('GET', '/api/v2/order', { symbol: p.id.toUpperCase(), orderId: String(oid) }); } catch (e) { continue; }
    if (['FILLED', 'CANCELLED', 'REJECTED'].includes(o.status)) break;
  }
  return o;
}
// beli market senilai idr rupiah -> { coin, cost, oid }
async function liveBuy(p, idr) {
  const ver = await getVer(), before = await balances(), c0 = before.coins[p.coin] || 0, cid = 'tbp-' + Date.now().toString(36);
  if (ver === 'v1') {
    const r = await tapi('trade', { pair: p.ticker, type: 'buy', order_type: 'market', idr: String(idr), client_order_id: cid });
    let coin = +r['receive_' + p.coin] || 0; const cost = +r.spend_rp || idr;
    if (!(coin > 0)) { await sleep(1500); coin = Math.max(0, ((await balances()).coins[p.coin] || 0) - c0); }
    if (!(coin > 0)) throw new Error('Order terkirim (id ' + (r.order_id || '?') + ') tetapi jumlah koin belum terisi. Cek aplikasi Indodax.');
    return { coin, cost, oid: r.order_id || null };
  }
  const r = await tapi2('POST', '/api/v2/order', { symbol: p.id.toUpperCase(), side: 'BUY', type: 'MARKET', quoteOrderQty: String(idr), newClientOrderId: cid });
  const oid = r.orderId != null ? r.orderId : null, o = await waitOrder(p, oid);
  if (o && ['CANCELLED', 'REJECTED'].includes(o.status) && !(+o.executedQty > 0)) throw new Error('Order beli ' + o.status + ' oleh Indodax (id ' + oid + ')');
  await sleep(500);
  const after = await balances(), exec = +((o || r).executedQty) || 0, diff = (after.coins[p.coin] || 0) - c0;
  const coin = exec > 0 && diff > 0 ? Math.min(exec, diff) : (diff > 0 ? diff : exec); // diff = saldo bersih setelah fee
  if (!(coin > 0)) throw new Error('Order terkirim (id ' + oid + ') tetapi jumlah koin belum terisi. Cek aplikasi Indodax.');
  const spent = before.idr - after.idr, cost = spent >= idr * 0.9 && spent <= idr * 1.001 ? spent : idr;
  return { coin, cost, oid };
}
// jual market sejumlah amt koin; idrBefore = saldo IDR sebelum jual -> { proceeds (0 bila tak diketahui), oid }
async function liveSell(p, amt, idrBefore) {
  const ver = await getVer(), cid = 'tbp-' + Date.now().toString(36);
  if (ver === 'v1') {
    const r = await tapi('trade', { pair: p.ticker, type: 'sell', order_type: 'market', [p.coin]: amt.toFixed(8), client_order_id: cid });
    return { proceeds: +r.receive_rp || +r.receive_idr || 0, oid: r.order_id || null };
  }
  const r = await tapi2('POST', '/api/v2/order', { symbol: p.id.toUpperCase(), side: 'SELL', type: 'MARKET', quantity: amt.toFixed(8), newClientOrderId: cid });
  const oid = r.orderId != null ? r.orderId : null, o = await waitOrder(p, oid);
  if (o && ['CANCELLED', 'REJECTED'].includes(o.status) && !(+o.executedQty > 0)) throw new Error('Order jual ' + o.status + ' oleh Indodax (id ' + oid + ')');
  await sleep(500);
  const diff = (await balances()).idr - idrBefore;
  return { proceeds: diff > 0 ? diff : 0, oid };
}

// ---------- order & posisi ----------
let busy = false;
const fmt = n => 'Rp ' + Math.round(n).toLocaleString('id-ID');
let UID = 0;
const uid = pre => pre + Date.now().toString(36) + (++UID).toString(36);
// SL/TP posisi: harga mutlak bila diberikan (misal target Fibonacci), selain itu persen dari harga masuk
// sl / tp = null: posisi tanpa Stop Loss / Take Profit (hanya untuk order manual)
function exits(entry, sl, tp, slAbs, tpAbs) {
  const slPrice = slAbs > 0 && slAbs < entry ? slAbs : sl > 0 ? entry * (1 - sl / 100) : null, tpPrice = tpAbs > entry ? tpAbs : tp > 0 ? entry * (1 + tp / 100) : null;
  return { slPrice, tpPrice, slPercent: slPrice == null ? null : +((1 - slPrice / entry) * 100).toFixed(2), tpPercent: tpPrice == null ? null : +((tpPrice / entry - 1) * 100).toFixed(2) };
}
const optPct = v => v == null || v === '' || v === false ? null : +v; // kosong = tanpa SL/TP
function checkSlTpIn(sl, tp) {
  if (sl != null && !(sl > 0 && sl < 50)) throw new Error('Stop Loss harus 0,1% sampai 49,9% (atau matikan Stop Loss)');
  if (tp != null && !(tp > 0 && tp < 100)) throw new Error('Take Profit harus 0,1% sampai 99,9% (atau matikan Take Profit)');
}
// ---------- futures (hanya simulasi: Indodax belum punya API futures publik) ----------
const FUT_MAX_LEV = 100, FUT_FEE = 0.0005, FUT_MMR = 0.005; // biaya 0,05% per sisi, margin pemeliharaan 0,5%
const FUT_LIVE_MSG = 'Futures hanya tersedia di mode simulasi (API futures Indodax belum tersedia untuk aplikasi ini)';
const pxOr = v => v == null ? 'tanpa' : fmtPx(v);
// harga likuidasi. cross: seluruh saldo bebas ikut jadi jaminan (dihitung saat posisi dibuka)
function futLiq(side, entry, lev, mm, margin, free) {
  const cover = mm === 'cross' ? (margin + Math.max(0, free)) / (margin * lev) : 1 / lev;
  return side === 'long' ? Math.max(0, entry * (1 - cover + FUT_MMR)) : entry * (1 + cover - FUT_MMR);
}
function futPnl(pos, px) { return (pos.side === 'short' ? pos.entryPrice - px : px - pos.entryPrice) * pos.amount; }
async function openFut({ idr, sl, tp, isBot, tpPrice, tag, side, lev, mm }) {
  const p = P(); idr = Math.floor(+idr); lev = Math.round(+lev); sl = optPct(sl); tp = optPct(tp);
  if (LIVE) throw new Error(FUT_LIVE_MSG);
  if (!['long', 'short'].includes(side)) throw new Error('Pilih Long atau Short');
  if (!(lev >= 1 && lev <= FUT_MAX_LEV)) throw new Error('Leverage harus 1x sampai ' + FUT_MAX_LEV + 'x');
  if (!['isolated', 'cross'].includes(mm)) throw new Error('Mode margin tidak dikenal');
  if (!(M.price > 0)) throw new Error('Harga belum tersedia');
  if (!(idr >= p.minIdr)) throw new Error('Margin minimal ' + fmt(p.minIdr));
  checkSlTpIn(sl, tp);
  if (S.dayPnl <= -CFG.dailyLoss) throw new Error('Batas rugi harian tercapai (' + fmt(CFG.dailyLoss) + '). Trading berhenti sampai besok.');
  const entry = M.price, notional = idr * lev, fee = notional * FUT_FEE;
  if (idr + fee > S.paper.idr) throw new Error('Saldo simulasi tidak cukup untuk margin ' + fmt(idr) + ' + biaya ' + fmt(fee));
  S.paper.idr -= idr + fee;
  const L = side === 'long' ? 1 : -1, liq = futLiq(side, entry, lev, mm, idr, S.paper.idr);
  let slP = sl != null ? entry * (1 - L * sl / 100) : null, tpP = tp != null ? entry * (1 + L * tp / 100) : null;
  if (side === 'long' && tpPrice > entry) tpP = tpPrice;
  const pos = { id: uid(isBot ? 'bot_' : 'fut_'), type: 'futures', side, lev, mm, pair: p.id, coin: p.coin, amount: notional / entry, margin: idr, notional, cost: idr + fee, fee, entryPrice: entry, slPrice: slP, tpPrice: tpP, liqPrice: liq,
    slPercent: sl, tpPercent: tp, isBot: !!isBot, tag: tag || null, openedAt: Date.now() };
  S.positions.push(pos); save();
  toast((isBot ? '🤖 Bot ' : '✅ ') + (side === 'long' ? 'Long ' : 'Short ') + p.coin.toUpperCase() + ' ' + lev + 'x ' + (mm === 'cross' ? 'cross' : 'isolated') + ' · margin ' + fmt(idr) + ' di ' + fmtPx(entry) + ' · likuidasi ' + fmtPx(liq) + ' (simulasi)', isBot ? 'info' : 'success');
  pushState(); return pos;
}
function closeFut(pos, reason) {
  const exit = M.price, pnl = futPnl(pos, exit), fee = exit * pos.amount * FUT_FEE;
  let proceeds = pos.margin + pnl - fee;
  if (reason === 'Likuidasi') proceeds = pos.mm === 'cross' ? Math.min(0, pos.margin + pnl - fee) : 0;
  if (pos.mm !== 'cross') proceeds = Math.max(0, proceeds); // isolated: rugi maksimal sebesar margin
  S.paper.idr = Math.max(0, S.paper.idr + proceeds);
  bookClose(pos, exit, proceeds, reason, ' (simulasi futures)');
}
async function openPos({ idr, sl, tp, isBot, slPrice, tpPrice, tag, market, side, lev, mm }) {
  if (market === 'futures') { if (busy) throw new Error('Order lain sedang diproses'); busy = true; try { return await openFut({ idr, sl, tp, isBot, tpPrice, tag, side, lev, mm }); } finally { busy = false; } }
  rollDay();
  if (LIVE && !LIC.canLive()) throw new Error(LIC_MSG);
  const p = P(); idr = Math.floor(+idr); sl = optPct(sl); tp = optPct(tp);
  if (!(M.price > 0)) throw new Error('Harga belum tersedia');
  if (!(idr >= p.minIdr)) throw new Error('Minimal order ' + fmt(p.minIdr));
  checkSlTpIn(sl, tp, isBot);
  if (tpPrice != null && !(tpPrice > M.price)) throw new Error('Target jual sudah di bawah harga sekarang');
  if (S.dayPnl <= -CFG.dailyLoss) throw new Error('Batas rugi harian tercapai (' + fmt(CFG.dailyLoss) + '). Trading berhenti sampai besok.');
  if (busy) throw new Error('Order lain sedang diproses');
  busy = true;
  try {
    let coin, entry, cost, oid = null;
    if (LIVE) {
      const r = await liveBuy(p, idr);
      oid = r.oid; coin = r.coin; cost = r.cost;
      entry = cost / coin;
      refreshLive();
    } else {
      if (idr > S.paper.idr) throw new Error('Saldo simulasi tidak cukup');
      entry = M.price; cost = idr; coin = idr * (1 - p.fee) / entry; S.paper.idr -= idr;
    }
    const pos = { id: uid(isBot ? 'bot_' : 'pos_'), pair: p.id, coin: p.coin, amount: coin, cost, entryPrice: entry, ...exits(entry, sl, tp, slPrice, tpPrice), isBot: !!isBot, tag: tag || null, openedAt: Date.now(), orderId: oid };
    S.positions.push(pos); save();
    toast((isBot ? '🤖 Bot beli ' : '✅ Beli ') + p.coin.toUpperCase() + ' ' + fmt(cost) + ' di ' + fmtPx(entry) + (LIVE ? ' (LIVE)' : ' (simulasi)'), isBot ? 'info' : 'success');
    pushState(); return pos;
  } finally { busy = false; }
}
async function closePos(id, reason) {
  const i = S.positions.findIndex(x => x.id === id); if (i < 0) return;
  const pos = S.positions[i]; if (pos.closing) return; pos.closing = true;
  try {
    if (pos.type === 'futures') { closeFut(pos, reason); return; }
    if (pos.lim) { await cancelOrder(pos.lim, true); if (!S.positions.includes(pos)) return; } // batalkan jual limit dulu agar koin tidak terkunci
    const p = PAIRS[pos.pair] || P(); let proceeds, exit, note = '';
    if (LIVE) {
      const b0 = await balances(), amt = Math.floor(Math.min(pos.amount, b0.coins[pos.coin] || 0) * 1e8) / 1e8;
      if (!(amt > 0)) throw new Error('Saldo ' + pos.coin.toUpperCase() + ' di Indodax kosong; posisi mungkin sudah dijual manual');
      const r = await liveSell(p, amt, b0.idr);
      proceeds = r.proceeds;
      if (!(proceeds > 0)) { proceeds = amt * M.price * (1 - p.fee); note = ' (perkiraan)'; }
      exit = proceeds / amt; refreshLive();
    } else { exit = M.price; proceeds = pos.amount * exit * (1 - p.fee); S.paper.idr += proceeds; }
    bookClose(pos, exit, proceeds, reason, note);
  } catch (e) {
    pos.closing = false; pos.fails = (pos.fails || 0) + 1; pos.failAt = Date.now();
    if (pos.fails === 1 || pos.fails % 10 === 0) toast('Gagal menutup posisi (percobaan ' + pos.fails + '): ' + e.message + '. Dicoba lagi tiap 30 detik.', 'error');
    pushState();
  }
}
// catat penutupan posisi (penuh, atau sebagian bila pos bukan elemen S.positions) ke riwayat dan P&L
function bookClose(pos, exit, proceeds, reason, note) {
  const pnl = proceeds - pos.cost; rollDay(); S.dayPnl += pnl; S.totalPnl += pnl;
  const i = S.positions.indexOf(pos); if (i >= 0) S.positions.splice(i, 1);
  S.history.unshift({ ...pos, closing: undefined, fails: undefined, failAt: undefined, lim: undefined, exitPrice: exit, proceeds, pnl, reason: reason + (note || ''), closedAt: Date.now() }); S.history = S.history.slice(0, 200);
  if (pos.isBot) blog('exit', 'Posisi bot ditutup · ' + reason + (note || '') + ' · keluar ' + fmtPx(exit) + ' · P&L ' + (pnl >= 0 ? '+' : '') + fmt(pnl));
  save(); toast((pnl >= 0 ? '✅ ' : '❌ ') + 'Posisi ditutup · ' + reason + ' · P&L ' + (pnl >= 0 ? '+' : '') + fmt(pnl), pnl >= 0 ? 'success' : 'error');
  if (S.dayPnl <= -CFG.dailyLoss && S.settings.botActive) { S.settings.botActive = false; save(); toast('⛔ Batas rugi harian tercapai. Bot dimatikan.', 'error'); }
  pushState();
}
function checkSlTp() {
  const px = M.price;
  for (const pos of S.positions.slice()) {
    if (pos.pair !== S.settings.pair || pos.closing || (pos.failAt && Date.now() - pos.failAt < 30000)) continue;
    if (pos.type === 'futures') { // likuidasi lebih dulu, lalu SL/TP (arah short terbalik)
      const sh = pos.side === 'short';
      if (sh ? px >= pos.liqPrice : px <= pos.liqPrice) closePos(pos.id, 'Likuidasi');
      else if (pos.slPrice != null && (sh ? px >= pos.slPrice : px <= pos.slPrice)) closePos(pos.id, 'Stop Loss');
      else if (pos.tpPrice != null && (sh ? px <= pos.tpPrice : px >= pos.tpPrice)) closePos(pos.id, 'Take Profit');
      continue;
    }
    if (pos.lim && (pos.slPrice == null || px > pos.slPrice)) continue; // punya jual limit: itulah target keluarnya, hanya Stop Loss yang tetap menjaga
    if (pos.slPrice != null && px <= pos.slPrice) closePos(pos.id, 'Stop Loss'); else if (pos.tpPrice != null && px >= pos.tpPrice) closePos(pos.id, 'Take Profit');
  }
}

// ---------- limit order ----------
const rnd = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };
const flo = (n, d) => { const f = 10 ** d; return Math.floor(n * f + 1e-9) / f; };
const pxDec = (p, price) => p.priceDec != null ? p.priceDec : price < 1 ? 8 : price < 10 ? 6 : price < 1000 ? 2 : 0;
// kirim order limit ke Indodax -> id order di exchange
async function exPlace(p, side, price, qty, idr) {
  const ver = await getVer(), cid = 'tbp-' + Date.now().toString(36), pd = pxDec(p, price);
  if (ver === 'v1') {
    const prm = { pair: p.ticker, type: side, order_type: 'limit', price: price.toFixed(pd), client_order_id: cid };
    if (side === 'buy') prm.idr = String(Math.floor(idr)); else prm[p.coin] = qty.toFixed(8);
    const r = await tapi('trade', prm); return r.order_id;
  }
  const r = await tapi2('POST', '/api/v2/order', { symbol: p.id.toUpperCase(), side: side.toUpperCase(), type: 'LIMIT', price: price.toFixed(pd), quantity: qty.toFixed(p.qtyDec), newClientOrderId: cid });
  if (r.orderId == null) throw new Error('Indodax tidak mengembalikan id order');
  return r.orderId;
}
async function exCancel(o) {
  const p = PAIRS[o.pair] || P();
  if ((await getVer()) === 'v1') return tapi('cancelOrder', { pair: p.ticker, order_id: String(o.oid), type: o.kind });
  return tapi2('DELETE', '/api/v2/order', { symbol: p.id.toUpperCase(), orderId: String(o.oid) });
}
// status order di exchange -> { state: 'open'|'filled'|'cancelled', executed: jumlah koin terisi }
async function exGet(o) {
  const p = PAIRS[o.pair] || P();
  if ((await getVer()) === 'v1') {
    const r = await tapi('getOrder', { pair: p.ticker, order_id: String(o.oid) }), s = String((r.order || {}).status || '').toLowerCase();
    return { state: s === 'filled' ? 'filled' : s === 'cancelled' || s === 'canceled' ? 'cancelled' : 'open', executed: s === 'filled' ? o.qty : 0 };
  }
  const r = await tapi2('GET', '/api/v2/order', { symbol: p.id.toUpperCase(), orderId: String(o.oid) });
  const s = String(r.status || '').toUpperCase(), ex = +r.executedQty || 0;
  return { state: s === 'FILLED' ? 'filled' : ['CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(s) ? 'cancelled' : 'open', executed: ex };
}
async function placeLimit(b) {
  rollDay();
  const p = P(), side = b.side === 'sell' ? 'sell' : b.side === 'buy' ? 'buy' : null;
  if (!side) throw new Error('Sisi order harus beli atau jual');
  if (side === 'buy' && LIVE && !LIC.canLive()) throw new Error(LIC_MSG);
  if (!(M.price > 0)) throw new Error('Harga belum tersedia');
  const price = rnd(+b.price, pxDec(p, +b.price));
  if (!(price > 0)) throw new Error('Isi harga limit yang valid');
  if (Math.abs(price / M.price - 1) > 0.3) throw new Error('Harga limit menyimpang lebih dari 30% dari harga pasar (' + fmtPx(M.price) + '). Periksa kembali angkanya.');
  if (S.orders.length >= 20) throw new Error('Terlalu banyak order terbuka (maksimal 20)');
  if (busy) throw new Error('Order lain sedang diproses');
  busy = true;
  try {
    let o; const id = uid('ord_');
    if (side === 'buy') {
      const idr = Math.floor(+b.idr), sl = optPct(b.sl), tp = optPct(b.tp);
      if (!(idr >= p.minIdr)) throw new Error('Minimal order ' + fmt(p.minIdr));
      checkSlTpIn(sl, tp, !!b.isBot);
      if (S.dayPnl <= -CFG.dailyLoss) throw new Error('Batas rugi harian tercapai (' + fmt(CFG.dailyLoss) + '). Trading berhenti sampai besok.');
      const qty = flo(idr / price, p.qtyDec);
      if (!(qty > 0) || qty < p.minCoin) throw new Error('Jumlah koin terlalu kecil untuk harga ini');
      const cost = Math.round(qty * price);
      if (!LIVE && cost > S.paper.idr) throw new Error('Saldo simulasi tidak cukup');
      if (b.tpPrice != null && !(+b.tpPrice > price)) throw new Error('Target jual harus di atas harga limit');
      o = { id, kind: 'buy', pair: p.id, coin: p.coin, price, qty, idr: cost, sl, tp, live: LIVE, createdAt: Date.now(), executed: 0,
        isBot: !!b.isBot, slAbs: +b.slPrice > 0 ? +b.slPrice : null, tpAbs: +b.tpPrice > 0 ? +b.tpPrice : null, expAt: +b.expAt > 0 ? +b.expAt : null, tag: b.tag || null };
      if (LIVE) o.oid = await exPlace(p, 'buy', price, qty, idr); else S.paper.idr -= cost; // simulasi: dana dicadangkan
    } else {
      const pos = S.positions.find(x => x.id === b.posId);
      if (!pos) throw new Error('Posisi tidak ditemukan');
      if (pos.type === 'futures') throw new Error('Jual limit belum tersedia untuk posisi futures; pakai Tutup, SL, atau TP');
      if (pos.lim) throw new Error('Posisi ini sudah punya order jual limit');
      if (pos.closing) throw new Error('Posisi sedang ditutup');
      if (pos.pair !== p.id) throw new Error('Pindah ke pair posisi ini dulu');
      let qty = pos.amount; if (LIVE) qty = Math.min(qty, (await balances()).coins[pos.coin] || 0);
      qty = flo(qty, p.qtyDec); if (!(qty > 0)) throw new Error('Saldo ' + pos.coin.toUpperCase() + ' tidak cukup untuk dijual');
      o = { id, kind: 'sell', pair: p.id, coin: p.coin, price, qty, posId: pos.id, live: LIVE, createdAt: Date.now(), executed: 0 };
      if (LIVE) o.oid = await exPlace(p, 'sell', price, qty, 0);
      pos.lim = o.id;
    }
    S.orders.push(o); save();
    toast('🧾 Limit ' + (side === 'buy' ? 'beli ' : 'jual ') + p.coin.toUpperCase() + ' dipasang di ' + fmtPx(price) + (LIVE ? ' (LIVE)' : ' (simulasi)'), 'info');
    checkPaperOrders(); refreshLive(); pushState(); return o;
  } finally { busy = false; }
}
function removeOrder(o, why) {
  const i = S.orders.indexOf(o); if (i < 0) return; S.orders.splice(i, 1);
  if (o.kind === 'sell') { const pos = S.positions.find(x => x.id === o.posId); if (pos) pos.lim = null; }
  if (o.isBot) blog('cancel', 'Order limit bot di ' + fmtPx(o.price) + ' ' + why);
  save(); toast('🧾 Order limit ' + (o.kind === 'buy' ? 'beli ' : 'jual ') + o.coin.toUpperCase() + ' ' + why, 'info'); pushState();
}
// order terisi sebanyak qtyExec pada harga pxFill (buat posisi untuk beli, tutup posisi untuk jual)
function fillOrder(o, qtyExec, pxFill) {
  const i = S.orders.indexOf(o); if (i < 0) return; S.orders.splice(i, 1);
  const p = PAIRS[o.pair] || P();
  if (o.kind === 'buy') {
    const cost = qtyExec * pxFill, coin = qtyExec * (1 - p.fee), entry = cost / coin;
    if (!o.live) S.paper.idr += o.idr - cost; // simulasi: kembalikan selisih dana yang dicadangkan
    const pos = { id: uid(o.isBot ? 'bot_' : 'pos_'), pair: o.pair, coin: o.coin, amount: coin, cost, entryPrice: entry, ...exits(entry, o.sl, o.tp, o.slAbs, o.tpAbs), isBot: !!o.isBot, tag: o.tag || null, openedAt: Date.now(), orderId: o.oid || null, viaLimit: true };
    S.positions.push(pos); save();
    if (o.isBot) blog('fill', 'Limit beli terisi ' + fmt(cost) + ' di ' + fmtPx(pxFill) + ' · SL ' + pxOr(pos.slPrice) + ' · TP ' + pxOr(pos.tpPrice));
    toast((o.isBot ? '🤖 Limit beli bot ' : '✅ Limit beli ') + o.coin.toUpperCase() + ' terisi ' + fmt(cost) + ' di ' + fmtPx(pxFill) + (o.live ? ' (LIVE)' : ' (simulasi)'), 'success'); pushState(); refreshLive(); return;
  }
  const pos = S.positions.find(x => x.id === o.posId); if (!pos) { save(); pushState(); return; }
  pos.lim = null;
  const proceeds = qtyExec * pxFill * (1 - p.fee), rest = pos.amount - qtyExec;
  if (!o.live) S.paper.idr += proceeds;
  if (rest * pxFill < p.minIdr || rest <= pos.amount * 0.001) bookClose(pos, pxFill, proceeds, 'Limit jual', o.live ? ' (perkiraan)' : '');
  else { // terjual sebagian: catat bagian yang terjual, sisanya tetap terbuka
    const f = qtyExec / pos.amount, part = { ...pos, id: pos.id + '_p' + Date.now(), amount: qtyExec, cost: pos.cost * f };
    pos.amount = rest; pos.cost -= part.cost;
    bookClose(part, pxFill, proceeds, 'Limit jual sebagian', o.live ? ' (perkiraan)' : '');
  }
  refreshLive();
}
function checkPaperOrders() {
  if (LIVE || !S.orders.length || !(M.price > 0)) return;
  for (const o of S.orders.slice()) {
    if (o.live || o.pair !== S.settings.pair) continue;
    if (o.kind === 'buy' && M.price <= o.price) fillOrder(o, o.qty, Math.min(o.price, M.price));
    else if (o.kind === 'sell' && M.price >= o.price) fillOrder(o, o.qty, Math.max(o.price, M.price));
  }
}
// sinkronkan satu order live dengan Indodax; mengembalikan status terakhir atau null bila gagal dibaca
async function syncOrder(o) {
  let g; try { g = await exGet(o); } catch (e) { o.err = e.message; return null; }
  o.err = '';
  if (g.state === 'open') { if (g.executed !== o.executed) { o.executed = g.executed; pushState(); } return g; }
  if (g.state === 'filled') fillOrder(o, g.executed > 0 ? g.executed : o.qty, o.price);
  else if (g.executed > 0) fillOrder(o, g.executed, o.price); // dibatalkan setelah terisi sebagian
  else removeOrder(o, 'dibatalkan atau ditolak');
  return g;
}
let ordPolling = false;
async function pollOrders() {
  if (ordPolling || !LIVE || !S.orders.length) return; ordPolling = true;
  try { for (const o of S.orders.slice()) if (o.live && o.oid != null && !o.cancelling) await syncOrder(o); } finally { ordPolling = false; }
}
setInterval(pollOrders, 4000);
async function cancelOrder(id, silent) {
  const o = S.orders.find(x => x.id === id);
  if (!o) { if (silent) return; throw new Error('Order tidak ditemukan (mungkin sudah terisi)'); }
  if (o.cancelling) return; o.cancelling = true;
  try {
    if (!o.live) { if (o.kind === 'buy') S.paper.idr += o.idr; removeOrder(o, 'dibatalkan'); return; }
    try { await exCancel(o); }
    catch (e) { await syncOrder(o); if (!S.orders.includes(o)) return; throw new Error('Gagal membatalkan order: ' + e.message); } // bila ternyata sudah terisi, syncOrder yang memprosesnya
    const g = await syncOrder(o);
    if (S.orders.includes(o)) { if (g && g.state === 'open') throw new Error('Permintaan batal terkirim tetapi order masih tercatat terbuka di Indodax. Cek lagi sebentar.'); removeOrder(o, 'dibatalkan'); }
  } finally { o.cancelling = false; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtPx = n => 'Rp ' + (+n).toLocaleString('id-ID', { maximumFractionDigits: n < 10 ? 6 : n < 1000 ? 2 : 0 });

// saldo live
const L = { idr: null, hold: null, coins: {}, at: 0, err: '' };
async function refreshLive() {
  if (!LIVE) return;
  try { const r = await balances(); L.idr = r.idr; L.hold = r.hold; L.coins = r.coins; L.at = Date.now(); L.err = ''; }
  catch (e) { L.err = e.message; }
  pushState();
}
setInterval(refreshLive, 20000);

// ringkasan harga semua pair (untuk daftar aset); di-cache 30 detik, boleh gagal
let SUM = { at: 0, d: null };
async function summaries() {
  if (SUM.d && Date.now() - SUM.at < 30000) return SUM.d;
  try { SUM = { at: Date.now(), d: await getJson(CFG.base + '/api/summaries', 8000) }; const t = ((SUM.d || {}).tickers || {}).usdt_idr; if (t && +t.last > 0) M.usdIdr = +t.last; } catch (e) { SUM.at = Date.now() - 20000; }
  return SUM.d;
}
setInterval(() => summaries().catch(() => { }), 60000); setTimeout(() => summaries().catch(() => { }), 3000); // kurs USDT/IDR untuk input USD

// order book (bid/ask) dari Indodax /api/depth; di-cache 1,5 detik per aset agar tidak membebani API
const OB = new Map();
function orderBook(pair) {
  const c = OB.get(pair);
  if (c && c.d && Date.now() - c.at < 1500) return Promise.resolve(c.d);
  if (c && c.p) return c.p;
  const p = (async () => {
    try {
      const j = await getJson(CFG.base + '/api/depth/' + pair, 6000);
      const side = (a, desc) => (Array.isArray(a) ? a : []).map(r => [+r[0], +r[1]]).filter(r => r[0] > 0 && r[1] > 0).sort((x, y) => desc ? y[0] - x[0] : x[0] - y[0]).slice(0, 150);
      const d = { pair, at: Date.now(), bids: side(j.buy, true), asks: side(j.sell, false) };
      if (!d.bids.length && !d.asks.length) throw new Error('order book kosong');
      OB.set(pair, { at: Date.now(), d }); return d;
    } catch (e) {
      const old = c && c.d; OB.set(pair, { at: Date.now() - 500, d: old });
      if (old) return { ...old, stale: true };
      throw new Error('Order book belum bisa diambil dari Indodax (' + e.message + ')');
    }
  })();
  OB.set(pair, { ...(c || {}), p });
  return p;
}

// ---------- Research & Discovery: riset satu koin (format sama dengan tim Research & Discovery Bruces Capital) ----------
// Research Coin & Tokenomics: CoinGecko. Technical: candle harian Indodax. Whitepaper: tautan & deskripsi CoinGecko. Berita: RSS media kripto.
const RSS = (E.RSS_FEEDS || 'https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss,https://decrypt.co/feed').split(',').map(x => x.trim()).filter(Boolean);
async function getText(url, ms = 9000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 TradeBotPro/1.0', Accept: 'application/rss+xml, application/xml, text/xml' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); } finally { clearTimeout(t); }
}
const unx = s => { // CDATA -> entitas diurai (dua lapis, mis. &amp;lt;p&amp;gt;) -> semua tag HTML dibuang
  let t = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let i = 0; i < 2; i++) t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&#8216;|&#8220;|&#8221;/g, '"').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&');
  return t.replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ').replace(/&#x?[0-9a-f]+;/gi, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
};
let NEWS = { at: 0, items: [] };
async function newsItems() {
  if (NEWS.items.length && Date.now() - NEWS.at < 10 * 60e3) return NEWS.items;
  const all = [];
  await Promise.all(RSS.map(async u => {
    try {
      const x = await getText(u), host = (() => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } })();
      for (const m of x.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
        const it = m[0], g = tag => { const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(it); return r ? unx(r[1]) : ''; };
        const title = g('title'), link = g('link') || (/<guid[^>]*>([^<]+)<\/guid>/.exec(it) || [])[1] || '', at = Date.parse(g('pubDate') || g('dc:date')) || 0;
        if (title && /^https?:\/\//.test(link)) all.push({ title: title.slice(0, 200), link, at, src: host, desc: g('description').slice(0, 400) });
      }
    } catch (e) { }
  }));
  if (all.length) NEWS = { at: Date.now(), items: all.sort((a, b) => b.at - a.at) };
  return NEWS.items;
}
const CGID = {}; // simbol -> id CoinGecko
async function cgIdOf(sym, name) {
  const k = sym.toLowerCase(); if (CGID[k]) return CGID[k];
  const j = await cg('/search?query=' + encodeURIComponent(k)), c = (j.coins || []).filter(x => String(x.symbol || '').toLowerCase() === k).sort((a, b) => (a.market_cap_rank || 1e9) - (b.market_cap_rank || 1e9));
  const pick = c[0] || (j.coins || []).find(x => String(x.name || '').toLowerCase() === String(name || '').toLowerCase());
  if (!pick) throw new Error('Koin ' + sym.toUpperCase() + ' tidak ditemukan di CoinGecko'); CGID[k] = pick.id; return pick.id;
}
function techLevels(k) { // level resistance/support terdekat dari candle harian (IDR)
  if (!k || k.length < 20) return null;
  const px = k[k.length - 1].close, pv = k[k.length - 2] || k[k.length - 1], P0 = (pv.high + pv.low + pv.close) / 3, cl = k.map(x => x.close), L = [];
  L.push([P0, 'Pivot point'], [2 * P0 - pv.low, 'Pivot R1'], [2 * P0 - pv.high, 'Pivot S1'], [P0 + (pv.high - pv.low), 'Pivot R2'], [P0 - (pv.high - pv.low), 'Pivot S2']);
  const w = k.slice(-90), hi = Math.max(...w.map(x => x.high)), lo = Math.min(...w.map(x => x.low));
  for (const r of [0.236, 0.382, 0.5, 0.618, 0.786]) L.push([hi - (hi - lo) * r, 'Fibonacci ' + String(r).replace('.', ',')]);
  L.push([hi, 'Puncak 90 hari'], [lo, 'Dasar 90 hari']);
  for (const n of [7, 30, 200]) { const a = IND.sma(cl, n), b = IND.ema(cl, n); if (a[a.length - 1] != null) L.push([a[a.length - 1], 'SMA ' + n + ' hari']); if (b[b.length - 1] != null && k.length >= n) L.push([b[b.length - 1], 'EMA ' + n + ' hari']); }
  const ok = L.filter(x => isFinite(x[0]) && x[0] > 0), grp = a => { const g = []; for (const x of a) { const l = g[g.length - 1]; if (l && Math.abs(x[0] - l.p) / l.p < 0.004) { l.t.push(x[1]); l.hi = x[0]; } else g.push({ p: x[0], hi: x[0], t: [x[1]] }); } return g.slice(0, 3).map(q => ({ lo: Math.min(q.p, q.hi), hi: Math.max(q.p, q.hi), t: q.t.slice(0, 2) })); };
  return { px, res: grp(ok.filter(x => x[0] > px).sort((a, b) => a[0] - b[0])), sup: grp(ok.filter(x => x[0] <= px).sort((a, b) => b[0] - a[0])) };
}
const RES = {};
async function research(pair) {
  const p = PAIRS[pair]; if (!p) throw new Error('Aset tidak dikenal');
  const c = RES[pair]; if (c && c.d && Date.now() - c.at < 10 * 60e3) return c.d; if (c && c.p) return c.p;
  const pr = (async () => {
    const sym = p.coin.toUpperCase(), d = { at: Date.now(), pair, sym, name: p.desc, err: {} };
    const tasks = [
      (async () => {
        const id = await cgIdOf(p.coin, p.desc), j = await cg('/coins/' + id + '?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false'), m = j.market_data || {};
        d.cg = id; d.name = j.name || p.desc;
        d.coin = { usd: (m.current_price || {}).usd, idr: (m.current_price || {}).idr, ch24: m.price_change_percentage_24h, mcap: (m.market_cap || {}).usd, mcapCh: m.market_cap_change_percentage_24h, vol: (m.total_volume || {}).usd, fdv: (m.fully_diluted_valuation || {}).usd, rank: j.market_cap_rank || m.market_cap_rank || null };
        d.tok = { circ: m.circulating_supply, total: m.total_supply, max: m.max_supply };
        const desc = unx((j.description || {}).en || ''), sent = desc.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ').slice(0, 600);
        d.wp = { url: (j.links || {}).whitepaper || '', site: ((j.links || {}).homepage || []).find(Boolean) || '', summary: sent, rows: [
          ['Kategori', (j.categories || []).filter(Boolean).slice(0, 3).join(', ')], ['Algoritma', j.hashing_algorithm || ''], ['Diluncurkan', j.genesis_date || ''], ['Peringkat market cap', j.market_cap_rank ? '#' + j.market_cap_rank : '']].filter(x => x[1]) };
      })().catch(e => { d.err.coin = e.message; }),
      (async () => { const kk = await fetchCandles(p, '1D', 220); d.tech = techLevels(kk); if (!d.tech) throw new Error('candle harian belum cukup'); d.tech.src = CH_NAME[kk.src] || 'Indodax'; })().catch(e => { d.err.tech = e.message; }),
      (async () => {
        const it = await newsItems(), re = new RegExp('\\b(' + [sym, p.desc].filter(Boolean).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
        const mine = it.filter(x => re.test(x.title + ' ' + x.desc)), seen = new Set();
        d.news = (mine.length ? mine : it).filter(x => { const k = x.title.slice(0, 50).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5).map(({ title, link, at, src }) => ({ title, link, at, src }));
        d.newsGeneral = !mine.length; if (!it.length) throw new Error('feed berita tidak bisa diambil');
      })().catch(e => { d.err.news = e.message; }),
    ];
    await Promise.all(tasks);
    // jadwal unlock token (Messari Token Unlocks, bila kunci Messari dihubungkan); tanpa kunci hanya supply yang belum beredar
    if (d.cg && linkOn('messari')) {
      try {
        const t0 = new Date().toISOString().slice(0, 19) + 'Z', t1 = new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 19) + 'Z';
        const j = await xFetch(XB.messari + '/token-unlocks/v1/assets/' + encodeURIComponent(d.cg) + '/events?startTime=' + t0 + '&endTime=' + t1, { headers: { 'x-messari-api-key': LINKS.messari.key } }, 12000);
        const ev = (((j || {}).data || {}).unlockEvents || []).map(e => ({ at: Date.parse(e.timestamp), amt: +((e.cliff || {}).amountNative) || 0, usd: +((e.cliff || {}).amountUSD) || null, pct: +((e.cliff || {}).percentOfTotalAllocation) || null })).filter(e => e.at > Date.now() && e.amt > 0).sort((a, b) => a.at - b.at);
        d.unlock = { src: 'Messari', next: ev[0] || null, n30: ev.filter(e => e.at < Date.now() + 30 * 86400e3).reduce((a, e) => a + e.amt, 0), n90: ev.filter(e => e.at < Date.now() + 90 * 86400e3).length };
      } catch (e) { d.err.unlock = shortErr(e); }
    }
    if (d.err.coin && d.err.tech && d.err.news) throw new Error('Riset gagal: ' + d.err.coin);
    RES[pair] = { at: Date.now(), d }; return d;
  })();
  const pp = pr.finally(() => { if (RES[pair] && RES[pair].p) delete RES[pair].p; }); pp.catch(() => { }); // tanpa ini riset yang gagal mematikan server (unhandled rejection)
  RES[pair] = { ...(c || {}), p: pp };
  return pr;
}

// ---------- Akun & API tambahan ----------
// Tokocrypto & Binance: kunci diverifikasi lalu saldonya ditampilkan sebagai portofolio (BACA SAJA, tidak mengirim order).
// Trading tetap lewat Indodax karena chart, harga, dan bot memakai data Indodax (IDR).
// Arkham Intelligence: kunci data on-chain untuk daftar transfer whale di laporan Market Intelligence.
const XB = {
  binance: (E.BINANCE_BASE || 'https://api.binance.com').replace(/\/$/, ''),
  toko: (E.TOKOCRYPTO_BASE || 'https://www.tokocrypto.com').replace(/\/$/, ''),
  fapi: (E.BINANCE_FAPI || 'https://fapi.binance.com').replace(/\/$/, ''),
  arkham: (E.ARKHAM_BASE || 'https://api.arkm.com').replace(/\/$/, ''),
  fng: (E.FNG_URL || 'https://api.alternative.me/fng/').replace(/\/?$/, '/'),
};
Object.assign(XB, {
  cgl: (E.COINGLASS_BASE || 'https://open-api-v4.coinglass.com').replace(/\/$/, ''),
  gn: (E.GLASSNODE_BASE || 'https://api.glassnode.com').replace(/\/$/, ''),
  messari: (E.MESSARI_BASE || 'https://api.messari.io').replace(/\/$/, ''),
  cmc: (E.CMC_BASE || 'https://pro-api.coinmarketcap.com').replace(/\/$/, ''),
  jup: (E.JUP_BASE || 'https://lite-api.jup.ag').replace(/\/$/, ''),
  kyber: (E.KYBER_BASE || 'https://aggregator-api.kyberswap.com').replace(/\/$/, ''),
  solrpc: E.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
});
const LINK_NAME = { binance: 'Binance', tokocrypto: 'Tokocrypto', arkham: 'Arkham Intelligence', coinglass: 'CoinGlass', glassnode: 'Glassnode', messari: 'Messari', cmc: 'CoinMarketCap' };
const LINK_ENV = { binance: ['BINANCE_API_KEY', 'BINANCE_SECRET_KEY'], tokocrypto: ['TOKOCRYPTO_API_KEY', 'TOKOCRYPTO_SECRET_KEY'], arkham: ['ARKHAM_API_KEY'], coinglass: ['COINGLASS_API_KEY'], glassnode: ['GLASSNODE_API_KEY'], messari: ['MESSARI_API_KEY'], cmc: ['CMC_API_KEY'] };
const LINK_CEX = ['binance', 'tokocrypto'], LINK_TRADE_ENV = { binance: 'BINANCE_TRADE', tokocrypto: 'TOKOCRYPTO_TRADE' };
const LINKS = {};
for (const k of Object.keys(LINK_ENV)) LINKS[k] = { key: (E[LINK_ENV[k][0]] || '').trim(), secret: LINK_ENV[k][1] ? (E[LINK_ENV[k][1]] || '').trim() : '', on: false, at: 0, err: '', assets: [], total: 0, warn: '', saved: !!(E[LINK_ENV[k][0]] || '').trim(), busy: false, trade: /^true$/i.test(E[LINK_TRADE_ENV[k]] || ''), info: null };
const linkOn = k => !!(LINKS[k] && LINKS[k].on);
const hmac = (sec, q) => crypto.createHmac('sha256', sec).update(q).digest('hex');
async function xFetch(url, opt = {}, ms = 10000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: ac.signal, headers: { 'User-Agent': 'TradeBotPro/1.0', Accept: 'application/json', ...(opt.headers || {}) } });
    const tx = await r.text(); let j = null; try { j = JSON.parse(tx); } catch (e) { }
    if (!r.ok) { const er = new Error(String((j && (j.msg || j.message || j.error)) || ('HTTP ' + r.status)).slice(0, 200)); er.status = r.status; er.code = j && j.code; throw er; }
    if (j == null) throw new Error('jawaban bukan JSON'); return j;
  } finally { clearTimeout(t); }
}
const TOFF = { binance: 0, tokocrypto: 0 };
const signedGet = (ex, path, creds, params, retried) => signedReq(ex, 'GET', path, creds, params, retried);
async function signedReq(ex, method, path, creds, params = {}, retried) {
  const base = ex === 'binance' ? XB.binance : XB.toko;
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now() + TOFF[ex]), recvWindow: '10000' }).toString();
  try {
    const j = await xFetch(base + path + '?' + q + '&signature=' + hmac(creds.secret, q), { method, headers: { 'X-MBX-APIKEY': creds.key } });
    if (ex === 'tokocrypto' && j.code !== 0 && j.code !== '0') { const er = new Error(String(j.msg || j.message || 'kode ' + j.code)); er.code = j.code; throw er; }
    return j;
  } catch (e) {
    if (!retried && (e.code === -1021 || /timestamp|recvWindow/i.test(e.message))) { // jam komputer tidak sinkron: pakai jam server exchange
      try { const t = ex === 'binance' ? await xFetch(XB.binance + '/api/v3/time') : await xFetch(XB.toko + '/open/v1/common/time'); const srvT = +(t.serverTime || t.timestamp || (t.data && t.data.serverTime)); if (srvT > 0) TOFF[ex] = srvT - Date.now(); } catch (er) { }
      return signedReq(ex, method, path, creds, params, true);
    }
    throw e;
  }
}
let BNPX = { at: 0, m: null };
async function binancePrices() { // harga publik Binance (USDT) untuk aset yang tidak ada di Indodax
  if (BNPX.m && Date.now() - BNPX.at < 60e3) return BNPX.m;
  try { const a = await xFetch(XB.binance + '/api/v3/ticker/price', {}, 10000); const m = {}; for (const x of a || []) if (/USDT$/.test(x.symbol)) m[x.symbol.slice(0, -4)] = +x.price; BNPX = { at: Date.now(), m }; } catch (e) { BNPX = { at: Date.now() - 40e3, m: BNPX.m || {} }; }
  return BNPX.m;
}
async function valueIdr(rows) { // jumlah per aset -> perkiraan rupiah (harga Indodax, cadangan harga Binance × kurs USDT/IDR)
  const sm = await summaries().catch(() => null), tk = (sm && sm.tickers) || {}, u = M.usdIdr || +((tk.usdt_idr || {}).last) || 0; let bp = null;
  const out = [];
  for (const r of rows) {
    let a = String(r.asset || '').toUpperCase(); const q = (+r.free || 0) + (+r.locked || 0); if (!(q > 0)) continue;
    if (/^LD[A-Z0-9]{2,}$/.test(a) && !tk[a.toLowerCase() + '_idr']) a = a.slice(2); // aset Simple Earn Binance (LDBTC -> BTC)
    let px = a === 'IDR' || a === 'BIDR' ? 1 : +((tk[a.toLowerCase() + '_idr'] || {}).last) || 0;
    if (!px && u) { if (/^(USDT|USDC|FDUSD|BUSD|DAI|TUSD|USD1)$/.test(a)) px = u; else { bp = bp || await binancePrices(); if (bp[a]) px = bp[a] * u; } }
    out.push({ a, q, idr: px ? q * px : null });
  }
  const m = new Map(); for (const x of out) { const y = m.get(x.a); if (y) { y.q += x.q; y.idr = y.idr == null || x.idr == null ? (y.idr ?? x.idr) : y.idr + x.idr; } else m.set(x.a, { ...x }); }
  return [...m.values()].sort((a, b) => (b.idr || 0) - (a.idr || 0));
}
async function linkCheck(k, creds) { // verifikasi kunci & ambil saldo; melempar galat bila ditolak
  if (k === 'binance') {
    const perm = await signedGet('binance', '/sapi/v1/account/apiRestrictions', creds).catch(e => { if (e.status === 401 || e.code === -2014 || e.code === -2015 || e.code === -1022) throw e; return null; });
    if (perm && perm.enableWithdrawals === true) throw new Error('Kunci Binance ini punya izin WITHDRAW. Buat kunci baru tanpa izin withdraw (cukup "Enable Reading", tambah "Enable Spot & Margin Trading" bila ingin trading).');
    if (creds.trade && perm && perm.enableSpotAndMarginTrading === false) throw new Error('Kunci Binance ini tidak punya izin "Enable Spot & Margin Trading". Aktifkan izin itu di Binance, atau hubungkan tanpa mencentang Izinkan trading.');
    const acc = await signedGet('binance', '/api/v3/account', creds, { omitZeroBalances: 'true' });
    const warn = !creds.trade && perm && (perm.enableSpotAndMarginTrading || perm.enableFutures || perm.enableMargin) ? 'Kunci ini punya izin trading, tetapi trading dari aplikasi belum diizinkan (centang "Izinkan trading" saat menghubungkan bila ingin order dari sini).' : '';
    return { assets: await valueIdr(acc.balances || []), warn };
  }
  if (k === 'tokocrypto') {
    const j = await signedGet('tokocrypto', '/open/v1/account/spot', creds), d = j.data || {};
    return { assets: await valueIdr(d.accountAssets || d.balances || []), warn: '' };
  }
  if (k === 'arkham') {
    await xFetch(XB.arkham + '/transfers?usdGte=10000000&timeLast=24h&limit=1', { headers: { 'API-Key': creds.key } });
    return { assets: [], warn: '' };
  }
  if (k === 'coinglass') { const j = await xFetch(XB.cgl + '/api/futures/liquidation/exchange-list?symbol=BTC&range=24h', { headers: { 'CG-API-KEY': creds.key } }); if (String(j.code) !== '0') throw new Error(j.msg || 'kode ' + j.code); return { assets: [], warn: '' }; }
  if (k === 'glassnode') { const j = await xFetch(XB.gn + '/v1/metrics/addresses/active_count?a=BTC&i=24h&s=' + Math.floor(Date.now() / 1000 - 5 * 86400) + '&api_key=' + encodeURIComponent(creds.key)); if (!Array.isArray(j)) throw new Error('jawaban tidak dikenal'); return { assets: [], warn: '' }; }
  if (k === 'cmc') { const j = await xFetch(XB.cmc + '/v1/key/info', { headers: { 'X-CMC_PRO_API_KEY': creds.key } }); const pl = (j.data || {}).plan || {}; return { assets: [], warn: pl.credit_limit_monthly ? 'Paket CoinMarketCap: ' + pl.credit_limit_monthly + ' kredit/bulan' : '' }; }
  if (k === 'messari') {
    try { await xFetch(XB.messari + '/metrics/v2/assets?limit=1', { headers: { 'x-messari-api-key': creds.key } }); }
    catch (e) { if (e.status === 401 || e.status === 403) throw e; if (isNetErr(e)) throw e; return { assets: [], warn: 'Kunci disimpan; endpoint uji Messari menjawab ' + e.message + '. Coba lewat Penjelajah API.' }; }
    return { assets: [], warn: '' };
  }
  throw new Error('Penyedia tidak dikenal');
}
function linkErrMsg(k, e) {
  if (isNetErr(e)) return 'Tidak bisa menjangkau ' + LINK_NAME[k] + '. Periksa koneksi internet lalu coba lagi.';
  if (/WITHDRAW/.test(e.message)) return e.message;
  if (k === 'arkham') return 'Arkham menolak kunci ini (' + e.message + '). Pastikan kunci aktif dari arkm.com/api-dashboard.';
  if (!LINK_CEX.includes(k)) return LINK_NAME[k] + ' menolak kunci ini (' + e.message + '). Periksa kunci dan paket API Anda.';
  if (e.status === 451 || /restricted location|eligibility/i.test(e.message)) return LINK_NAME[k] + ' menolak akses dari lokasi ini (' + e.message + ').';
  return LINK_NAME[k] + ' menolak kunci ini (' + e.message + '). Periksa API Key, Secret Key, izin "baca/reading", dan IP whitelist bila dipakai.';
}
async function linkRefresh(k) {
  const L2 = LINKS[k]; if (!L2.key || L2.busy) return; L2.busy = true;
  try { const r = await linkCheck(k, L2); Object.assign(L2, { on: true, at: Date.now(), err: '', assets: r.assets, total: r.assets.reduce((a, x) => a + (x.idr || 0), 0), warn: r.warn }); }
  catch (e) { L2.err = linkErrMsg(k, e); if (!L2.at) L2.on = false; }
  finally { L2.busy = false; }
}
function setEnvVars(pairs) {
  const f = path.join(__dirname, '.env'); let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { }
  for (const [k, v] of pairs) { const re = new RegExp('^' + k + '=.*$', 'm'); t = re.test(t) ? t.replace(re, k + '=' + v) : t + (t && !t.endsWith('\n') ? '\n' : '') + k + '=' + v + '\n'; }
  try { fs.writeFileSync(f, t); } catch (e) { log('Gagal menulis .env:', e.message); }
}
function linkView() {
  const o = {};
  for (const [k, L2] of Object.entries(LINKS)) o[k] = { on: L2.on, at: L2.at, err: L2.err, warn: L2.warn, saved: L2.saved, total: L2.total, n: L2.assets.length, assets: L2.assets.slice(0, 12), hint: L2.key ? L2.key.slice(0, 4) + '…' + L2.key.slice(-3) : '', trade: !!L2.trade };
  o.custom = CUSTOM.map(c => ({ id: c.id, name: c.name, kind: c.kind, base: c.base, auth: c.auth, keyName: c.keyName, test: c.test, ok: c.ok, err: c.err || '', at: c.at || 0, hint: c.key ? c.key.slice(0, 4) + '…' + c.key.slice(-3) : '' }));
  return o;
}
setTimeout(() => { for (const k of Object.keys(LINKS)) if (LINKS[k].key) linkRefresh(k).then(() => { if (LINKS[k].on) log('🔗 ' + LINK_NAME[k] + ' tersambung dari .env'); pushState(); }); }, 2500);
setInterval(() => { let any = false; for (const k of ['binance', 'tokocrypto']) if (LINKS[k].on) { any = true; linkRefresh(k); } if (any) setTimeout(pushState, 4000); }, 90e3);

// ---------- trading di Binance & Tokocrypto (order spot manual dari dialog API; bot tetap di Indodax) ----------
const SYMC = {};
const decOf = st => { const t = String(st || '1').replace(/0+$/, ''); const i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };
const floorStep = (v, st) => { st = +st; if (!(st > 0)) return v; const d = decOf(st); return +(Math.floor(v / st + 1e-9) * st).toFixed(d); };
async function xSymbols(ex) {
  const c = SYMC[ex]; if (c && Date.now() - c.at < 3600e3) return c.list;
  let list = [];
  if (ex === 'binance') {
    const a = await xFetch(XB.binance + '/api/v3/ticker/price', {}, 12000), Q = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR'];
    for (const x of a || []) { const q = Q.find(z => x.symbol.endsWith(z) && x.symbol.length > z.length); if (q) list.push({ symbol: x.symbol, base: x.symbol.slice(0, -q.length), quote: q, price: +x.price }); }
  } else {
    const j = await xFetch(XB.toko + '/open/v1/common/symbols', {}, 12000); if (j.code !== 0 && j.code !== '0') throw new Error(j.msg || 'gagal mengambil daftar pair');
    for (const x of ((j.data || {}).list || [])) if (x.spotTradingEnable !== 0 && x.spotTradingEnable !== false) list.push({ symbol: x.symbol, base: x.baseAsset, quote: x.quoteAsset, f: x.filters || [] });
  }
  SYMC[ex] = { at: Date.now(), list }; return list;
}
async function xInfo(ex, symbol) { // filter LOT_SIZE / PRICE_FILTER / NOTIONAL
  let f = [];
  if (ex === 'binance') { const j = await xFetch(XB.binance + '/api/v3/exchangeInfo?symbol=' + encodeURIComponent(symbol), {}, 10000); const s0 = (j.symbols || [])[0]; if (!s0) throw new Error('Pair ' + symbol + ' tidak ada di Binance'); f = s0.filters || []; }
  else { const s0 = (await xSymbols(ex)).find(x => x.symbol === symbol); if (!s0) throw new Error('Pair ' + symbol + ' tidak ada di Tokocrypto'); f = s0.f || []; }
  const g = t => f.find(x => x.filterType === t) || {};
  return { step: +g('LOT_SIZE').stepSize || 0, minQty: +g('LOT_SIZE').minQty || 0, tick: +g('PRICE_FILTER').tickSize || 0, minNotional: +(g('NOTIONAL').minNotional || g('MIN_NOTIONAL').minNotional) || 0 };
}
async function xPrice(ex, symbol) {
  if (ex === 'binance') return +(await xFetch(XB.binance + '/api/v3/ticker/price?symbol=' + encodeURIComponent(symbol), {}, 8000)).price;
  const [b, q] = symbol.split('_');
  if (q === 'IDR') { const sm = await summaries().catch(() => null), t = sm && sm.tickers && sm.tickers[b.toLowerCase() + '_idr']; if (t) return +t.last; }
  try { return +(await xFetch(XB.binance + '/api/v3/ticker/price?symbol=' + b + q, {}, 8000)).price; } catch (e) { return 0; }
}
function needTrade(ex) {
  const L2 = LINKS[ex]; if (!L2 || !LINK_CEX.includes(ex)) throw new Error('Exchange tidak dikenal');
  if (!L2.on) throw new Error('Hubungkan ' + LINK_NAME[ex] + ' dulu');
  if (!L2.trade) throw new Error('Trading di ' + LINK_NAME[ex] + ' belum diizinkan. Putuskan lalu hubungkan lagi dengan mencentang "Izinkan trading".');
  return L2;
}
async function xOrder(b) {
  const ex = String(b.ex || ''), L2 = needTrade(ex), symbol = String(b.symbol || '').toUpperCase();
  if (!/^[A-Z0-9_]{4,24}$/.test(symbol)) throw new Error('Pair tidak valid');
  const side = b.side === 'sell' ? 'SELL' : 'BUY', lim = b.type === 'limit', inf = await xInfo(ex, symbol);
  let qty = +b.qty || 0, quote = +b.quote || 0, price = +b.price || 0;
  if (!(qty > 0) && !(quote > 0)) throw new Error('Isi jumlah');
  const mkt = await xPrice(ex, symbol).catch(() => 0);
  if (lim) { if (!(price > 0)) throw new Error('Isi harga limit'); if (inf.tick) price = floorStep(price, inf.tick); if (mkt > 0 && Math.abs(price / mkt - 1) > 0.5) throw new Error('Harga limit menyimpang lebih dari 50% dari harga pasar (' + mkt + ')'); }
  const last = lim ? price : mkt;
  if (!(qty > 0) && (lim || (side === 'SELL' && ex === 'tokocrypto'))) { if (!(last > 0)) throw new Error('Harga pasar belum tersedia; isi jumlah dalam koin'); qty = quote / last; quote = 0; }
  if (qty > 0) { qty = floorStep(qty, inf.step); if (!(qty > 0) || qty < inf.minQty) throw new Error('Jumlah terlalu kecil (minimal ' + inf.minQty + ')'); }
  const notional = qty > 0 ? qty * (last || 0) : quote; if (inf.minNotional && notional > 0 && notional < inf.minNotional) throw new Error('Nilai order terlalu kecil (minimal ' + inf.minNotional + ' dalam mata uang quote)');
  let r, oid, status, exec;
  if (ex === 'binance') {
    const p = { symbol, side, type: lim ? 'LIMIT' : 'MARKET', newOrderRespType: 'RESULT' };
    if (lim) Object.assign(p, { timeInForce: 'GTC', quantity: String(qty), price: String(price) }); else if (qty > 0) p.quantity = String(qty); else p.quoteOrderQty = String(quote);
    r = await signedReq('binance', 'POST', '/api/v3/order', L2, p); oid = r.orderId; status = r.status; exec = +r.executedQty || 0;
  } else {
    const p = { symbol, side: side === 'BUY' ? '0' : '1', type: lim ? '1' : '2' };
    if (lim) Object.assign(p, { timeInForce: '1', quantity: String(qty), price: String(price) }); else if (side === 'BUY' && !(qty > 0)) p.quoteOrderQty = String(quote); else p.quantity = String(qty);
    const j = await signedReq('tokocrypto', 'POST', '/open/v1/orders', L2, p); r = j.data || {}; oid = r.orderId; status = r.status; exec = +r.executedQty || 0;
  }
  const rec = { at: Date.now(), ex, symbol, side: side.toLowerCase(), type: lim ? 'limit' : 'market', qty: qty || null, quote: quote || null, price: price || null, orderId: oid, status: String(status) };
  S.xtrades = [rec, ...(S.xtrades || [])].slice(0, 60); save();
  toast('🔗 ' + LINK_NAME[ex] + ': order ' + (side === 'BUY' ? 'beli ' : 'jual ') + symbol + (lim ? ' limit @' + price : ' market') + ' terkirim (id ' + oid + ', ' + status + ')', 'success');
  setTimeout(() => linkRefresh(ex).then(pushState), 1500); pushState();
  return { ok: true, orderId: oid, status, executedQty: exec };
}
async function xOpenOrders(ex, symbol) {
  const L2 = needTrade(ex);
  if (ex === 'binance') return (await signedGet('binance', '/api/v3/openOrders', L2, symbol ? { symbol } : {})).map(o => ({ orderId: o.orderId, symbol: o.symbol, side: String(o.side).toLowerCase(), type: String(o.type).toLowerCase(), price: +o.price, qty: +o.origQty, exec: +o.executedQty, at: o.time }));
  const j = await signedGet('tokocrypto', '/open/v1/orders', L2, { symbol, type: '1' });
  return ((j.data || {}).list || []).map(o => ({ orderId: o.orderId, symbol: o.symbol, side: +o.side === 1 ? 'sell' : 'buy', type: +o.type === 1 ? 'limit' : 'market', price: +o.price, qty: +o.origQty, exec: +o.executedQty, at: o.createTime }));
}
async function xCancel(ex, symbol, orderId) {
  const L2 = needTrade(ex);
  if (ex === 'binance') await signedReq('binance', 'DELETE', '/api/v3/order', L2, { symbol, orderId: String(orderId) });
  else await signedReq('tokocrypto', 'POST', '/open/v1/orders/cancel', L2, { orderId: String(orderId) });
  toast('🔗 ' + LINK_NAME[ex] + ': order ' + orderId + ' dibatalkan', 'info'); setTimeout(() => linkRefresh(ex).then(pushState), 1500);
}

// ---------- API kustom (tambahan pengguna): disimpan di data/custom-apis.json, bisa diuji & dipanggil lewat Penjelajah API ----------
const CUSTOM_FILE = path.join(CFG.dataDir, 'custom-apis.json');
let CUSTOM = []; try { CUSTOM = (JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')) || []).filter(c => c && c.id && c.base); } catch (e) { }
function saveCustom() { try { fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.writeFileSync(CUSTOM_FILE + '.tmp', JSON.stringify(CUSTOM, null, 1)); fs.renameSync(CUSTOM_FILE + '.tmp', CUSTOM_FILE); } catch (e) { log('Gagal simpan API kustom:', e.message); } }
const AUTHS = ['none', 'header', 'query', 'bearer', 'hmac'];
function normCustom(b, cur) {
  const o = { ...(cur || {}) };
  o.name = String(b.name || o.name || '').trim().slice(0, 40); if (!o.name) throw new Error('Isi nama API');
  o.kind = ['cex', 'dex', 'data'].includes(b.kind) ? b.kind : o.kind || 'data';
  const base = String(b.base || o.base || '').trim().replace(/\/+$/, ''); let u; try { u = new URL(base); } catch (e) { throw new Error('Base URL tidak valid (contoh: https://api.contoh.com)'); }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)))) throw new Error('Base URL harus https:// (atau http://localhost)');
  o.base = base; o.auth = AUTHS.includes(b.auth) ? b.auth : o.auth || 'none';
  o.keyName = String(b.keyName != null ? b.keyName : o.keyName || '').trim().slice(0, 60);
  if (b.key != null && String(b.key).trim()) o.key = String(b.key).trim(); if (b.secret != null && String(b.secret).trim()) o.secret = String(b.secret).trim();
  if (o.auth !== 'none' && !o.key) throw new Error('Isi API key');
  if (o.auth === 'hmac' && !o.secret) throw new Error('Isi secret key untuk tanda tangan HMAC');
  if ((o.auth === 'header' || o.auth === 'query') && !o.keyName) throw new Error('Isi nama header / parameter untuk API key');
  o.test = String(b.test != null ? b.test : o.test || '/').trim().slice(0, 300) || '/'; if (!o.test.startsWith('/')) o.test = '/' + o.test;
  return o;
}
async function customCall(c, pathQ, method = 'GET', body) {
  if (!/^\/[^\s]*$/.test(pathQ)) throw new Error('Path harus diawali / (contoh: /v1/ticker?symbol=BTC)');
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('Metode harus GET, POST, atau DELETE');
  const u = new URL(c.base + pathQ), h = {};
  if (u.origin !== new URL(c.base).origin) throw new Error('Path tidak boleh pindah ke domain lain');
  if (c.auth === 'header') h[c.keyName] = c.key; else if (c.auth === 'bearer') h.Authorization = 'Bearer ' + c.key; else if (c.auth === 'query') u.searchParams.set(c.keyName, c.key);
  else if (c.auth === 'hmac') { u.searchParams.set('timestamp', String(Date.now())); const q = u.searchParams.toString(); u.search = q + '&signature=' + hmac(c.secret, q); h[c.keyName || 'X-MBX-APIKEY'] = c.key; }
  const t0 = Date.now(), ac = new AbortController(), tm = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(u.toString(), { method, signal: ac.signal, headers: { 'User-Agent': 'TradeBotPro/1.0', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...h }, body: body ? JSON.stringify(body) : undefined });
    const tx = await r.text(); let j = null; try { j = JSON.parse(tx); } catch (e) { }
    const shown = (u.toString()).replace(c.key ? encodeURIComponent(c.key) : '\u0000', '•••').replace(c.key || '\u0000', '•••');
    return { status: r.status, ok: r.ok, ms: Date.now() - t0, url: shown, json: j, text: j == null ? tx.slice(0, 4000) : null, size: tx.length };
  } finally { clearTimeout(tm); }
}

// ---------- DEX: proxy Jupiter (Solana, dompet Phantom) & KyberSwap (EVM, MetaMask dsb.); transaksi ditandatangani di dompet pengguna ----------
async function solBalances(owner) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) throw new Error('Alamat Solana tidak valid');
  const rpc = (method, params) => xFetch(XB.solrpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 12000).then(j => { if (j.error) throw new Error(j.error.message || 'RPC error'); return j.result; });
  const [bal, tok] = await Promise.all([rpc('getBalance', [owner]), rpc('getTokenAccountsByOwner', [owner, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]).catch(() => null)]);
  const out = [{ mint: 'So11111111111111111111111111111111111111112', sym: 'SOL', amount: (bal.value || 0) / 1e9, dec: 9 }];
  for (const a of ((tok || {}).value || [])) { const i = (((a.account || {}).data || {}).parsed || {}).info || {}, t = i.tokenAmount || {}; if (+t.uiAmount > 0) out.push({ mint: i.mint, amount: +t.uiAmount, dec: +t.decimals }); }
  return out;
}
const EVM_CHAINS = ['ethereum', 'bsc', 'base', 'arbitrum', 'polygon', 'optimism', 'avalanche'];

async function arkhamWhales() { // transfer besar 24 jam terakhir (Arkham Intelligence)
  const min = Math.max(1e6, +E.ARKHAM_MIN_USD || 10e6);
  const j = await xFetch(XB.arkham + '/transfers?usdGte=' + min + '&timeLast=24h&limit=10&sortKey=usd&sortDir=desc', { headers: { 'API-Key': LINKS.arkham.key } }, 15000);
  const arr = Array.isArray(j) ? j : (j.transfers || []);
  const who = a => { if (!a) return '?'; const e = a.arkhamEntity || {}, l = a.arkhamLabel || {}; return e.name || l.name || (a.address ? String(a.address).slice(0, 6) + '…' + String(a.address).slice(-4) : '?'); };
  return { min, rows: arr.slice(0, 8).map(t => ({ usd: +(t.historicalUSD ?? t.usd ?? t.valueUSD) || null, qty: +(t.unitValue ?? t.amount) || null, tok: String(t.tokenSymbol || (t.token && t.token.symbol) || '').toUpperCase(), from: who(t.fromAddress), to: who(t.toAddress), at: Date.parse(t.blockTimestamp || t.timestamp || '') || null, chain: t.chain || '' })) };
}

// ---------- derivatif: data per bursa (rantai cadangan) + agregat semua bursa (CoinGecko) ----------
XB.bybit = (E.BYBIT_BASE || 'https://api.bybit.com').replace(/\/$/, '');
XB.okx = (E.OKX_BASE || 'https://www.okx.com').replace(/\/$/, '');
const shortErr = e => { const m = String((e && e.message) || e); return /abort/i.test(m) ? 'tidak merespons (mungkin diblokir jaringan/ISP)' : /fetch failed|ENOTFOUND|ECONN/i.test(m) ? 'tidak bisa dijangkau' : m.slice(0, 80); };
async function binanceDeriv() {
  const rows = [];
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const [pi, oi, ls, oh] = await Promise.all([getJson(XB.fapi + '/fapi/v1/premiumIndex?symbol=' + sym, 6000), getJson(XB.fapi + '/fapi/v1/openInterest?symbol=' + sym, 6000), getJson(XB.fapi + '/futures/data/globalLongShortAccountRatio?symbol=' + sym + '&period=1h&limit=1', 6000).catch(() => null), getJson(XB.fapi + '/futures/data/openInterestHist?symbol=' + sym + '&period=1h&limit=25', 6000).catch(() => null)]);
    const mark = +pi.markPrice, l = Array.isArray(ls) && ls[0] ? ls[0] : null; let oich = null;
    if (Array.isArray(oh) && oh.length > 1) { const a0 = +oh[0].sumOpenInterestValue, a1 = +oh[oh.length - 1].sumOpenInterestValue; if (a0 > 0) oich = (a1 / a0 - 1) * 100; }
    if (!(mark > 0)) throw new Error('data kosong');
    rows.push({ sym: sym.replace('USDT', ''), mark, oi: +oi.openInterest * mark, oich, fund: +pi.lastFundingRate * 100, long: l ? +l.longAccount * 100 : null, short: l ? +l.shortAccount * 100 : null, ratio: l ? +l.longShortRatio : null });
  }
  return rows;
}
async function bybitDeriv() {
  const rows = [];
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const [tk, ar, oh] = await Promise.all([getJson(XB.bybit + '/v5/market/tickers?category=linear&symbol=' + sym, 6000), getJson(XB.bybit + '/v5/market/account-ratio?category=linear&symbol=' + sym + '&period=1h&limit=1', 6000).catch(() => null), getJson(XB.bybit + '/v5/market/open-interest?category=linear&symbol=' + sym + '&intervalTime=1h&limit=25', 6000).catch(() => null)]);
    const t = (((tk || {}).result || {}).list || [])[0]; if (!t) throw new Error(String((tk && tk.retMsg) || 'data kosong'));
    const r = ((((ar || {}).result || {}).list) || [])[0], h = (((oh || {}).result || {}).list) || []; let oich = null;
    if (h.length > 1) { const a1 = +h[0].openInterest, a0 = +h[h.length - 1].openInterest; if (a0 > 0) oich = (a1 / a0 - 1) * 100; } // terbaru di depan
    const mark = +t.markPrice || +t.lastPrice, lg = r ? +r.buyRatio * 100 : null, sh = r ? +r.sellRatio * 100 : null;
    rows.push({ sym: sym.replace('USDT', ''), mark, oi: +t.openInterestValue || +t.openInterest * mark, oich, fund: +t.fundingRate * 100, long: lg, short: sh, ratio: lg != null && sh > 0 ? lg / sh : null });
  }
  return rows;
}
async function okxDeriv() {
  const rows = [];
  for (const c of ['BTC', 'ETH']) {
    const id = c + '-USDT-SWAP';
    const [oi, fr, mk, ls] = await Promise.all([getJson(XB.okx + '/api/v5/public/open-interest?instType=SWAP&instId=' + id, 6000), getJson(XB.okx + '/api/v5/public/funding-rate?instId=' + id, 6000), getJson(XB.okx + '/api/v5/public/mark-price?instType=SWAP&instId=' + id, 6000), getJson(XB.okx + '/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=' + c + '&period=1H', 6000).catch(() => null)]);
    const o = ((oi || {}).data || [])[0], f = ((fr || {}).data || [])[0], m = ((mk || {}).data || [])[0]; if (!o || !m) throw new Error('data kosong');
    const mark = +m.markPx, rr = ls && ls.data && ls.data[0] ? +ls.data[0][1] : null;
    rows.push({ sym: c, mark, oi: +o.oiUsd || +o.oiCcy * mark, oich: null, fund: f ? +f.fundingRate * 100 : null, long: rr ? rr / (1 + rr) * 100 : null, short: rr ? 100 / (1 + rr) : null, ratio: rr });
  }
  return rows;
}
async function venueDeriv() {
  const skipped = [];
  for (const [venue, f] of [['Binance', binanceDeriv], ['Bybit', bybitDeriv], ['OKX', okxDeriv]]) {
    try { const rows = await f(); if (rows.length) return { venue, rows, skipped }; } catch (e) { skipped.push(venue + ': ' + shortErr(e)); }
  }
  throw new Error('Semua bursa derivatif gagal: ' + skipped.join(' · '));
}
async function derivAggregate() { // semua bursa di CoinGecko: total open interest & funding rata-rata (berbobot OI) kontrak perpetual BTC & ETH
  const a = await cg('/derivatives'); if (!Array.isArray(a) || !a.length) throw new Error('data kosong');
  const out = [];
  for (const c of ['BTC', 'ETH']) {
    const xs = a.filter(x => String(x.index_id || '').toUpperCase() === c && /perpetual/i.test(x.contract_type || '') && +x.open_interest > 0);
    if (!xs.length) continue;
    const oi = xs.reduce((s, x) => s + +x.open_interest, 0), fw = xs.filter(x => isFinite(+x.funding_rate)), fund = fw.length ? fw.reduce((s, x) => s + +x.funding_rate * +x.open_interest, 0) / fw.reduce((s, x) => s + +x.open_interest, 0) : null;
    const byEx = new Map(); for (const x of xs) { const k = String(x.market || '').replace(/\s*\(Futures\)|\s*\(Derivatives\)|\s*Futures$/i, ''); byEx.set(k, (byEx.get(k) || 0) + +x.open_interest); }
    out.push({ sym: c, oi, fund, n: byEx.size, vol: xs.reduce((s, x) => s + (+x.volume_24h || 0), 0), top: [...byEx.entries()].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([m, v]) => ({ m, oi: v, pct: v / oi * 100 })) });
  }
  if (!out.length) throw new Error('kontrak perpetual tidak ditemukan');
  return out;
}

// ---------- Encrypt Intelligence (zona E Bruces Capital): Wallet Treasury → Whale Order → Whale Info → Whale Assets, plus Whale Alarm ----------
// Tim: Gilang (Wallet Treasury), Putri (Whale Order), Rangga (Whale Info), Mega (Whale Assets), Rizky (Whale Alarm).
// Data tanpa kunci: Blockscout (Ethereum, Base, Arbitrum, Optimism, Polygon), mempool.space (Bitcoin), RPC Solana + harga Jupiter.
// Arkham (bila dihubungkan) menambah nama entitas. Nilai dalam USD.
const WAL_FILE = path.join(CFG.dataDir, 'wallets.json');
let WAL = { list: [], alarm: { on: false, min: 1e6, every: 5 }, log: [] };
try { const j = JSON.parse(fs.readFileSync(WAL_FILE, 'utf8')); if (j && Array.isArray(j.list)) WAL = { ...WAL, ...j, alarm: { ...WAL.alarm, ...(j.alarm || {}) }, log: Array.isArray(j.log) ? j.log : [] }; } catch (e) { }
const saveWal = () => { try { fs.writeFileSync(WAL_FILE + '.tmp', JSON.stringify(WAL, null, 1)); fs.renameSync(WAL_FILE + '.tmp', WAL_FILE); } catch (e) { log('Gagal simpan wallet:', e.message); } };
const W_EVM = /^0x[0-9a-fA-F]{40}$/, W_BTC = /^(bc1[0-9a-z]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, W_SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const W_EVMCH = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc'], W_CH = [...W_EVMCH, 'bitcoin', 'solana'];
const BS_DEF = { ethereum: 'https://eth.blockscout.com', base: 'https://base.blockscout.com', arbitrum: 'https://arbitrum.blockscout.com', optimism: 'https://optimism.blockscout.com', polygon: 'https://polygon.blockscout.com' };
const bsBase = ch => E.BLOCKSCOUT_TPL ? E.BLOCKSCOUT_TPL.replace('{chain}', ch) : BS_DEF[ch] || null;
const MEMPOOL = (E.MEMPOOL_BASE || 'https://mempool.space/api').replace(/\/$/, '');
const NATIVE = { ethereum: 'ETH', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH', polygon: 'POL', bsc: 'BNB' };
const STABLES = new Set('USDT USDC DAI FDUSD USDE TUSD PYUSD USDS BUSD USDP FRAX LUSD USD1 RLUSD USDB GHO CRVUSD USDG'.split(' '));
function normWallet(b) {
  const addr = String(b.addr || '').trim(); let chain = String(b.chain || 'auto');
  if (chain === 'auto') chain = W_EVM.test(addr) ? 'ethereum' : W_BTC.test(addr) ? 'bitcoin' : W_SOL.test(addr) ? 'solana' : '';
  if (!W_CH.includes(chain)) throw new Error('Alamat tidak dikenali. Dukungan: EVM (0x…), Bitcoin (bc1…/1…/3…), Solana');
  if (W_EVMCH.includes(chain) ? !W_EVM.test(addr) : chain === 'bitcoin' ? !W_BTC.test(addr) : !W_SOL.test(addr)) throw new Error('Alamat tidak cocok dengan jaringan ' + chain);
  const url = String(b.url || '').trim().slice(0, 300); if (url && !/^https?:\/\//i.test(url)) throw new Error('Tautan sumber harus diawali http(s)://');
  return { addr: W_EVMCH.includes(chain) ? addr.toLowerCase() : addr, chain, label: String(b.label || '').replace(/[<>]/g, '').trim().slice(0, 60), src: String(b.src || 'Lainnya').replace(/[<>]/g, '').trim().slice(0, 40) || 'Lainnya', url, note: String(b.note || '').replace(/[<>]/g, '').slice(0, 300) };
}
const usdF = v => { if (v == null || !isFinite(v)) return '-'; const a = Math.abs(v), f = (x, d) => x.toFixed(d).replace('.', ','); return (v < 0 ? '-' : '') + '$' + (a >= 1e9 ? f(a / 1e9, 2) + 'B' : a >= 1e6 ? f(a / 1e6, 2) + 'M' : a >= 1e3 ? f(a / 1e3, 1) + 'K' : f(a, 0)); };
async function pxUsd(sym) { const q = (await yQuotes([[sym + '-USD', sym]]))[0]; if (!(q && q.last > 0)) throw new Error('harga ' + sym + ' tidak tersedia'); return q.last; }
const bsGet = (B, p) => getJsonH(B + p, 12000, { Accept: 'application/json', 'User-Agent': 'TradeBotPro/1.0' });
async function evmWallet(w, light) {
  const B = bsBase(w.chain); if (!B) throw new Error('Jaringan ' + w.chain + ' belum didukung tanpa kunci (hubungkan Arkham untuk BNB Chain)');
  const a = w.addr.toLowerCase(), [info, toks, tt, txs] = await Promise.all([light ? null : bsGet(B, '/api/v2/addresses/' + a).catch(() => null), light ? [] : bsGet(B, '/api/v2/addresses/' + a + '/token-balances').catch(() => []),
    bsGet(B, '/api/v2/addresses/' + a + '/token-transfers?type=ERC-20').catch(() => ({ items: [] })), bsGet(B, '/api/v2/addresses/' + a + '/transactions').catch(() => ({ items: [] }))]);
  const nat = NATIVE[w.chain] || 'ETH', npx = info && +info.exchange_rate > 0 ? +info.exchange_rate : await pxUsd(nat === 'POL' ? 'POL' : nat).catch(() => null), assets = [];
  if (info) { const n = (+info.coin_balance || 0) / 1e18; if (n > 0) assets.push({ sym: nat, amt: n, usd: npx ? n * npx : null }); }
  for (const t of Array.isArray(toks) ? toks : []) { const k = t.token || {}, dec = +k.decimals || 0, amt = (+t.value || 0) / Math.pow(10, dec), rate = +k.exchange_rate || null; if (amt > 0 && k.symbol) assets.push({ sym: String(k.symbol).slice(0, 12), amt, usd: rate ? amt * rate : null }); }
  const H = new Map(), add = (h, x) => { if (!H.has(h)) H.set(h, { at: x.at, ins: [], outs: [] }); const g = H.get(h); g.at = Math.max(g.at, x.at); (x.dir === 'in' ? g.ins : g.outs).push(x); };
  for (const t of ((tt || {}).items || [])) { const k = t.token || {}, tot = t.total || {}, dec = +(tot.decimals || k.decimals || 0), amt = (+tot.value || 0) / Math.pow(10, dec), rate = +k.exchange_rate || null, h = t.transaction_hash || t.tx_hash || t.hash, from = ((t.from || {}).hash || '').toLowerCase(), to = ((t.to || {}).hash || '').toLowerCase();
    if (!h || !(amt > 0)) continue; add(h, { at: Date.parse(t.timestamp) || 0, dir: to === a ? 'in' : 'out', sym: String(k.symbol || '?').slice(0, 12), amt, usd: rate ? amt * rate : null, cp: to === a ? from : to }); }
  for (const t of ((txs || {}).items || [])) { const v = (+t.value || 0) / 1e18, h = t.hash; if (!h || !(v > 0)) continue; const from = ((t.from || {}).hash || '').toLowerCase(); add(h, { at: Date.parse(t.timestamp) || 0, dir: from === a ? 'out' : 'in', sym: nat, amt: v, usd: npx ? v * npx : null, cp: from === a ? ((t.to || {}).hash || '') : from }); }
  return { assets, tx: classifyTx(H, nat), price: npx };
}
// beli = menerima token non-stabil sambil membayar stablecoin/koin native; jual = sebaliknya; selain itu transfer masuk/keluar
function classifyTx(H, nat) {
  const out = [], base = s => STABLES.has(String(s).toUpperCase()) || s === nat || s === 'WETH';
  for (const [hash, g] of H) {
    const sum = a => a.reduce((x, y) => x + (y.usd || 0), 0), pick = a => a.slice().sort((x, y) => (y.usd || 0) - (x.usd || 0))[0];
    if (g.ins.length && g.outs.length) {
      const iB = g.ins.every(x => base(x.sym)), oB = g.outs.every(x => base(x.sym)), ti = pick(g.ins), to = pick(g.outs);
      if (oB && !iB) out.push({ hash, at: g.at, kind: 'buy', sym: ti.sym, amt: ti.amt, usd: sum(g.outs) || sum(g.ins) || null, pay: to.sym });
      else if (iB && !oB) out.push({ hash, at: g.at, kind: 'sell', sym: to.sym, amt: to.amt, usd: sum(g.ins) || sum(g.outs) || null, pay: ti.sym });
      else out.push({ hash, at: g.at, kind: 'swap', sym: to.sym + '→' + ti.sym, amt: ti.amt, usd: Math.max(sum(g.ins), sum(g.outs)) || null });
    } else { const L = g.ins.length ? g.ins : g.outs, t = pick(L); out.push({ hash, at: g.at, kind: g.ins.length ? 'in' : 'out', sym: t.sym, amt: L.filter(x => x.sym === t.sym).reduce((x, y) => x + y.amt, 0), usd: sum(L) || null, cp: t.cp }); }
  }
  return out.sort((x, y) => y.at - x.at).slice(0, 30);
}
async function btcWallet(w, light) {
  const [a, txs, px] = await Promise.all([light ? null : getJsonH(MEMPOOL + '/address/' + w.addr, 12000, { Accept: 'application/json' }), getJsonH(MEMPOOL + '/address/' + w.addr + '/txs', 12000, { Accept: 'application/json' }).catch(() => []), pxUsd('BTC').catch(() => null)]);
  const assets = []; if (a) { const c = a.chain_stats || {}, m = a.mempool_stats || {}, bal = ((+c.funded_txo_sum || 0) - (+c.spent_txo_sum || 0) + (+m.funded_txo_sum || 0) - (+m.spent_txo_sum || 0)) / 1e8; if (bal > 0) assets.push({ sym: 'BTC', amt: bal, usd: px ? bal * px : null }); }
  const tx = (Array.isArray(txs) ? txs : []).slice(0, 25).map(t => { const inV = (t.vout || []).filter(o => o.scriptpubkey_address === w.addr).reduce((x, o) => x + (+o.value || 0), 0), outV = (t.vin || []).filter(i => ((i.prevout || {}).scriptpubkey_address) === w.addr).reduce((x, i) => x + (+(i.prevout || {}).value || 0), 0), net = (inV - outV) / 1e8;
    return { hash: t.txid, at: ((t.status || {}).block_time || Math.floor(Date.now() / 1000)) * 1000, kind: net >= 0 ? 'in' : 'out', sym: 'BTC', amt: Math.abs(net), usd: px ? Math.abs(net) * px : null }; }).filter(t => t.amt > 0);
  return { assets, tx, price: px };
}
async function solWallet(w, light) {
  const rpc = (method, params) => xFetch(XB.solrpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 12000).then(j => { if (j.error) throw new Error(j.error.message || 'RPC'); return j.result; });
  const solPx = await pxUsd('SOL').catch(() => null), assets = [];
  if (!light) { const b = await solBalances(w.addr); const mints = b.filter(x => x.mint && x.sym !== 'SOL').map(x => x.mint).slice(0, 40); let pr = {}; if (mints.length) { try { pr = await xFetch(XB.jup + '/price/v3?ids=' + mints.join(','), {}, 10000); } catch (e) { } }
    for (const x of b) { const p = x.sym === 'SOL' ? solPx : +((pr[x.mint] || {}).usdPrice) || null; assets.push({ sym: x.sym || x.mint.slice(0, 4) + '…', amt: x.amount, usd: p ? x.amount * p : null }); } }
  const sigs = await rpc('getSignaturesForAddress', [w.addr, { limit: light ? 6 : 12 }]).catch(() => []), tx = [];
  for (const sg of (sigs || []).slice(0, light ? 6 : 10)) {
    try { const t = await rpc('getTransaction', [sg.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]); if (!t || !t.meta) continue;
      const keys = ((t.transaction || {}).message || {}).accountKeys || [], ix = keys.findIndex(k => (k.pubkey || k) === w.addr), dS = ix >= 0 ? ((t.meta.postBalances[ix] || 0) - (t.meta.preBalances[ix] || 0)) / 1e9 : 0;
      const tk = {}; for (const [arr, sg2] of [[t.meta.preTokenBalances || [], -1], [t.meta.postTokenBalances || [], 1]]) for (const b of arr) if (b.owner === w.addr) tk[b.mint] = (tk[b.mint] || 0) + sg2 * (+((b.uiTokenAmount || {}).uiAmount) || 0);
      const legs = Object.entries(tk).filter(([, v]) => Math.abs(v) > 0).map(([m, v]) => ({ m, v })), solUsd = solPx ? Math.abs(dS) * solPx : null;
      const H = new Map([[sg.signature, { at: (sg.blockTime || 0) * 1000, ins: [], outs: [] }]]), g = H.get(sg.signature);
      if (Math.abs(dS) > 0.001) (dS > 0 ? g.ins : g.outs).push({ sym: 'SOL', amt: Math.abs(dS), usd: solUsd });
      for (const l of legs) (l.v > 0 ? g.ins : g.outs).push({ sym: l.m === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : l.m === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' ? 'USDT' : l.m.slice(0, 4) + '…', amt: Math.abs(l.v), usd: null });
      for (const x of [...g.ins, ...g.outs]) if (x.usd == null && STABLES.has(x.sym)) x.usd = x.amt;
      tx.push(...classifyTx(H, 'SOL'));
    } catch (e) { }
  }
  return { assets, tx, price: solPx };
}
async function arkLabel(addr) { if (!linkOn('arkham')) return null; try { const j = await xFetch(XB.arkham + '/intelligence/address/' + encodeURIComponent(addr), { headers: { 'API-Key': LINKS.arkham.key } }, 10000); return (j.arkhamEntity && j.arkhamEntity.name) || (j.arkhamLabel && j.arkhamLabel.name) || (j.entity && j.entity.name) || null; } catch (e) { return null; } }
const walData = (w, light) => w.chain === 'bitcoin' ? btcWallet(w, light) : w.chain === 'solana' ? solWallet(w, light) : evmWallet(w, light);
const W_CLASS = [['paus', '🐋', 'Paus', 10e6, 1e6, 5e6], ['hiu', '🦈', 'Hiu', 1e6, 1e5, 5e5], ['ikan', '🐟', 'Ikan', 0, 0, 0]]; // [kelas, ikon, nama, aset ≥, transaksi terbesar ≥, volume order 7 hari ≥]
const txClass = usd => usd >= 1e6 ? 'paus' : usd >= 1e5 ? 'hiu' : 'ikan';
let EIC = { at: 0, d: null, p: null };
async function eiReport(fresh) {
  if (!fresh && EIC.d && Date.now() - EIC.at < 3 * 60e3) return EIC.d; if (EIC.p) return EIC.p;
  const pr = (async () => {
    const d = { at: Date.now(), wallets: [], err: {}, alarm: { ...WAL.alarm }, alarms: WAL.log.slice(0, 20), arkham: linkOn('arkham') };
    if (!WAL.list.length) return d;
    const res = await mapLimit(WAL.list.slice(0, 40), 3, async w => { try { const [x, ent] = await Promise.all([walData(w, false), arkLabel(w.addr)]); return { w, ...x, ent }; } catch (e) { return { w, err: shortErr(e), assets: [], tx: [] }; } });
    const wk = Date.now() - 7 * 86400e3;
    for (const r of res) {
      const total = r.assets.reduce((a, x) => a + (x.usd || 0), 0), recent = r.tx.filter(t => t.at >= wk), buy = recent.filter(t => t.kind === 'buy').reduce((a, t) => a + (t.usd || 0), 0), sell = recent.filter(t => t.kind === 'sell').reduce((a, t) => a + (t.usd || 0), 0);
      const big = Math.max(0, ...r.tx.map(t => t.usd || 0)), vol = recent.reduce((a, t) => a + (t.usd || 0), 0);
      const c = W_CLASS.find(([, , , A, T, V]) => total >= A || big >= T || vol >= V) || W_CLASS[2], why = [];
      if (c[0] !== 'ikan') { if (total >= c[3]) why.push('aset ' + usdF(total) + ' ≥ ' + usdF(c[3])); if (big >= c[4]) why.push('transaksi terbesar ' + usdF(big) + ' ≥ ' + usdF(c[4])); if (vol >= c[5]) why.push('volume 7 hari ' + usdF(vol) + ' ≥ ' + usdF(c[5])); }
      else why.push('aset ' + usdF(total) + ', transaksi terbesar ' + usdF(big) + ' (di bawah ambang hiu)');
      d.wallets.push({ id: r.w.id, addr: r.w.addr, chain: r.w.chain, label: r.w.label, src: r.w.src, url: r.w.url, ent: r.ent || null, err: r.err || null, total, buy, sell, vol, big, cls: c[0], icon: c[1], clsName: c[2], why, n: r.tx.length,
        assets: r.assets.sort((x, y) => (y.usd || 0) - (x.usd || 0)).slice(0, 12), tx: r.tx.slice(0, 15).map(t => ({ ...t, tcls: txClass(t.usd || 0) })) });
    }
    const all = d.wallets.flatMap(w => w.tx.map(t => ({ ...t, w: w.label || w.addr.slice(0, 8), wid: w.id, chain: w.chain })));
    d.orders = { buy: d.wallets.reduce((a, w) => a + w.buy, 0), sell: d.wallets.reduce((a, w) => a + w.sell, 0), top: all.filter(t => t.usd).sort((x, y) => y.usd - x.usd).slice(0, 12) };
    d.classes = Object.fromEntries(W_CLASS.map(c => [c[0], d.wallets.filter(w => w.cls === c[0]).length]));
    d.criteria = W_CLASS.map(([k, ic, n, A, T, V]) => ({ k, ic, n, A, T, V }));
    const agg = {}; for (const w of d.wallets) for (const a of w.assets) { const k = a.sym; agg[k] = agg[k] || { sym: k, usd: 0, n: 0 }; agg[k].usd += a.usd || 0; agg[k].n++; }
    d.topAssets = Object.values(agg).sort((x, y) => y.usd - x.usd).slice(0, 10);
    d.total = d.wallets.reduce((a, w) => a + w.total, 0);
    return d;
  })();
  EIC.p = pr; try { const d = await pr; EIC = { at: Date.now(), d, p: null }; return d; } finally { if (EIC.p === pr) EIC.p = null; }
}
// Whale Alarm: cek transaksi baru semua wallet berkala; transaksi ≥ batas (USD) memicu notifikasi
const WSEEN = {}; let WAL_RUN = 0, WAL_BUSY = false;
async function whaleTick(force) {
  if (WAL_BUSY || !WAL.list.length || (!WAL.alarm.on && !force)) return; if (!force && Date.now() - WAL_RUN < Math.max(1, WAL.alarm.every) * 60e3) return;
  WAL_BUSY = true; WAL_RUN = Date.now(); const hits = [];
  try {
    await mapLimit(WAL.list.slice(0, 40), 3, async w => {
      let x; try { x = await walData(w, true); } catch (e) { return; }
      const first = !WSEEN[w.id]; WSEEN[w.id] = WSEEN[w.id] || new Set();
      for (const t of x.tx) { if (WSEEN[w.id].has(t.hash)) continue; WSEEN[w.id].add(t.hash); if (!first && (t.usd || 0) >= WAL.alarm.min) hits.push({ w, t }); }
    });
    for (const { w, t } of hits) {
      const nm = w.label || w.addr.slice(0, 8) + '…', k = { buy: 'membeli', sell: 'menjual', in: 'menerima', out: 'mengirim', swap: 'menukar' }[t.kind] || t.kind, ic = W_CLASS.find(c => c[0] === txClass(t.usd || 0))[1];
      const e = { at: Date.now(), wid: w.id, w: nm, chain: w.chain, kind: t.kind, sym: t.sym, usd: t.usd, hash: t.hash, msg: ic + ' Whale Alarm: ' + nm + ' ' + k + ' ' + t.sym + ' senilai ' + usdF(t.usd) + ' (' + w.chain + ')' };
      WAL.log.unshift(e); broadcast({ t: 'whale', ...e }); toast(e.msg, 'info');
    }
    if (hits.length) { WAL.log = WAL.log.slice(0, 100); saveWal(); EIC.at = 0; }
  } finally { WAL_BUSY = false; }
}
setInterval(() => whaleTick(false).catch(() => { }), 60e3);

// ---------- JUAL SEKARANG (kartu order & bot): jual posisi spot pair ini, seluruhnya atau senilai rupiah tertentu ----------
function splitPos(pos, frac) { // pecah posisi: bagian frac dijadikan posisi baru (untuk jual sebagian)
  const part = { ...pos, id: uid(pos.isBot ? 'bot_' : 'pos_'), amount: pos.amount * frac, cost: pos.cost * frac, lim: null, closing: false, fails: 0, splitOf: pos.id };
  pos.amount -= part.amount; pos.cost -= part.cost; S.positions.push(part); return part;
}
async function sellNow(b) {
  const p = P(), mode = b.mode === 'limit' ? 'limit' : 'market', onlyBot = b.bot === true;
  if (!(M.price > 0)) throw new Error('Harga belum tersedia');
  let list = S.positions.filter(x => !x.closing && x.pair === p.id && (onlyBot ? x.isBot : x.type !== 'futures'));
  if (mode === 'limit') list = list.filter(x => !x.lim && x.type !== 'futures');
  if (!list.length) throw new Error(onlyBot ? 'Tidak ada posisi bot yang bisa dijual' : mode === 'limit' ? 'Tidak ada posisi ' + p.coin.toUpperCase() + ' tanpa order jual limit' : 'Tidak ada posisi ' + p.coin.toUpperCase() + ' untuk dijual. Beli dulu, atau ganti ke FUTURES untuk short.');
  const price = mode === 'limit' ? +b.price : M.price;
  if (mode === 'limit' && !(price > 0)) throw new Error('Isi harga limit yang valid');
  const val = x => x.type === 'futures' ? x.margin : x.amount * price, total = list.reduce((a, x) => a + val(x), 0);
  let idr = Math.floor(+b.idr || 0), pick = list;
  if (!onlyBot && idr > 0 && idr < total * 0.999) { // jual sebagian, posisi terlama dulu
    if (idr < p.minIdr) throw new Error('Minimal jual ' + fmt(p.minIdr));
    pick = []; let rem = idr;
    for (const x of list.slice().sort((a, c) => a.openedAt - c.openedAt)) {
      const v = val(x); if (rem <= 0) break;
      if (rem >= v * 0.999) { pick.push(x); rem -= v; }
      else { if (rem >= p.minIdr && (v - rem) >= p.minIdr * 0.5) pick.push(splitPos(x, rem / v)); else pick.push(x); rem = 0; }
    }
    save();
  }
  const n = pick.length, sum = pick.reduce((a, x) => a + val(x), 0);
  if (mode === 'market') { for (const x of pick) await closePos(x.id, onlyBot ? 'Jual sekarang (bot)' : 'Jual sekarang'); }
  else { for (const x of pick) await placeLimit({ side: 'sell', posId: x.id, price }); }
  pushState(); return { n, value: sum };
}

// ---------- Pasar (sidebar kiri): Crypto, Saham, Forex, Commodities, Macro Economy ----------
// Sumber: CoinGecko / CoinMarketCap (kunci opsional) / Crypto.com · IDX (cadangan Yahoo Finance) · MetaTrader 5 (jembatan opsional, cadangan Yahoo)
// · harga futures komoditas (Yahoo; investing.com tidak punya API publik) · CNN Fear & Greed, kalender ekonomi, RSS CNN & Bloomberg Technoz.
const MK = {
  yahoo: (E.YAHOO_BASE || 'https://query1.finance.yahoo.com').replace(/\/$/, ''),
  idx: (E.IDX_BASE || 'https://www.idx.co.id').replace(/\/$/, ''),
  cnnfg: E.CNN_FG_URL || 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
  ffcal: E.FF_CAL_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  cdc: (E.CDC_BASE || 'https://api.crypto.com/exchange/v1').replace(/\/$/, ''),
  mt5: (E.MT5_BRIDGE || 'http://127.0.0.1:5005').replace(/\/$/, ''),
  rss: (E.MACRO_RSS || 'https://www.cnnindonesia.com/ekonomi/rss,http://rss.cnn.com/rss/money_latest.rss,https://www.bloombergtechnoz.com/rss').split(',').map(x => x.trim()).filter(Boolean),
};
const BUA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'application/json, text/plain, */*', 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' };
async function getJsonH(url, ms, headers) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 10000);
  try { const r = await fetch(url, { signal: ac.signal, headers: headers || BUA }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); }
}
const MKC = {};
function cached(key, ttl, f) {
  const c = MKC[key]; if (c && c.d && Date.now() - c.at < ttl) return Promise.resolve(c.d); if (c && c.p) return c.p;
  const p = f().then(d => { MKC[key] = { at: Date.now(), d }; return d; }); MKC[key] = { ...(c || {}), p }; p.catch(() => { if (MKC[key]) delete MKC[key].p; });
  return p;
}
async function mapLimit(arr, n, f) { const out = new Array(arr.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (i < arr.length) { const k = i++; out[k] = await f(arr[k], k); } })); return out; }
const Y_RANGE = { '1D': ['1d', '5m'], '1W': ['5d', '30m'], '1M': ['1mo', '1d'], '3M': ['3mo', '1d'], '1Y': ['1y', '1d'], '5Y': ['5y', '1wk'], ALL: ['max', '1mo'] };
async function yChart(sym, range, interval) {
  const j = await getJsonH(MK.yahoo + '/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval + '&includePrePost=false', 10000);
  const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'data kosong');
  const q = ((r.indicators || {}).quote || [])[0] || {}, ts = r.timestamp || [];
  return { meta: r.meta || {}, pts: ts.map((t, i) => ({ t, o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i], v: q.volume && q.volume[i] })).filter(x => x.c != null) };
}
function yQuotes(list) {
  return mapLimit(list, 6, async ([sym, name, extra]) => cached('yq:' + sym, 60e3, async () => {
    const { meta, pts } = await yChart(sym, '5d', '1d'); const last = meta.regularMarketPrice != null ? +meta.regularMarketPrice : pts.length ? pts[pts.length - 1].c : null;
    const prev = pts.length > 1 && Math.abs(pts[pts.length - 1].t * 1000 - Date.now()) < 4 * 86400e3 ? pts[pts.length - 2].c : meta.chartPreviousClose;
    const lv = meta.regularMarketVolume != null ? +meta.regularMarketVolume : pts.length ? +pts[pts.length - 1].v || null : null;
    return { last, prev, ch: prev ? (last / prev - 1) * 100 : null, cur: meta.currency || '', hi: meta.regularMarketDayHigh != null ? +meta.regularMarketDayHigh : null, lo: meta.regularMarketDayLow != null ? +meta.regularMarketDayLow : null, vol: lv, val: lv && last ? lv * last : null };
  }).then(q => ({ sym, name, ...q, ...(extra || {}) })).catch(e => ({ sym, name, err: shortErr(e), ...(extra || {}) })));
}
// kutipan Yahoo v7 (butuh cookie + crumb) untuk market cap per emiten; hasil di-cache 1 jam
let YCR = { at: 0, cookie: '', crumb: '' };
async function yCrumb() {
  if (YCR.crumb && Date.now() - YCR.at < 3600e3) return YCR;
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch(E.YAHOO_FC || 'https://fc.yahoo.com', { signal: ac.signal, headers: BUA, redirect: 'manual' }).catch(() => null);
    const sc = r ? (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']).map(x => String(x).split(';')[0]).filter(Boolean).join('; ') : '';
    const c = await fetch((E.YAHOO_Q2 || 'https://query2.finance.yahoo.com') + '/v1/test/getcrumb', { signal: ac.signal, headers: { ...BUA, Cookie: sc } });
    const crumb = (await c.text()).trim(); if (!c.ok || !crumb || /</.test(crumb)) throw new Error('crumb Yahoo tidak didapat');
    YCR = { at: Date.now(), cookie: sc, crumb }; return YCR;
  } finally { clearTimeout(t); }
}
async function yQuoteV7(syms) {
  const k = await yCrumb(), j = await getJsonH((E.YAHOO_Q2 || 'https://query2.finance.yahoo.com') + '/v7/finance/quote?symbols=' + encodeURIComponent(syms.join(',')) + '&crumb=' + encodeURIComponent(k.crumb), 10000, { ...BUA, Cookie: k.cookie });
  return ((j.quoteResponse || {}).result || []).map(q => ({ sym: q.symbol, cap: +q.marketCap || null, last: +q.regularMarketPrice || null, vol: +q.regularMarketVolume || null }));
}
const IDXH = { ...BUA, Referer: 'https://www.idx.co.id/id/data-pasar/ringkasan-perdagangan/ringkasan-saham/', Origin: 'https://www.idx.co.id' };
async function idxDay(kind) { // data perdagangan IDX hari bursa terakhir (mundur sampai 7 hari)
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + WIB * 1000 - i * 86400e3), ds = d.toISOString().slice(0, 10).replace(/-/g, '');
    if (i > 0 && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) continue;
    const j = await getJsonH(MK.idx + '/primary/TradingSummary/Get' + kind + '?length=9999&start=0&date=' + ds, 15000, IDXH);
    if (j && Array.isArray(j.data) && j.data.length) return { date: ds, data: j.data };
  }
  throw new Error('data IDX belum tersedia');
}
const LQ = 'BBCA BBRI BMRI BBNI TLKM ASII GOTO UNVR ICBP INDF ADRO PTBA ITMG ANTM MDKA INCO UNTR KLBF CPIN AMRT MBMA BRPT TPIA AKRA SMGR EXCL ISAT ARTO MEDC PGAS BRIS AMMN CUAN BREN PGEO'.split(' ');
async function mktSaham() {
  const d = { at: Date.now(), err: {} }, job = async (k, f) => { try { await f(); } catch (e) { d.err[k] = shortErr(e); } };
  await Promise.all([
    job('ihsg', async () => { d.ihsg = (await yQuotes([['^JKSE', 'IHSG']]))[0]; if (d.ihsg.err) throw new Error(d.ihsg.err); }),
    job('idx', async () => {
      const r = await idxDay('StockSummary'); d.date = r.date; d.src = 'IDX';
      const rows = r.data.map(x => ({ code: x.StockCode, name: x.StockName, prev: +x.Previous, open: +x.OpenPrice, high: +x.High, low: +x.Low, close: +x.Close, chg: +x.Change, vol: +x.Volume, val: +x.Value, freq: +x.Frequency, fb: +x.ForeignBuy || 0, fs: +x.ForeignSell || 0 })).filter(x => x.close > 0);
      rows.forEach(x => { x.pct = x.prev > 0 ? (x.close / x.prev - 1) * 100 : null; });
      const sum = k => rows.reduce((a, x) => a + (x[k] || 0), 0), fbv = rows.reduce((a, x) => a + x.fb * x.close, 0), fsv = rows.reduce((a, x) => a + x.fs * x.close, 0);
      d.market = { n: rows.length, vol: sum('vol'), val: sum('val'), freq: sum('freq'), up: rows.filter(x => x.chg > 0).length, down: rows.filter(x => x.chg < 0).length, flat: rows.filter(x => !x.chg).length, fbuy: fbv, fsell: fsv, fnet: fbv - fsv };
      const liq = rows.filter(x => x.val >= 1e9), pick = x => ({ code: x.code, name: x.name, close: x.close, chg: x.chg, pct: x.pct, val: x.val, freq: x.freq, vol: x.vol, fnet: (x.fb - x.fs) * x.close });
      d.gainers = liq.slice().sort((a, b) => b.pct - a.pct).slice(0, 10).map(pick); d.losers = liq.slice().sort((a, b) => a.pct - b.pct).slice(0, 10).map(pick);
      d.active = rows.slice().sort((a, b) => b.val - a.val).slice(0, 12).map(pick); d.trending = rows.slice().sort((a, b) => b.freq - a.freq).slice(0, 12).map(pick);
      const fn = x => (x.fb - x.fs) * x.close; d.foreignBuy = rows.filter(x => fn(x) > 0).sort((a, b) => fn(b) - fn(a)).slice(0, 6).map(pick); d.foreignSell = rows.filter(x => fn(x) < 0).sort((a, b) => fn(a) - fn(b)).slice(0, 6).map(pick);
    }),
    job('index', async () => { const r = await idxDay('IndexSummary'), c = r.data.find(x => /COMPOSITE|IHSG/i.test(x.IndexCode || '')); if (c) d.index = { prev: +c.Previous, high: +c.Highest, low: +c.Lowest, close: +c.Close, chg: +c.Change, vol: +c.Volume, val: +c.Value, freq: +c.Frequency, cap: +c.MarketCapital }; }),
  ]);
  if (!d.active) { // cadangan: saham LQ45 dari Yahoo Finance
    const q = (await yQuotes(LQ.map(c => [c + '.JK', c]))).filter(x => !x.err && x.last > 0).map(x => ({ code: x.name, name: IDX_NAMES[x.name] || '', close: x.last, chg: x.last - x.prev, pct: x.ch, vol: x.vol, val: x.val, est: true }));
    if (q.length) { d.src = 'Yahoo Finance (cadangan, IDX tidak bisa dijangkau)'; d.gainers = q.slice().sort((a, b) => b.pct - a.pct).slice(0, 10); d.losers = q.slice().sort((a, b) => a.pct - b.pct).slice(0, 10); d.active = q.slice().sort((a, b) => (b.val || 0) - (a.val || 0)).slice(0, 12); d.trending = q.slice().sort((a, b) => Math.abs(b.pct || 0) * (b.val || 0) - Math.abs(a.pct || 0) * (a.val || 0)).slice(0, 12);
      d.market = d.market || { n: q.length, val: q.reduce((a, x) => a + (x.val || 0), 0), vol: q.reduce((a, x) => a + (x.vol || 0), 0), up: q.filter(x => x.pct > 0).length, down: q.filter(x => x.pct < 0).length, flat: q.filter(x => !x.pct).length, est: true }; }
  }
  if (!(d.index && d.index.cap > 0)) { // kapitalisasi: dari IDX; bila tidak bisa, jumlah market cap saham utama dari Yahoo
    try { const caps = (await cached('ycap:LQ', 3600e3, () => yQuoteV7(LQ.map(c => c + '.JK')))).filter(x => x.cap > 0); if (caps.length) { d.capEst = { cap: caps.reduce((a, x) => a + x.cap, 0), n: caps.length }; } } catch (e) { d.err.cap = shortErr(e); }
  }
  if (!d.ihsg && !d.active) throw new Error('Data saham gagal: ' + (d.err.idx || d.err.ihsg));
  return d;
}
async function mktCrypto() {
  const d = { at: Date.now(), err: {} }, job = async (k, f) => { try { await f(); } catch (e) { d.err[k] = shortErr(e); } };
  await Promise.all([
    job('global', async () => { const g = (await cg('/global')).data || {}, mp = g.market_cap_percentage || {}; d.global = { mcap: (g.total_market_cap || {}).usd, vol: (g.total_volume || {}).usd, ch24: g.market_cap_change_percentage_24h_usd, btc: mp.btc, eth: mp.eth, coins: g.active_cryptocurrencies }; }),
    job('top', async () => { const a = await cg('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=1h,24h,7d'); if (!Array.isArray(a)) throw new Error('data kosong'); const f = (c, k) => { const v = c['price_change_percentage_' + k + '_in_currency']; return isFinite(v) ? +v : k === '24h' && isFinite(c.price_change_percentage_24h) ? +c.price_change_percentage_24h : null; };
      d.top = a.map(c => ({ id: c.id, sym: String(c.symbol || '').toUpperCase(), name: c.name, img: c.image || '', usd: c.current_price, ch1: f(c, '1h'), ch24: f(c, '24h'), ch7: f(c, '7d'), mcap: c.market_cap, vol: c.total_volume, rank: c.market_cap_rank, hi: c.high_24h, lo: c.low_24h })); }),
    job('trend', async () => { const t = await cg('/search/trending'); d.trend = (t.coins || []).map(x => x.item || x).slice(0, 10).map(c => ({ id: c.id, name: c.name, sym: String(c.symbol || '').toUpperCase(), rank: c.market_cap_rank || null, ch24: c.data && c.data.price_change_percentage_24h ? +c.data.price_change_percentage_24h.usd : null, usd: c.data && c.data.price != null ? +c.data.price : null })); }),
    job('fng', async () => { const j = await getJson(XB.fng + '?limit=8', 9000), a = j.data || []; if (a[0]) d.fng = { v: +a[0].value, lb: a[0].value_classification, y: a[1] ? +a[1].value : null, w: a[7] ? +a[7].value : null }; }),
    job('cdc', async () => { const j = await getJsonH(MK.cdc + '/public/get-tickers', 10000); const a = ((j.result || {}).data || []).filter(x => /_(USD|USDT)$/.test(x.i || '') && !/PERP/.test(x.i)); if (!a.length) throw new Error('data kosong');
      d.cdc = a.map(x => ({ sym: x.i.replace('_', '/'), last: +x.a, ch: +x.c * 100, vv: +x.vv, hi: +x.h, lo: +x.l })).filter(x => x.vv > 0).sort((p, q) => q.vv - p.vv).slice(0, 10); }),
    job('cmc', async () => { if (!linkOn('cmc')) return; const h = { 'X-CMC_PRO_API_KEY': LINKS.cmc.key }, [l, fg, gm] = await Promise.all([xFetch(XB.cmc + '/v1/cryptocurrency/listings/latest?limit=10&convert=USD', { headers: h }, 12000), xFetch(XB.cmc + '/v3/fear-and-greed/latest', { headers: h }, 12000).catch(() => null), xFetch(XB.cmc + '/v1/global-metrics/quotes/latest', { headers: h }, 12000).catch(() => null)]);
      d.cmc = { top: (l.data || []).map(c => ({ rank: c.cmc_rank, name: c.name, sym: c.symbol, usd: ((c.quote || {}).USD || {}).price, ch24: ((c.quote || {}).USD || {}).percent_change_24h })), fng: fg && fg.data ? { v: +fg.data.value, lb: fg.data.value_classification } : null, alt: gm && gm.data ? { btcDom: +gm.data.btc_dominance, defi: +((gm.data.quote || {}).USD || {}).defi_market_cap } : null }; }),
    job('news', async () => { const it = await newsItems(); d.news = it.slice(0, 8).map(({ title, link, at, src }) => ({ title, link, at, src })); }),
  ]);
  if (!d.top && !d.cdc) throw new Error('Data kripto gagal: ' + (d.err.top || d.err.cdc));
  return d;
}
const FX = [['EURUSD', 'EUR/USD'], ['GBPUSD', 'GBP/USD'], ['USDJPY', 'USD/JPY'], ['AUDUSD', 'AUD/USD'], ['USDCHF', 'USD/CHF'], ['USDCAD', 'USD/CAD'], ['NZDUSD', 'NZD/USD'], ['EURJPY', 'EUR/JPY'], ['GBPJPY', 'GBP/JPY'], ['XAUUSD', 'Emas XAU/USD'], ['USDIDR', 'USD/IDR'], ['USDSGD', 'USD/SGD']];
const YFX = s => s === 'XAUUSD' ? 'GC=F' : s === 'USDIDR' ? 'IDR=X' : s.startsWith('USD') ? s.slice(3) + '=X' : s + '=X';
async function mt5Quotes() { const j = await getJsonH(MK.mt5 + '/quotes?symbols=' + FX.map(x => x[0]).join(','), 2500, { Accept: 'application/json' }); if (!Array.isArray(j) || !j.length) throw new Error('kosong'); return j; }
async function mktForex() {
  const d = { at: Date.now(), err: {} };
  try { const q = await mt5Quotes(); d.src = 'MetaTrader 5'; d.rows = FX.map(([s, n]) => { const x = q.find(z => String(z.symbol).toUpperCase().startsWith(s)); return x ? { sym: s, name: n, bid: +x.bid, ask: +x.ask, last: (+x.bid + +x.ask) / 2, prev: +x.prev_close || null, ch: +x.prev_close ? ((+x.bid + +x.ask) / 2 / +x.prev_close - 1) * 100 : null, spread: +x.spread || null, mt5sym: x.symbol } : { sym: s, name: n, err: 'tidak ada di MT5' }; }); }
  catch (e) { d.err.mt5 = 'Jembatan MT5 tidak aktif (' + shortErr(e) + ')'; d.src = 'Yahoo Finance'; d.rows = await yQuotes(FX.map(([s, n]) => [YFX(s), n, { pair: s }])); d.rows.forEach(r => { r.yahoo = r.sym; r.sym = r.pair; }); }
  d.idr = await yQuotes([['IDR=X', 'USD/IDR'], ['EURIDR=X', 'EUR/IDR'], ['SGDIDR=X', 'SGD/IDR'], ['JPYIDR=X', 'JPY/IDR'], ['CNYIDR=X', 'CNY/IDR'], ['AUDIDR=X', 'AUD/IDR'], ['GBPIDR=X', 'GBP/IDR'], ['MYRIDR=X', 'MYR/IDR']]);
  d.news = await rssPull(FX_RSS, FX_RE, 30).catch(() => []);
  return d;
}
const FX_RSS = (E.FOREX_RSS || 'https://www.investing.com/rss/news_1.rss,https://www.fxstreet.com/rss/news,https://www.cnbcindonesia.com/market/rss,https://www.cnnindonesia.com/ekonomi/rss,https://www.bloombergtechnoz.com/rss').split(',').map(x => x.trim()).filter(Boolean);
const FX_RE = /\b(rupiah|dolar|dollar|USD|EUR|euro|yen|JPY|pound|sterling|GBP|yuan|renminbi|CNY|franc|CHF|AUD|NZD|CAD|SGD|valas|kurs|forex|FX|currenc\w*|mata uang|Fed|FOMC|ECB|BoJ|BoE|BI[- ]?Rate|suku bunga|interest rates?|inflasi|inflation|DXY|payrolls?|NFP|CPI|Treasury yields?)\b/i;
const COMM = [['GC=F', 'Emas', 'USD/troy oz', 'gold'], ['SI=F', 'Perak', 'USD/troy oz', 'silver'], ['PL=F', 'Platinum', 'USD/troy oz', 'platinum'], ['HG=F', 'Tembaga', 'USD/lb', 'copper'], ['CL=F', 'Minyak WTI', 'USD/barel', 'crude-oil'], ['BZ=F', 'Minyak Brent', 'USD/barel', 'brent-oil'], ['NG=F', 'Gas alam', 'USD/MMBtu', 'natural-gas'], ['ZC=F', 'Jagung', 'sen USD/bushel', 'us-corn'], ['ZW=F', 'Gandum', 'sen USD/bushel', 'us-wheat'], ['ZS=F', 'Kedelai', 'sen USD/bushel', 'us-soybeans'], ['KC=F', 'Kopi Arabika', 'sen USD/lb', 'us-coffee-c'], ['CC=F', 'Kakao', 'USD/ton', 'us-cocoa'], ['SB=F', 'Gula', 'sen USD/lb', 'us-sugar-no11'], ['CT=F', 'Kapas', 'sen USD/lb', 'us-cotton-no.2']];
// ---------- katalog aset non-kripto untuk chart (tombol 📈 💱 🛢️ 🏠 di pemilih aset) ----------
const IDX_NAMES = { BBCA: 'Bank Central Asia', BBRI: 'Bank Rakyat Indonesia', BMRI: 'Bank Mandiri', BBNI: 'Bank Negara Indonesia', BBTN: 'Bank Tabungan Negara', BRIS: 'Bank Syariah Indonesia', ARTO: 'Bank Jago', TLKM: 'Telkom Indonesia', ISAT: 'Indosat Ooredoo Hutchison', EXCL: 'XL Axiata', TOWR: 'Sarana Menara Nusantara',
  ASII: 'Astra International', UNTR: 'United Tractors', GOTO: 'GoTo Gojek Tokopedia', BUKA: 'Bukalapak', EMTK: 'Elang Mahkota Teknologi', UNVR: 'Unilever Indonesia', ICBP: 'Indofood CBP', INDF: 'Indofood Sukses Makmur', MYOR: 'Mayora Indah', CPIN: 'Charoen Pokphand Indonesia', AMRT: 'Sumber Alfaria Trijaya', MAPI: 'Mitra Adiperkasa',
  HMSP: 'HM Sampoerna', GGRM: 'Gudang Garam', KLBF: 'Kalbe Farma', SIDO: 'Sido Muncul', MIKA: 'Mitra Keluarga', ADRO: 'Alamtri Resources (Adaro)', PTBA: 'Bukit Asam', ITMG: 'Indo Tambangraya Megah', HRUM: 'Harum Energy', ANTM: 'Aneka Tambang', MDKA: 'Merdeka Copper Gold', MBMA: 'Merdeka Battery Materials', INCO: 'Vale Indonesia',
  AMMN: 'Amman Mineral', BRPT: 'Barito Pacific', TPIA: 'Chandra Asri Pacific', BREN: 'Barito Renewables Energy', CUAN: 'Petrindo Jaya Kreasi', PGEO: 'Pertamina Geothermal Energy', MEDC: 'Medco Energi', PGAS: 'Perusahaan Gas Negara', AKRA: 'AKR Corporindo', SMGR: 'Semen Indonesia', INKP: 'Indah Kiat Pulp & Paper', JSMR: 'Jasa Marga' };
const PROP_NAMES = { BSDE: 'Bumi Serpong Damai', CTRA: 'Ciputra Development', PWON: 'Pakuwon Jati', SMRA: 'Summarecon Agung', ASRI: 'Alam Sutera Realty', DMAS: 'Puradelta Lestari', LPKR: 'Lippo Karawaci', APLN: 'Agung Podomoro Land', JRPT: 'Jaya Real Property', MKPI: 'Metropolitan Kentjana',
  DILD: 'Intiland Development', KIJA: 'Kawasan Industri Jababeka', BKSL: 'Sentul City', MTLA: 'Metropolitan Land', PPRO: 'PP Properti', SSIA: 'Surya Semesta Internusa', MDLN: 'Modernland Realty', GPRA: 'Perdana Gapuraprima' };
const FX_CAT = [['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['JPY=X', 'USD/JPY'], ['AUDUSD=X', 'AUD/USD'], ['CHF=X', 'USD/CHF'], ['CAD=X', 'USD/CAD'], ['NZDUSD=X', 'NZD/USD'], ['EURJPY=X', 'EUR/JPY'], ['GBPJPY=X', 'GBP/JPY'], ['EURGBP=X', 'EUR/GBP'], ['SGD=X', 'USD/SGD'],
  ['IDR=X', 'USD/IDR'], ['EURIDR=X', 'EUR/IDR'], ['SGDIDR=X', 'SGD/IDR'], ['JPYIDR=X', 'JPY/IDR'], ['AUDIDR=X', 'AUD/IDR'], ['CNYIDR=X', 'CNY/IDR'], ['DX-Y.NYB', 'Indeks Dolar (DXY)']];
function assetCat(cat) {
  if (cat === 'saham') return Object.entries(IDX_NAMES).map(([c, n]) => ({ id: 'yh:' + c + '.JK', sym: c, name: n, cur: 'IDR' }));
  if (cat === 'prop') return Object.entries(PROP_NAMES).map(([c, n]) => ({ id: 'yh:' + c + '.JK', sym: c, name: n, cur: 'IDR' }));
  if (cat === 'forex') return FX_CAT.map(([y, n]) => ({ id: 'yh:' + y, sym: n, name: n, cur: '' }));
  if (cat === 'commod') return COMM.map(([y, n, u]) => ({ id: 'yh:' + y, sym: n, name: u, cur: 'USD' }));
  return null;
}
async function assetList(cat, q) {
  const base = assetCat(cat); if (!base) throw new Error('Kategori tidak dikenal');
  q = String(q || '').trim().toUpperCase(); let list = base;
  if (q) { list = base.filter(a => (a.sym + ' ' + a.name).toUpperCase().includes(q)); if ((cat === 'saham' || cat === 'prop') && /^[A-Z]{4}$/.test(q) && !list.some(a => a.sym === q)) list.unshift({ id: 'yh:' + q + '.JK', sym: q, name: 'Kode IDX ' + q, cur: 'IDR' }); }
  const qs = await cached('al:' + cat + ':' + q, 120e3, () => yQuotes(list.map(a => [a.id.slice(3), a.name])));
  return list.map((a, i) => ({ ...a, last: qs[i] && !qs[i].err ? qs[i].last : null, ch: qs[i] && !qs[i].err ? qs[i].ch : null }));
}
async function mktCommod() {
  const rows = await yQuotes(COMM.map(([s, n, u, slug]) => [s, n, { unit: u, link: 'https://www.investing.com/commodities/' + slug }]));
  const g = rows.find(r => r.sym === 'GC=F'), sv = rows.find(r => r.sym === 'SI=F'), u = (await yQuotes([['IDR=X', 'USD/IDR']]))[0];
  return { at: Date.now(), src: 'Yahoo Finance (harga futures)', rows, goldIdr: g && g.last && u && u.last ? { gram: g.last * u.last / 31.1035, usdIdr: u.last, ch: g.ch } : null,
    silverIdr: sv && sv.last && u && u.last ? { gram: sv.last * u.last / 31.1035, usdIdr: u.last, ch: sv.ch } : null,
    news: await rssPull(COMM_RSS, COMM_RE, 30).catch(() => []) };
}
// ---------- Berita dari beberapa media (RSS) dengan saringan kata kunci ----------
async function rssPull(urls, re, max) {
  const all = [];
  await Promise.all(urls.map(async u => { try {
    const x = await getText(u, 9000), host = new URL(u).hostname.replace(/^(www|rss|feeds)\./, '');
    for (const m of x.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) { const it = m[0], g = tag => { const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(it); return r ? unx(r[1]) : ''; };
      const title = g('title'), link = (g('link') || (/<guid[^>]*>([^<]+)<\/guid>/.exec(it) || [])[1] || '').trim(), at = Date.parse(g('pubDate') || g('dc:date')) || 0, desc = g('description');
      if (title && /^https?:\/\//.test(link) && (!re || re.test(title + ' ' + desc))) all.push({ title: title.slice(0, 200), link, at, src: host, desc: desc.slice(0, 220) }); }
  } catch (e) { } }));
  const seen = new Set();
  return all.sort((a, b) => b.at - a.at).filter(x => { const k = x.title.slice(0, 60).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max || 30);
}
const COMM_RSS = (E.COMMOD_RSS || 'https://oilprice.com/rss/main,https://www.mining.com/feed/,https://www.investing.com/rss/news_11.rss,https://www.cnbcindonesia.com/market/rss,https://www.cnnindonesia.com/ekonomi/rss,https://www.bloombergtechnoz.com/rss').split(',').map(x => x.trim()).filter(Boolean);
const COMM_RE = /\b(emas|perak|minyak|batu ?bara|nikel|timah|tembaga|bauksit|sawit|CPO|karet|kopi|kakao|gula|gandum|jagung|kedelai|komoditas|gas alam|LNG|OPEC|gold|silver|oil|crude|brent|WTI|coal|nickel|copper|tin|aluminium|aluminum|platinum|palladium|lithium|iron ore|palm oil|wheat|corn|soybeans?|coffee|cocoa|sugar|natural gas|commodit\w*|mining|metals?)\b/i;
const PROP_RSS = (E.PROPERTY_RSS || 'https://www.cnnindonesia.com/ekonomi/rss,https://www.bloombergtechnoz.com/rss,https://www.cnbcindonesia.com/news/rss,https://www.cnbcindonesia.com/market/rss,https://www.antaranews.com/rss/ekonomi.xml').split(',').map(x => x.trim()).filter(Boolean);
const PROP_RE = /\b(properti|property|rumah|perumahan|hunian|apartemen|KPR|Tapera|FLPP|pengembang|developer|real estate|REIT|DIRE|kawasan industri|tanah|lahan|sewa|kontrakan|rusun|rumah subsidi|harga rumah|suku bunga|BI[- ]?Rate|BTN|SSIA|BSDE|CTRA|PWON|SMRA|ASRI|DMAS|KIJA|LPKR|APLN|MKPI)\b/i;
// ---------- Batas akses harian: basic 3x, pro 20x, max tanpa batas (per fitur, per akun, reset 00.00 WIB) ----------
const PLAN_LIM = { basic: 3, pro: 20, max: Infinity }, PLAN_NAME = { basic: 'Basic', pro: 'Pro', max: 'Max' }, QUOTA_FEAT = { mi: 'Market Intelligence', rd: 'Research Intelligence', ii: 'Investment Intelligence' };
const QUOTA_FILE = path.join(CFG.dataDir, 'quota.json');
let QUOTA = { day: '', u: {} }; try { const q = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')); if (q && q.u) QUOTA = q; } catch (e) { }
const quotaDay = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const planOf = p => PLAN_LIM[String(p || '').toLowerCase()] !== undefined ? String(p).toLowerCase() : 'basic';
function quotaView(user, plan) {
  plan = planOf(plan); if (QUOTA.day !== quotaDay()) QUOTA = { day: quotaDay(), u: {} };
  const lim = PLAN_LIM[plan], used = {}; for (const f of Object.keys(QUOTA_FEAT)) used[f] = QUOTA.u[user + '|' + f] || 0;
  return { plan, name: PLAN_NAME[plan], lim: lim === Infinity ? null : lim, used };
}
function quotaTake(user, plan, feat) { // melempar galat 429 bila jatah hari ini habis
  const v = quotaView(user, plan), lim = PLAN_LIM[v.plan], k = user + '|' + feat, used = QUOTA.u[k] || 0;
  if (used >= lim) { const e = new Error('Jatah ' + QUOTA_FEAT[feat] + ' hari ini habis (' + lim + 'x untuk paket ' + v.name + '). Dibuka lagi besok pukul 00.00 WIB.'); e.status = 429; throw e; }
  const save = () => { try { fs.writeFileSync(QUOTA_FILE + '.tmp', JSON.stringify(QUOTA)); fs.renameSync(QUOTA_FILE + '.tmp', QUOTA_FILE); } catch (e) { } };
  QUOTA.u[k] = used + 1; save();
  return () => { if (QUOTA.u[k] > 0) { QUOTA.u[k]--; save(); } }; // dikembalikan bila data gagal diambil
}
// ---------- Investment Intelligence (Citra · Value Investing): harga kripto besar & emas dibanding 30 hari, 200 hari, setahun lalu ----------
const II_IDS = 'bitcoin,ethereum,binancecoin,solana,ripple,cardano,tron,dogecoin,avalanche-2,chainlink,polkadot,litecoin,pax-gold';
async function iiValue() {
  const out = { at: Date.now(), crypto: [], gold: null, fg: null, err: '' };
  try {
    const a = await cg('/coins/markets?vs_currency=usd&ids=' + II_IDS + '&price_change_percentage=30d,200d,1y');
    for (const r of Array.isArray(a) ? a : []) {
      const x = { sym: String(r.symbol || '').toUpperCase(), name: r.name, px: +r.current_price, c30: r.price_change_percentage_30d_in_currency ?? null, c200: r.price_change_percentage_200d_in_currency ?? null, c1y: r.price_change_percentage_1y_in_currency ?? null, mc: +r.market_cap || null };
      if (r.id === 'pax-gold') { out.gold = x; continue; }
      const d = [x.c200, x.c30 != null ? x.c30 * .5 : null, x.c1y != null ? x.c1y * .25 : null].filter(v => v != null && isFinite(v)); x.disc = d.length ? -d.reduce((p, q) => p + q, 0) / d.length : null; out.crypto.push(x);
    }
    out.crypto.sort((p, q) => (q.disc == null ? -1e9 : q.disc) - (p.disc == null ? -1e9 : p.disc));
    if (!out.crypto.length) out.err = 'Data harga CoinGecko tidak bisa diambil sekarang.';
  } catch (e) { out.err = 'Data harga CoinGecko tidak bisa diambil sekarang (' + shortErr(e) + ').'; }
  try { const j = await xFetch(XB.fng + '?limit=1', {}, 9000), f = (j.data || [])[0]; if (f) out.fg = { ix: +f.value, lb: ({ 'extreme fear': 'Sangat takut', fear: 'Takut', neutral: 'Netral', greed: 'Serakah', 'extreme greed': 'Sangat serakah' })[String(f.value_classification || '').toLowerCase()] || f.value_classification }; } catch (e) { }
  return out;
}
// ---------- Properti: listing yang Anda input sendiri + saham properti IDX ----------
const PROP_FILE = path.join(CFG.dataDir, 'property.json');
let PROPS = []; try { PROPS = JSON.parse(fs.readFileSync(PROP_FILE, 'utf8')); if (!Array.isArray(PROPS)) PROPS = []; } catch (e) { }
const savePropFile = () => { try { fs.writeFileSync(PROP_FILE + '.tmp', JSON.stringify(PROPS, null, 1)); fs.renameSync(PROP_FILE + '.tmp', PROP_FILE); } catch (e) { log('Gagal simpan properti:', e.message); } };
const PROP_TYPES = ['Rumah', 'Apartemen', 'Ruko', 'Tanah', 'Villa', 'Gudang', 'Kantor', 'Kos'];
function normProp(b, cur) {
  const str = (k, n, req) => { const v = String(b[k] == null ? (cur || {})[k] || '' : b[k]).replace(/[<>]/g, '').trim().slice(0, n); if (req && !v) throw new Error('Isi ' + req); return v; };
  const num = (k, a, z, lb) => { const v = b[k] == null || b[k] === '' ? (cur || {})[k] ?? null : +b[k]; if (v == null || v === '') return null; if (!(Number.isFinite(+v) && +v >= a && +v <= z)) throw new Error(lb + ' tidak valid'); return +v; };
  const type = String(b.type || (cur || {}).type || 'Rumah'); if (!PROP_TYPES.includes(type)) throw new Error('Jenis properti tidak dikenal');
  const link = str('link', 400); if (link && !/^https?:\/\//i.test(link)) throw new Error('Tautan harus diawali http:// atau https://');
  const phone = str('phone', 24); if (phone && !/^[+0-9 ()-]{6,24}$/.test(phone)) throw new Error('Nomor kontak hanya angka, spasi, +, -');
  return { id: (cur && cur.id) || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: str('title', 120, 'judul listing'), type, price: num('price', 1e6, 1e14, 'Harga'), city: str('city', 60, 'kota / lokasi'), addr: str('addr', 160),
    land: num('land', 1, 1e7, 'Luas tanah'), build: num('build', 1, 1e7, 'Luas bangunan'), beds: num('beds', 0, 99, 'Kamar tidur'), baths: num('baths', 0, 99, 'Kamar mandi'), year: num('year', 1800, new Date().getFullYear() + 5, 'Tahun dibangun'),
    contact: str('contact', 60), phone, link, note: str('note', 400), at: (cur && cur.at) || Date.now(), upd: Date.now() };
}
async function mktProp() {
  const d = { at: Date.now(), err: {}, src: 'Listing Anda · saham properti IDX (Yahoo Finance)' };
  try { d.stocks = await yQuotes(Object.entries(PROP_NAMES).map(([c, n]) => [c + '.JK', n, { code: c }])); } catch (e) { d.err.stocks = shortErr(e); }
  try { d.ihsg = (await yQuotes([['^JKSE', 'IHSG']]))[0]; } catch (e) { }
  d.news = await rssPull(PROP_RSS, PROP_RE, 30).catch(() => []);
  d.list = PROPS; return d;
}
// ---------- Macro Global: berita dunia (pemerintahan, AI, politik, isu global, bencana alam) + data bencana ----------
const GL_RSS = (E.GLOBAL_RSS || 'https://feeds.bbci.co.uk/news/world/rss.xml,https://www.aljazeera.com/xml/rss/all.xml,https://www.theguardian.com/world/rss,https://feeds.npr.org/1004/rss.xml,https://rss.dw.com/rdf/rss-en-all,https://feeds.bbci.co.uk/news/technology/rss.xml,https://techcrunch.com/category/artificial-intelligence/feed/,https://www.gdacs.org/xml/rss.xml,https://www.cnnindonesia.com/internasional/rss,https://www.cnnindonesia.com/nasional/rss').split(',').map(x => x.trim()).filter(Boolean);
const GL_CAT = [['bencana', /\b(earthquake|quake|tremor|flood(s|ing)?|hurricane|typhoon|cyclone|wildfire|bushfire|volcan\w*|eruption|tsunami|landslide|mudslide|tornado|drought|heatwave|blizzard|storm|gempa|banjir|longsor|erupsi|kebakaran hutan|puting beliung|kekeringan|disaster|bencana)\b/i],
  ['ai', /\b(AI|A\.I\.|artificial intelligence|OpenAI|ChatGPT|Anthropic|Claude|Gemini|LLM|chatbot|machine learning|deepfake|Nvidia|neural|robot(s|ics)?|automation|kecerdasan buatan|teknologi|digital)\b/],
  ['politik', /\b(election|elections|vote|voters|ballot|campaign|parliament(ary)?|opposition|party|coalition|coup|protest(s|ers)?|referendum|impeach\w*|candidate|polls?|pemilu|pilkada|partai|kampanye|oposisi|koalisi|demo(nstrasi)?|unjuk rasa)\b/i],
  ['pemerintahan', /\b(government|minister|ministry|president|prime minister|cabinet|policy|law|bill|regulat\w*|budget|tax(es)?|court|supreme court|sanction(s)?|treaty|summit|central bank|tariff(s)?|white house|kremlin|congress|senate|pemerintah|presiden|menteri|kementerian|kabinet|kebijakan|undang-undang|regulasi|anggaran|pajak|mahkamah|sanksi|tarif|DPR|istana)\b/i]];
// negara yang ditampilkan: AS, Tiongkok, Rusia (negara adidaya) dan Indonesia. Kata kunci Inggris + Indonesia.
const GL_CC = [['us', /\b(U\.S\.?|US|USA|United States|Americans?|Washington|White House|Pentagon|Congress|Senate|Trump|Vance|Rubio|Hegseth|Wall Street|Federal Reserve|Amerika( Serikat)?|AS)\b/],
  ['cn', /\b(China|Chinese|Beijing|Xi Jinping|Shanghai|Shenzhen|Hong Kong|Taiwan|Tiongkok|Cina)\b/i],
  ['ru', /\b(Russia|Russian|Moscow|Kremlin|Putin|Rusia|Moskow)\b/i],
  ['id', /\b(Indonesia|Indonesian|Jakarta|Prabowo|Gibran|Bali|Papua|Kalimantan|Sumatra|Sumatera|Jawa|Java|Sulawesi|DPR|KPK|BMKG)\b/i]];
const GL_CNAME = { us: 'Amerika Serikat', cn: 'Tiongkok', ru: 'Rusia', id: 'Indonesia' };
const GL_NAME = { bencana: 'Bencana alam', ai: 'AI & teknologi', politik: 'Politik', pemerintahan: 'Pemerintahan', isu: 'Isu global' };
async function mktGlobal() {
  const d = { at: Date.now(), err: {}, src: 'BBC · Al Jazeera · The Guardian · NPR · DW · TechCrunch · CNN Indonesia · GDACS · USGS · BMKG · hanya AS, Tiongkok, Rusia, Indonesia' };
  const job = async (k, f) => { try { await f(); } catch (e) { d.err[k] = shortErr(e); } };
  await Promise.all([
    job('news', async () => {
      const all = [];
      await Promise.all(GL_RSS.map(async u => { try {
        const x = await getText(u, 10000), host = new URL(u).hostname.replace(/^(www|feeds|rss)\./, '');
        for (const m of x.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) { const it = m[0], g = tag => { const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(it); return r ? unx(r[1]) : ''; };
          const title = g('title'), link = g('link') || (/<guid[^>]*>([^<]+)<\/guid>/.exec(it) || [])[1] || '', at = Date.parse(g('pubDate') || g('dc:date')) || 0;
          if (title && /^https?:\/\//.test(link)) all.push({ title: title.slice(0, 220), link: link.trim(), at, src: host, desc: g('description').slice(0, 260) }); }
      } catch (e) { } }));
      if (!all.length) throw new Error('feed berita dunia tidak bisa diambil');
      const seen = new Set(), list = all.sort((a, b) => b.at - a.at).filter(x => { const k = x.title.slice(0, 60).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .map(x => { const t = x.title + ' ' + x.desc, cc = GL_CC.filter(([, re]) => re.test(t)).map(([k]) => k); if (/cnnindonesia\.com\/nasional/.test(x.link) && !cc.includes('id')) cc.push('id'); x.cc = cc; return x; })
        .filter(x => x.cc.length).slice(0, 160); // hanya berita yang menyangkut AS, Tiongkok, Rusia, atau Indonesia
      for (const x of list) { const t = x.title + ' ' + x.desc, c = /gdacs/.test(x.src) ? 'bencana' : (GL_CAT.find(([, re]) => re.test(t)) || ['isu'])[0]; x.cat = c; }
      d.ccounts = Object.fromEntries(Object.keys(GL_CNAME).map(k => [k, list.filter(x => x.cc.includes(k)).length]));
      d.news = list; d.counts = Object.fromEntries(Object.keys(GL_NAME).map(k => [k, list.filter(x => x.cat === k).length]));
    }),
    job('quake', async () => { const j = await getJsonH(E.USGS_URL || 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson', 10000, { Accept: 'application/json' });
      d.quakes = ((j && j.features) || []).map(f => ({ mag: +(f.properties || {}).mag, place: String((f.properties || {}).place || ''), at: +(f.properties || {}).time, url: (f.properties || {}).url, tsu: !!(f.properties || {}).tsunami })).filter(q => q.mag > 0).sort((a, b) => b.at - a.at).slice(0, 12); }),
    job('bmkg', async () => { const j = await getJsonH(E.BMKG_URL || 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json', 10000, { Accept: 'application/json' }), g = ((j || {}).Infogempa || {}).gempa;
      if (g) d.bmkg = { mag: +g.Magnitude, place: g.Wilayah, time: (g.Tanggal || '') + ' ' + (g.Jam || ''), depth: g.Kedalaman, pot: g.Potensi, felt: g.Dirasakan || '' }; }),
  ]);
  if (!d.news && !d.quakes) throw new Error('Data global gagal: ' + (d.err.news || d.err.quake));
  return d;
}
async function mktMacro() {
  const d = { at: Date.now(), err: {} }, job = async (k, f) => { try { await f(); } catch (e) { d.err[k] = shortErr(e); } };
  await Promise.all([
    job('idx', async () => { d.markets = await yQuotes([['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow Jones'], ['^JKSE', 'IHSG'], ['^N225', 'Nikkei 225'], ['^HSI', 'Hang Seng'], ['DX-Y.NYB', 'Indeks Dolar (DXY)'], ['^TNX', 'Imbal hasil US 10 tahun'], ['^VIX', 'VIX (volatilitas)'], ['GC=F', 'Emas'], ['CL=F', 'Minyak WTI'], ['BTC-USD', 'Bitcoin'], ['IDR=X', 'USD/IDR'], ['JPYIDR=X', 'JPY/IDR'], ['CHFIDR=X', 'CHF/IDR'], ['SGDIDR=X', 'SGD/IDR']]); }),
    job('fg', async () => { const j = await getJsonH(MK.cnnfg, 10000, { ...BUA, Referer: 'https://edition.cnn.com/', Origin: 'https://edition.cnn.com' }), f = j.fear_and_greed || {}; if (f.score == null) throw new Error('data kosong'); d.cnnfg = { v: Math.round(+f.score), lb: f.rating, prev: f.previous_close != null ? Math.round(+f.previous_close) : null, w: f.previous_1_week != null ? Math.round(+f.previous_1_week) : null, m: f.previous_1_month != null ? Math.round(+f.previous_1_month) : null, y: f.previous_1_year != null ? Math.round(+f.previous_1_year) : null }; }),
    job('cal', async () => { const a = await getJsonH(MK.ffcal, 10000); if (!Array.isArray(a)) throw new Error('data kosong'); const now = Date.now(); d.cal = a.filter(x => /high|medium/i.test(x.impact || '')).map(x => ({ t: x.title, c: x.country, at: Date.parse(x.date) || null, imp: x.impact, f: x.forecast || '', p: x.previous || '', a: x.actual || '' })).sort((p, q) => (p.at || 0) - (q.at || 0)); d.calNext = d.cal.filter(x => x.at && x.at > now - 3600e3).slice(0, 14); }),
    job('news', async () => {
      const all = []; await Promise.all(MK.rss.map(async u => { try { const x = await getText(u, 9000), host = new URL(u).hostname.replace(/^www\./, '').replace(/^rss\./, ''); for (const m of x.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) { const it = m[0], g = tag => { const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(it); return r ? unx(r[1]) : ''; }; const title = g('title'), link = g('link') || (/<guid[^>]*>([^<]+)<\/guid>/.exec(it) || [])[1] || ''; if (title && /^https?:\/\//.test(link)) all.push({ title: title.slice(0, 200), link, at: Date.parse(g('pubDate') || g('dc:date')) || 0, src: /cnnindonesia/.test(host) ? 'CNN Indonesia' : /cnn/.test(host) ? 'CNN Business' : /bloombergtechnoz/.test(host) ? 'Bloomberg Technoz' : host }); } } catch (e) { d.err['rss:' + u] = shortErr(e); } }));
      if (!all.length) throw new Error('feed berita tidak bisa diambil'); const seen = new Set(); d.news = all.sort((a, b) => b.at - a.at).filter(x => { const k = x.title.slice(0, 50).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14); d.newsSrc = [...new Set(all.map(x => x.src))]; }),
  ]);
  return d;
}
// harga BTC sejak 2010 (Coin Metrics Community, gratis) untuk melengkapi riwayat Yahoo yang mulai 2014
const CMET = (E.COINMETRICS_BASE || 'https://community-api.coinmetrics.io/v4').replace(/\/$/, '');
async function cmetHistory(asset) {
  const j = await getJsonH(CMET + '/timeseries/asset-metrics?assets=' + asset + '&metrics=PriceUSD&frequency=1d&page_size=10000&start_time=2010-07-01', 20000, { Accept: 'application/json' });
  return ((j && j.data) || []).map(r => ({ t: Math.floor(Date.parse(r.time) / 1000), c: +r.PriceUSD })).filter(r => r.t > 0 && r.c > 0);
}
function weekly(pts) { // titik harian -> candle mingguan (open/high/low/close)
  const out = []; let cur = null;
  for (const p of pts) { const w = Math.floor((p.t + 3 * 86400) / 604800); if (!cur || cur.w !== w) { cur = { w, t: p.t, o: p.c, h: p.c, l: p.c, c: p.c }; out.push(cur); } else { cur.h = Math.max(cur.h, p.c); cur.l = Math.min(cur.l, p.c); cur.c = p.c; } }
  return out.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
}

async function cdcChart(sym, range) { // cadangan grafik kripto: candle publik Crypto.com (tanpa kunci)
  const [tf, n] = { '1D': ['5m', 288], '1W': ['1h', 168], '1M': ['4h', 180], '3M': ['1D', 90], '1Y': ['1D', 300], '5Y': ['7D', 260], ALL: ['7D', 300] }[range] || ['1h', 168];
  let a = null;
  for (const q of [sym + '_USDT', sym + '_USD']) { try { const j = await getJsonH(MK.cdc + '/public/get-candlestick?instrument_name=' + q + '&timeframe=' + tf + '&count=' + n, 10000); const d = (j.result || j).data || []; if (d.length) { a = d; break; } } catch (e) { } }
  if (!a) throw new Error('data grafik Crypto.com kosong');
  const pts = a.map(x => { let t = x.t != null ? +x.t : Date.parse(x.timestamp); if (t > 1e12) t = Math.floor(t / 1000); const g = (k1, k2) => +(x[k1] != null ? x[k1] : x[k2]); return { t, o: g('o', 'open'), h: g('h', 'high'), l: g('l', 'low'), c: g('c', 'close') }; }).filter(x => x.t > 0 && x.c > 0).sort((x, y) => x.t - y.t);
  if (!pts.length) throw new Error('data grafik Crypto.com kosong');
  return { cur: 'USD', pts, src: 'Crypto.com', ohlc: true, first: pts[0].t };
}
async function mktChart(src, sym, range, opt) {
  range = Y_RANGE[range] ? range : '1D'; opt = opt || {};
  if (src === 'cg' && opt.sym && /^[A-Z0-9]{1,10}$/.test(opt.sym)) { // kripto: Yahoo (OHLC, riwayat panjang); dicek terhadap harga CoinGecko, bila meleset pakai CoinGecko
    try {
      const [r, iv] = range === 'ALL' ? ['max', '1wk'] : Y_RANGE[range], { meta, pts } = await yChart(opt.sym + '-USD', r, iv), last = pts.length ? pts[pts.length - 1].c : null;
      if (!(last > 0) || (opt.px > 0 && Math.abs(last / opt.px - 1) > 0.25)) throw new Error('harga Yahoo tidak cocok');
      let out = pts;
      if (range === 'ALL' && (opt.sym === 'BTC' || opt.sym === 'ETH')) { try { const h = await cached('cmet:' + opt.sym, 12 * 3600e3, () => cmetHistory(opt.sym.toLowerCase())), first = pts.length ? pts[0].t : Infinity; out = [...weekly(h.filter(x => x.t < first - 7 * 86400)), ...pts]; } catch (e) { } }
      return { cur: 'USD', prev: meta.chartPreviousClose, pts: out, src: 'Yahoo Finance' + (out !== pts ? ' + Coin Metrics' : ''), ohlc: true, first: out.length ? out[0].t : null };
    } catch (e) { }
  }
  if (src === 'cg') { const days = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365, '5Y': 1825, ALL: 'max' }[range]; if (!/^[a-z0-9-]{1,60}$/.test(sym)) throw new Error('id koin tidak valid'); try { const j = await cg('/coins/' + sym + '/market_chart?vs_currency=usd&days=' + days); return { cur: 'USD', pts: (j.prices || []).map(([t, c]) => ({ t: Math.floor(t / 1000), c })) }; } catch (e) { if (opt.sym && /^[A-Z0-9]{1,10}$/.test(opt.sym)) return await cdcChart(opt.sym, range); throw e; } }
  if (src === 'mt5') { const tf = { '1D': 'M5', '1W': 'M30', '1M': 'H4', '3M': 'D1', '1Y': 'D1', '5Y': 'W1', ALL: 'MN1' }[range], n = { '1D': 288, '1W': 240, '1M': 186, '3M': 66, '1Y': 260, '5Y': 260, ALL: 300 }[range]; const a = await getJsonH(MK.mt5 + '/rates?symbol=' + encodeURIComponent(sym) + '&tf=' + tf + '&n=' + n, 4000, { Accept: 'application/json' }); return { cur: '', pts: (a || []).map(x => ({ t: +x.time, o: +x.open, h: +x.high, l: +x.low, c: +x.close })) }; }
  if (!/^[\^A-Za-z0-9=.\-]{1,20}$/.test(sym)) throw new Error('simbol tidak valid');
  const [r, iv] = range === 'ALL' ? ['max', '1wk'] : Y_RANGE[range], { meta, pts } = await yChart(sym, r, iv); return { cur: meta.currency || '', prev: meta.chartPreviousClose, pts, ohlc: true, first: pts.length ? pts[0].t : null };
}

// ---------- Market Intelligence (format sama dengan tim Market Intelligence Bruces Capital: Rey, Nadia, Dimas, Sinta, Bayu) ----------
// Sumber bebas kunci: CoinGecko (pasar, tren, kategori, treasury BTC), alternative.me (Fear & Greed), Binance Futures publik
// (open interest, funding, rasio long/short), Indodax (aset tren rupiah, kurs USDT/IDR), RSS berita. Arkham bila kuncinya dihubungkan.
const STABLE = new Set('usdt usdc dai fdusd usde tusd usdd pyusd usds busd usdp gusd frax lusd usd1 rlusd usdtb bsc-usd susde eurc usdx usdy usdb usd0 gho crvusd usdg'.split(' '));
const NOT_ALT_SYM = new Set('wbtc weth steth wsteth weeth cbbtc wbeth reth meth lbtc solvbtc bnsol jitosol msol ezeth rseth cbeth tbtc btcb sfrxeth wsol oseth clbtc susds'.split(' '));
const NOT_ALT = /wrapped|staked|bridged|restaked|liquid staking|binance-peg/i;
let MIC = { at: 0, d: null, p: null };
async function marketIntel(fresh) {
  if (!fresh && MIC.d && Date.now() - MIC.at < 10 * 60e3) return MIC.d; if (MIC.p) return MIC.p;
  const pr = (async () => {
    const d = { at: Date.now(), err: {} };
    const job = async (k, f) => { try { await f(); } catch (e) { d.err[k] = String((e && e.message) || e).slice(0, 160); } };
    await Promise.all([
      job('global', async () => { const g = (await cg('/global')).data || {}, mp = g.market_cap_percentage || {}; if (!(g.total_market_cap || {}).usd) throw new Error('data kosong');
        d.global = { mcap: g.total_market_cap.usd, vol: (g.total_volume || {}).usd, ch24: g.market_cap_change_percentage_24h_usd, btc: mp.btc, eth: mp.eth, usdt: mp.usdt, others: mp.btc != null && mp.eth != null ? 100 - mp.btc - mp.eth : null }; }),
      job('markets', async () => {
        const a = await cg('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h,7d,30d'); if (!Array.isArray(a) || !a.length) throw new Error('data kosong');
        const ch = (c, p) => { const v = c['price_change_percentage_' + p + '_in_currency']; return isFinite(v) ? +v : (p === '24h' && isFinite(c.price_change_percentage_24h) ? +c.price_change_percentage_24h : null); };
        d.top = a.slice(0, 10).map(c => ({ name: c.name, sym: String(c.symbol || '').toUpperCase(), usd: c.current_price, ch24: ch(c, '24h'), ch7: ch(c, '7d') }));
        const btc = a.find(c => c.id === 'bitcoin'), eth = a.find(c => c.id === 'ethereum');
        const alts = a.filter(c => c.id !== 'bitcoin' && !STABLE.has(String(c.symbol).toLowerCase()) && !NOT_ALT_SYM.has(String(c.symbol).toLowerCase()) && !NOT_ALT.test(c.name || '') && ch(c, '30d') != null).slice(0, 50);
        if (btc && ch(btc, '30d') != null && alts.length >= 20) { const b = ch(btc, '30d'), n = alts.filter(c => ch(c, '30d') > b).length; d.alt = { idx: Math.round(n / alts.length * 100), n, of: alts.length, btc30: b }; }
        if (btc && eth && btc.current_price > 0) { const e7 = ch(eth, '7d'), b7 = ch(btc, '7d'); d.ethbtc = { v: eth.current_price / btc.current_price, ch7: e7 != null && b7 != null ? ((1 + e7 / 100) / (1 + b7 / 100) - 1) * 100 : null }; }
      }),
      job('trend', async () => { const t = await cg('/search/trending'); d.trend = (t.coins || []).map(x => x.item || x).slice(0, 7).map(c => ({ name: c.name, sym: String(c.symbol || '').toUpperCase(), rank: c.market_cap_rank || null, ch24: c.data && c.data.price_change_percentage_24h ? +c.data.price_change_percentage_24h.usd : null })); if (!d.trend.length) throw new Error('data kosong'); }),
      job('cats', async () => { const a = await cg('/coins/categories?order=market_cap_desc'); if (!Array.isArray(a) || !a.length) throw new Error('data kosong');
        const st = a.find(c => c.id === 'stablecoins'); if (st) d.stable = { mcap: +st.market_cap, ch24: +st.market_cap_change_24h };
        const ok = a.filter(c => +c.market_cap > 3e8 && isFinite(+c.market_cap_change_24h) && c.id !== 'stablecoins' && !/stablecoin|wrapped|bridged/i.test(c.name || '')).sort((x, y) => y.market_cap_change_24h - x.market_cap_change_24h), mp = c => ({ name: c.name, ch24: +c.market_cap_change_24h, mcap: +c.market_cap, vol: +c.volume_24h || null, top: (c.top_3_coins_id || []).slice(0, 3) });
        d.cats = ok.slice(0, 8).map(mp); d.catsDown = ok.filter(c => c.market_cap_change_24h < 0).slice(-4).reverse().map(mp); d.catsN = ok.length; d.catsSrc = a._src || 'CoinGecko'; }),
      job('treasury', async () => { const t = await cg('/companies/public_treasury/bitcoin'); if (!t || !Array.isArray(t.companies)) throw new Error('data kosong');
        d.treasury = { total: +t.total_holdings, usd: +t.total_value_usd, pct: +t.market_cap_dominance, top: t.companies.slice(0, 5).map(c => ({ name: c.name, sym: c.symbol, btc: +c.total_holdings, usd: +c.total_current_value_usd, pct: +c.percentage_of_total_supply })), stale: t._stale || null }; }),
      job('chain', async () => { // on-chain BTC tanpa kunci: transfer besar di antrean (blockchain.com), biaya & antrean (mempool.space), hashrate
        const MP = (E.MEMPOOL_BASE || 'https://mempool.space/api').replace(/\/$/, ''), BC = (E.BLOCKCHAIN_BASE || 'https://blockchain.info').replace(/\/$/, ''), H = { Accept: 'application/json' };
        const [fee, mp, hr, ut] = await Promise.all([getJsonH(MP + '/v1/fees/recommended', 9000, H).catch(() => null), getJsonH(MP + '/mempool', 9000, H).catch(() => null), getJsonH(MP + '/v1/mining/hashrate/3d', 9000, H).catch(() => null), getJsonH(BC + '/unconfirmed-transactions?format=json', 12000, H).catch(() => null)]);
        const c = {}, txs = ut && Array.isArray(ut.txs) ? ut.txs : [];
        if (fee && fee.fastestFee) c.fee = { fast: +fee.fastestFee, half: +fee.halfHourFee, hour: +fee.hourFee };
        if (mp && mp.count) c.mempool = { n: +mp.count, vmb: +mp.vsize / 1e6 };
        if (hr && hr.currentHashrate) c.hash = { ehs: +hr.currentHashrate / 1e18 };
        if (txs.length) { c.scanned = txs.length; c.big = txs.map(t => ({ id: String(t.hash || ''), btc: (t.out || []).reduce((a, o) => a + (+o.value || 0), 0) / 1e8, at: (+t.time || 0) * 1000, nout: (t.out || []).length })).filter(t => t.btc >= 50 && /^[0-9a-f]{64}$/.test(t.id)).sort((a, b) => b.btc - a.btc).slice(0, 6); }
        if (!c.fee && !c.mempool && !c.hash && !txs.length) throw new Error('mempool.space dan blockchain.com tidak bisa dijangkau');
        d.chain = c;
      }),
      job('fng', async () => { const j = await getJson(XB.fng + '?limit=31', 9000), a = j.data || []; if (!a.length) throw new Error('data kosong'); const v = i => a[i] ? { v: +a[i].value, lb: a[i].value_classification } : null; d.fng = { now: v(0), y: v(1), w: v(7), m: v(30) }; }),
      job('deriv', async () => { // per bursa: Binance → Bybit → OKX (bila satu diblokir/tidak merespons, coba berikutnya)
        const v = await venueDeriv(); d.deriv = v.rows; d.derivVenue = v.venue; if (v.skipped.length) d.derivSkip = v.skipped;
      }),
      job('derivAgg', async () => { d.derivAgg = await derivAggregate(); }),
      job('news', async () => { const it = await newsItems(); if (!it.length) throw new Error('feed berita tidak bisa diambil'); const seen = new Set(); d.news = it.filter(x => { const k = x.title.slice(0, 50).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6).map(({ title, link, at, src }) => ({ title, link, at, src })); }),
      job('idx', async () => {
        const sm = await summaries(), tk = (sm || {}).tickers || {}, p24 = (sm || {}).prices_24h || {};
        const rows = Object.entries(tk).filter(([k]) => /_idr$/.test(k) && k !== 'usdt_idr').map(([k, t]) => { const last = +t.last, ref = +p24[k.replace('_', '')]; return { sym: k.split('_')[0].toUpperCase(), name: t.name || '', last, vol: +t.vol_idr || 0, ch24: ref > 0 ? (last / ref - 1) * 100 : null }; }).filter(x => x.last > 0 && x.vol > 0);
        if (!rows.length) throw new Error('data Indodax kosong');
        const u = tk.usdt_idr, ur = +p24.usdtidr;
        d.idx = { vol: rows.slice().sort((a, b) => b.vol - a.vol).slice(0, 5), up: rows.filter(x => x.ch24 != null && x.ch24 > 0 && x.vol >= 5e8).sort((a, b) => b.ch24 - a.ch24).slice(0, 5), usdIdr: u ? +u.last : M.usdIdr || null, usdIdrCh: u && ur > 0 ? (+u.last / ur - 1) * 100 : null };
      }),
      job('whale', async () => { if (!linkOn('arkham')) { d.whaleOff = true; return; } d.whale = await arkhamWhales(); }),
      job('liq', async () => { if (!linkOn('coinglass')) return; // likuidasi 24 jam (CoinGlass)
        const g = async sym => { const j = await xFetch(XB.cgl + '/api/futures/liquidation/exchange-list?range=24h&symbol=' + sym, { headers: { 'CG-API-KEY': LINKS.coinglass.key } }, 12000); if (String(j.code) !== '0') throw new Error(j.msg || 'kode ' + j.code); const a = Array.isArray(j.data) ? j.data : []; const all = a.find(x => /^all$/i.test(x.exchange)) || null; return all ? { total: +all.liquidation_usd, long: +all.long_liquidation_usd, short: +all.short_liquidation_usd, top: a.filter(x => !/^all$/i.test(x.exchange)).sort((p, q) => q.liquidation_usd - p.liquidation_usd).slice(0, 3).map(x => ({ ex: x.exchange, usd: +x.liquidation_usd })) } : null; };
        const [all, btc] = await Promise.all([g(''), g('BTC')]); d.liq = { all, btc }; }),
      job('gn', async () => { if (!linkOn('glassnode')) return; // data on-chain (Glassnode)
        const s0 = Math.floor(Date.now() / 1000 - 4 * 86400), k = '&api_key=' + encodeURIComponent(LINKS.glassnode.key), m = async path => { const a = await xFetch(XB.gn + path + '?a=BTC&i=24h&s=' + s0 + k, {}, 12000); return Array.isArray(a) && a.length ? a : null; };
        const [act, nf] = await Promise.all([m('/v1/metrics/addresses/active_count'), m('/v1/metrics/transactions/transfers_volume_exchanges_net').catch(() => null)]);
        const last = a => a ? +a[a.length - 1].v : null, prev = a => a && a.length > 1 ? +a[a.length - 2].v : null;
        d.gn = { active: last(act), activeCh: act && prev(act) > 0 ? (last(act) / prev(act) - 1) * 100 : null, netflow: last(nf) }; }),
    ]);
    // gambaran besar: aturan sederhana dari angka di atas (bukan prediksi)
    let sc = 0; const why = [];
    if (d.global && isFinite(d.global.ch24)) { if (d.global.ch24 >= 1) { sc++; why.push('market cap naik'); } else if (d.global.ch24 <= -1) { sc--; why.push('market cap turun'); } }
    if (d.fng && d.fng.now) { if (d.fng.now.v >= 55) { sc++; why.push('sentimen serakah'); } else if (d.fng.now.v <= 45) { sc--; why.push('sentimen takut'); } }
    if (d.stable && isFinite(d.stable.ch24)) { if (d.stable.ch24 >= 0.2) { sc++; why.push('pasokan stablecoin bertambah'); } else if (d.stable.ch24 <= -0.2) { sc--; why.push('pasokan stablecoin berkurang'); } }
    if (d.deriv && d.deriv[0] && isFinite(d.deriv[0].oich)) { if (d.deriv[0].oich >= 3) why.push('open interest BTC naik ' + d.deriv[0].oich.toFixed(1).replace('.', ',') + '%'); }
    d.regime = { score: sc, label: sc >= 1 ? 'Bullish' : sc <= -1 ? 'Bearish' : 'Sideways', why };
    try { d.concl = miConclusion(d, sc); } catch (e) { }
    if (!d.global && !d.top && !d.fng && !d.news && !d.idx) throw new Error('Laporan gagal: ' + (d.err.global || d.err.markets || d.err.idx || 'sumber data tidak bisa dijangkau'));
    MIC = { at: Date.now(), d, p: null }; return d;
  })();
  MIC.p = pr; pr.catch(() => { }).finally(() => { if (MIC.p === pr) MIC.p = null; });
  return pr;
}

// ---------- Market Intelligence SAHAM (IHSG): pasar, saham teraktif & asing, sektor, global & makro, berita ----------
// Tim yang sama: Rey (IHSG & pasar), Nadia (teraktif & asing), Dimas (penggerak & sektor), Sinta (berita), Bayu (global & makro).
const SAHAM_RSS = (E.SAHAM_RSS || 'https://www.cnbcindonesia.com/market/rss,https://www.cnnindonesia.com/ekonomi/rss,https://www.bloombergtechnoz.com/rss,https://www.antaranews.com/rss/ekonomi.xml,https://www.idxchannel.com/rss').split(',').map(x => x.trim()).filter(Boolean);
const SAHAM_RE = /\b(IHSG|saham|emiten|bursa|BEI|IDX|LQ45|IDX30|dividen|IPO|right issue|rights issue|buyback|asing|net (buy|sell)|BI[- ]?Rate|suku bunga|rupiah|Wall Street|Nasdaq|S&P|Dow Jones|Nikkei|Hang Seng|indeks|obligasi|SBN|investor|pasar modal|OJK|BBCA|BBRI|BMRI|BBNI|TLKM|ASII|GOTO|BREN|AMMN|ADRO|ANTM|UNVR|ICBP)\b/i;
const IDX_SECT = { IDXENERGY: 'Energi', IDXBASIC: 'Barang Baku', IDXINDUST: 'Perindustrian', IDXNONCYC: 'Konsumen Primer', IDXCYCLIC: 'Konsumen Non-Primer', IDXHEALTH: 'Kesehatan', IDXFINANCE: 'Keuangan', IDXPROPERT: 'Properti & Real Estat', IDXTECHNO: 'Teknologi', IDXINFRA: 'Infrastruktur', IDXTRANS: 'Transportasi & Logistik' };
let MIS = { at: 0, d: null, p: null };
async function marketIntelSaham(fresh) {
  if (!fresh && MIS.d && Date.now() - MIS.at < 10 * 60e3) return MIS.d; if (MIS.p) return MIS.p;
  const pr = (async () => {
    const d = { at: Date.now(), kind: 'saham', err: {} }, job = async (k, f) => { try { await f(); } catch (e) { d.err[k] = String((e && e.message) || e).slice(0, 160); } };
    await Promise.all([
      job('pasar', async () => {
        const m = await cached('pg:saham', 120e3, mktSaham);
        if (m.ihsg && !m.ihsg.err && m.ihsg.last > 0) d.ihsg = { last: m.ihsg.last, prev: m.ihsg.prev, ch: m.ihsg.ch, hi: m.ihsg.hi, lo: m.ihsg.lo };
        d.index = m.index || null; d.market = m.market || null; d.date = m.date || null; d.src = m.src || ''; d.capEst = m.capEst || null;
        const cut = (a, n) => (a || []).slice(0, n); d.gainers = cut(m.gainers, 6); d.losers = cut(m.losers, 6); d.active = cut(m.active, 8); d.foreignBuy = cut(m.foreignBuy, 5); d.foreignSell = cut(m.foreignSell, 5);
        for (const [k, v] of Object.entries(m.err || {})) d.err['pasar_' + k] = v;
        if (!d.ihsg && !d.active) throw new Error(m.err && (m.err.ihsg || m.err.idx) || 'data saham tidak tersedia');
      }),
      job('sektor', async () => {
        const r = await cached('idx:IndexSummary', 300e3, () => idxDay('IndexSummary'));
        d.sectors = r.data.map(x => ({ code: String(x.IndexCode || '').toUpperCase(), close: +x.Close, prev: +x.Previous })).filter(x => IDX_SECT[x.code] && x.prev > 0).map(x => ({ name: IDX_SECT[x.code], code: x.code, close: x.close, ch: (x.close / x.prev - 1) * 100 })).sort((a, b) => b.ch - a.ch);
        if (!d.sectors.length) throw new Error('indeks sektor belum tersedia');
      }),
      job('global', async () => {
        const q = await yQuotes([['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow Jones'], ['^N225', 'Nikkei 225'], ['^HSI', 'Hang Seng'], ['^STI', 'STI Singapura'], ['^KS11', 'KOSPI']]);
        d.global = q.filter(x => !x.err && x.last > 0).map(x => ({ name: x.name, last: x.last, ch: x.ch })); if (!d.global.length) throw new Error('indeks global tidak bisa diambil');
      }),
      job('makro', async () => {
        const q = await yQuotes([['IDR=X', 'USD/IDR'], ['DX-Y.NYB', 'Indeks Dolar (DXY)'], ['^TNX', 'Imbal hasil US 10 tahun'], ['^VIX', 'VIX (volatilitas)'], ['GC=F', 'Emas'], ['CL=F', 'Minyak WTI']]);
        d.macro = q.filter(x => !x.err && x.last > 0).map(x => ({ name: x.name, sym: x.sym, last: x.last, ch: x.ch })); if (!d.macro.length) throw new Error('data makro tidak bisa diambil');
      }),
      job('news', async () => { const it = await rssPull(SAHAM_RSS, SAHAM_RE, 10); if (!it.length) throw new Error('feed berita pasar modal tidak bisa diambil'); d.news = it.slice(0, 8).map(({ title, link, at, src }) => ({ title, link, at, src })); }),
    ]);
    try { d.concl = sahamConclusion(d); } catch (e) { }
    if (!d.ihsg && !d.active && !d.global) throw new Error('Laporan saham gagal: ' + (d.err.pasar || d.err.global || 'sumber data tidak bisa dijangkau'));
    MIS = { at: Date.now(), d, p: null }; return d;
  })();
  MIS.p = pr; pr.catch(() => { }).finally(() => { if (MIS.p === pr) MIS.p = null; });
  return pr;
}
function sahamConclusion(d) {
  const P = v => (v >= 0 ? '+' : '') + v.toFixed(2).replace('.', ',') + '%', N = v => (+v).toLocaleString('id-ID', { maximumFractionDigits: 2 }), Rp = v => { v = Math.abs(v); return 'Rp ' + (v >= 1e12 ? (v / 1e12).toFixed(2).replace('.', ',') + ' T' : v >= 1e9 ? (v / 1e9).toFixed(1).replace('.', ',') + ' M' : Math.round(v / 1e6) + ' jt'); };
  const pts = [], watch = []; let sc = 0;
  if (d.ihsg && isFinite(d.ihsg.ch)) { const c = d.ihsg.ch, s = c >= 0.5 ? 1 : c <= -0.5 ? -1 : 0; sc += s; pts.push({ k: 'IHSG', ic: s > 0 ? '📈' : s < 0 ? '📉' : '➖', t: 'IHSG ' + N(d.ihsg.last) + ' (' + P(c) + ')' + (d.index && d.index.val > 0 ? ', nilai transaksi ' + Rp(d.index.val) : ''), s }); if (Math.abs(c) >= 2) watch.push('IHSG bergerak ' + P(c) + ' dalam sehari: volatilitas tinggi'); }
  const m = d.market; if (m && m.up + m.down > 0) { const r = m.up / (m.up + m.down), s = r >= 0.55 ? 1 : r <= 0.45 ? -1 : 0; sc += s * 0.5; pts.push({ k: 'Breadth', ic: '📊', t: m.up + ' saham naik, ' + m.down + ' turun, ' + m.flat + ' tetap' + (m.est ? ' (perkiraan dari saham utama)' : ''), s }); }
  if (m && (m.fbuy > 0 || m.fsell > 0) && isFinite(m.fnet)) { const s = m.fnet > 0 ? 1 : m.fnet < 0 ? -1 : 0; sc += s; pts.push({ k: 'Asing', ic: '🌏', t: 'Investor asing net ' + (m.fnet >= 0 ? 'beli ' : 'jual ') + Rp(m.fnet) + (d.foreignBuy && d.foreignBuy[0] ? '; beli terbesar ' + d.foreignBuy[0].code : '') + (d.foreignSell && d.foreignSell[0] ? ', jual terbesar ' + d.foreignSell[0].code : ''), s }); if (Math.abs(m.fnet) >= 1e12) watch.push('arus dana asing besar (' + (m.fnet > 0 ? 'masuk ' : 'keluar ') + Rp(m.fnet) + ')'); }
  if (d.sectors && d.sectors.length) { const a = d.sectors, up = a.filter(x => x.ch > 0).length; pts.push({ k: 'Sektor', ic: '🧩', t: up + ' dari ' + a.length + ' sektor naik; terkuat ' + a[0].name + ' ' + P(a[0].ch) + ', terlemah ' + a[a.length - 1].name + ' ' + P(a[a.length - 1].ch), s: 0 }); }
  if (d.global && d.global.length) { const a = d.global.filter(x => isFinite(x.ch)), avg = a.reduce((t, x) => t + x.ch, 0) / (a.length || 1), s = avg >= 0.5 ? 1 : avg <= -0.5 ? -1 : 0; sc += s * 0.5; pts.push({ k: 'Global', ic: '🌐', t: 'Rata-rata indeks utama dunia ' + P(avg) + ' (' + a.slice(0, 4).map(x => x.name + ' ' + P(x.ch)).join(', ') + ')', s }); }
  const fx = (d.macro || []).find(x => x.sym === 'IDR=X'), vix = (d.macro || []).find(x => x.sym === '^VIX');
  if (fx && isFinite(fx.ch)) { const s = fx.ch <= -0.3 ? 1 : fx.ch >= 0.3 ? -1 : 0; sc += s * 0.5; pts.push({ k: 'Rupiah', ic: '💱', t: 'USD/IDR ' + Math.round(fx.last).toLocaleString('id-ID') + ' (' + P(fx.ch) + ', rupiah ' + (fx.ch < 0 ? 'menguat' : fx.ch > 0 ? 'melemah' : 'stabil') + ')', s }); }
  if (vix && vix.last >= 25) watch.push('VIX ' + N(vix.last) + ': kecemasan pasar global tinggi');
  if (d.gainers && d.gainers[0]) pts.push({ k: 'Penggerak', ic: '🚀', t: 'Naik tertinggi ' + d.gainers.slice(0, 3).map(x => x.code + ' ' + P(x.pct || 0)).join(', ') + (d.losers && d.losers[0] ? '; turun terdalam ' + d.losers.slice(0, 2).map(x => x.code + ' ' + P(x.pct || 0)).join(', ') : ''), s: 0 });
  if (d.news && d.news.length) pts.push({ k: 'Berita', ic: '📰', t: d.news.length + ' judul pasar modal; teratas: "' + String(d.news[0].title).slice(0, 90) + '"', s: 0 });
  const score = Math.round(sc * 10) / 10, label = score > 0.5 ? 'Bullish' : score < -0.5 ? 'Bearish' : 'Sideways';
  const pos = pts.filter(p => p.s > 0).map(p => p.k.toLowerCase()), neg = pts.filter(p => p.s < 0).map(p => p.k.toLowerCase());
  const text = (score > 0.5 ? 'Data pasar saham cenderung mendukung kenaikan' : score < -0.5 ? 'Data pasar saham cenderung menekan IHSG' : 'Data pasar saham cenderung netral, IHSG bergerak mendatar') + (pos.length ? '; positif dari ' + pos.join(', ') : '') + (neg.length ? '; negatif dari ' + neg.join(', ') : '') + '.'
    + (score < -0.5 ? ' Pertimbangkan ukuran posisi lebih kecil dan disiplin batas rugi.' : score > 0.5 ? ' Tetap pasang batas rugi: arah bisa berbalik cepat.' : ' Tunggu konfirmasi arah sebelum menambah posisi besar.');
  return { score, label, text, pts, watch: watch.slice(0, 4) };
}

// Kesimpulan Utama: merangkum seluruh bagian laporan (pasar, sentimen, derivatif, whale, aset besar, narasi, tren, makro, berita)
// menjadi satu penilaian + poin per divisi. Aturan sederhana dari angka laporan, bukan prediksi.
function miConclusion(d, sc0) {
  const P = v => (v >= 0 ? '+' : '') + v.toFixed(Math.abs(v) < 1 ? 2 : 1).replace('.', ',') + '%', U = v => v >= 1e12 ? '$' + (v / 1e12).toFixed(2).replace('.', ',') + ' T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(1).replace('.', ',') + ' M' : '$' + Math.round(v / 1e6) + ' jt';
  const pts = [], watch = []; let sc = 0;
  const g = d.global;
  if (g && isFinite(g.ch24)) { const s = g.ch24 >= 1 ? 1 : g.ch24 <= -1 ? -1 : 0; sc += s; pts.push({ k: 'Pasar', ic: s > 0 ? '📈' : s < 0 ? '📉' : '➖', t: 'Market cap ' + U(g.mcap) + ' (' + P(g.ch24) + ' 24 jam)' + (isFinite(g.btc) ? ', dominasi BTC ' + g.btc.toFixed(1).replace('.', ',') + '%' : '') + (d.alt ? ', Altcoin Season ' + d.alt.idx + '/100' : ''), s }); }
  if (d.fng && d.fng.now) { const v = d.fng.now.v, s = v >= 55 ? 1 : v <= 45 ? -1 : 0, w = d.fng.w ? d.fng.w.v : null; sc += s; pts.push({ k: 'Sentimen', ic: v <= 25 ? '😨' : v <= 45 ? '😟' : v >= 75 ? '🤑' : v >= 55 ? '🙂' : '😐', t: 'Fear & Greed ' + v + ' (' + d.fng.now.lb + ')' + (w != null ? ', minggu lalu ' + w : ''), s });
    if (v <= 25) watch.push('sentimen sangat takut: rawan pantulan tajam maupun lanjutan turun'); if (v >= 75) watch.push('sentimen sangat serakah: rawan koreksi'); }
  const dv = (d.deriv || [])[0], ag = (d.derivAgg || []).find(x => x.sym === 'BTC');
  if (dv || ag) { const f = dv && isFinite(dv.fund) ? dv.fund : ag && isFinite(ag.fund) ? ag.fund : null, oc = dv && isFinite(dv.oich) ? dv.oich : null, lr = dv && dv.long != null ? dv.long : null; let s = 0;
    if (f != null && f < 0) s = 1; if (f != null && f > 0.03) s = -1; if (lr != null && lr >= 65) { s = -1; watch.push('mayoritas akun posisi long (' + lr.toFixed(0) + '%): risiko long squeeze'); } if (lr != null && lr <= 40) watch.push('mayoritas akun short: rawan short squeeze');
    if (oc != null && oc >= 5) watch.push('open interest BTC naik ' + P(oc) + ': leverage menumpuk, volatilitas bisa membesar');
    sc += s * 0.5; pts.push({ k: 'Derivatif', ic: '⚖️', t: 'BTC' + (oc != null ? ' OI ' + P(oc) : '') + (f != null ? ', funding ' + (f >= 0 ? '+' : '') + f.toFixed(4).replace('.', ',') + '%' : '') + (lr != null ? ', akun long ' + lr.toFixed(0) + '%' : '') + (d.liq && d.liq.all ? ', likuidasi 24j ' + U(d.liq.all.total) : ''), s }); }
  if (d.whale && d.whale.rows && d.whale.rows.length) { const tot = d.whale.rows.reduce((a, r) => a + (r.usd || 0), 0); pts.push({ k: 'Whale', ic: '🐋', t: d.whale.rows.length + ' transfer besar 24 jam, total ' + U(tot), s: 0 }); }
  else if (d.chain && d.chain.big && d.chain.big.length) pts.push({ k: 'Whale', ic: '🐋', t: d.chain.big.length + ' transfer BTC ≥ 50 BTC menunggu konfirmasi, terbesar ' + Math.round(d.chain.big[0].btc).toLocaleString('id-ID') + ' BTC' + (d.treasury ? '; perusahaan publik memegang ' + Math.round(d.treasury.total).toLocaleString('id-ID') + ' BTC' : ''), s: 0 });
  else if (d.treasury) pts.push({ k: 'Whale', ic: '🏦', t: 'Perusahaan publik memegang ' + Math.round(d.treasury.total).toLocaleString('id-ID') + ' BTC (' + (d.treasury.pct || 0).toFixed(2).replace('.', ',') + '% supply)', s: 0 });
  if (d.gn && isFinite(d.gn.netflow)) { const s = d.gn.netflow < 0 ? 1 : d.gn.netflow > 0 ? -1 : 0; sc += s * 0.5; pts.push({ k: 'On-chain', ic: '⛓️', t: 'Arus bersih BTC ke exchange ' + (d.gn.netflow >= 0 ? '+' : '') + Math.round(d.gn.netflow).toLocaleString('id-ID') + ' BTC (' + (s > 0 ? 'keluar dari exchange, cenderung akumulasi' : 'masuk ke exchange, potensi jual') + ')', s }); }
  if (d.top && d.top.length) { const up = d.top.filter(c => c.ch24 > 0).length, b = d.top.slice().sort((x, y) => (y.ch24 || 0) - (x.ch24 || 0)); const s = up >= 7 ? 1 : up <= 3 ? -1 : 0; sc += s * 0.5; pts.push({ k: '10 aset besar', ic: '🏆', t: up + ' dari ' + d.top.length + ' naik; terkuat ' + b[0].sym + ' ' + P(b[0].ch24 || 0) + ', terlemah ' + b[b.length - 1].sym + ' ' + P(b[b.length - 1].ch24 || 0), s }); }
  if (d.cats && d.cats.length) pts.push({ k: 'Narasi', ic: '🧩', t: 'Sektor terkuat ' + d.cats[0].name + ' ' + P(d.cats[0].ch24) + (d.catsDown && d.catsDown[0] ? ', terlemah ' + d.catsDown[0].name + ' ' + P(d.catsDown[0].ch24) : ''), s: 0 });
  if (d.trend && d.trend.length) pts.push({ k: 'Tren', ic: '🔥', t: 'Paling dicari: ' + d.trend.slice(0, 3).map(x => x.sym).join(', ') + (d.idx && d.idx.vol && d.idx.vol[0] ? '; volume terbesar Indodax: ' + d.idx.vol[0].sym : ''), s: 0 });
  if (d.stable && isFinite(d.stable.ch24)) { const s = d.stable.ch24 >= 0.2 ? 1 : d.stable.ch24 <= -0.2 ? -1 : 0; sc += s; pts.push({ k: 'Likuiditas', ic: '💧', t: 'Pasokan stablecoin ' + U(d.stable.mcap) + ' (' + P(d.stable.ch24) + ')' + (d.ethbtc && d.ethbtc.ch7 != null ? ', ETH/BTC 7 hari ' + P(d.ethbtc.ch7) : '') + (d.idx && d.idx.usdIdr ? ', USDT/IDR ' + Math.round(d.idx.usdIdr).toLocaleString('id-ID') : ''), s }); }
  if (d.news && d.news.length) pts.push({ k: 'Berita', ic: '📰', t: d.news.length + ' judul hari ini; teratas: "' + String(d.news[0].title).slice(0, 90) + '"', s: 0 });
  const score = Math.round(sc * 10) / 10, label = score > 0.5 ? 'Bullish' : score < -0.5 ? 'Bearish' : 'Sideways'; // cenderung baik / buruk / netral
  const pos = pts.filter(p => p.s > 0).map(p => p.k.toLowerCase()), neg = pts.filter(p => p.s < 0).map(p => p.k.toLowerCase());
  const text = (score >= 2 ? 'Mayoritas data mendukung kenaikan' : score > 0.5 ? 'Data cenderung mendukung kenaikan' : score <= -2 ? 'Mayoritas data menekan pasar' : score < -0.5 ? 'Data cenderung menekan pasar' : 'Data cenderung netral, pasar bergerak mendatar') + (pos.length ? '; positif dari ' + pos.join(', ') : '') + (neg.length ? '; negatif dari ' + neg.join(', ') : '') + '.'
    + (score < -0.5 ? ' Pertimbangkan ukuran posisi lebih kecil dan stop loss lebih disiplin.' : score > 0.5 ? ' Tetap pakai stop loss: kondisi bisa berbalik cepat.' : ' Tunggu konfirmasi arah sebelum menambah posisi besar.');
  return { score, label, text, pts, watch: watch.slice(0, 4) };
}

// ---------- SSE ke tampilan ----------
const clients = new Set();
function broadcast(o) { const s = 'data: ' + JSON.stringify(o) + '\n\n'; for (const c of clients) { try { c.write(s); } catch (e) { } } }
function toast(msg, kind) { log(msg); broadcast({ t: 'toast', msg, kind: kind || 'info' }); }
function view() {
  rollDay();
  return { license: LIC.status(), buyUrl: E.LICENSE_BUY_URL || '', live: LIVE, wantLive: CFG.live, hasKey: !!(CFG.key && CFG.secret), settings: S.settings, pair: P(), price: M.price, ch24: M.ch24, wsOk: M.wsOk, src: M.src,
    paper: LIVE ? null : S.paper, liveBal: LIVE ? L : null, positions: S.positions, orders: S.orders, history: S.history.slice(0, 50), totalPnl: S.totalPnl, dayPnl: S.dayPnl,
    limits: { maxOrder: null, dailyLoss: CFG.dailyLoss }, usdIdr: M.usdIdr || null, fut: { maxLev: FUT_MAX_LEV, fee: FUT_FEE, mmr: FUT_MMR }, signal: lastSignal, sigWhy: BOT.why, botTf: BOT.tf, botReady: BOT.candles.length > 0, strategies: STRATS, alerts: ALERTS, tfs: Object.keys(TF_SEC), provider: 'indodax', chartSrc: CH_SRC.includes(S.settings.chartSrc) ? S.settings.chartSrc : 'auto', chartUsed: M.chSrc || null, apiVer: LIVE ? API_VER : null, links: linkView(), xtrades: (S.xtrades || []).slice(0, 30) };
}
function pushState() { broadcast({ t: 'state', s: view() }); }

// ---------- ganti mode simulasi <-> live saat server berjalan ----------
function flushState() { clearTimeout(saveT); try { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S, null, 1)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch (e) { log('Gagal simpan state:', e.message); } }
function setMode(live, key, secret) {
  flushState();
  const keep = { ...S.settings, botActive: false };
  LIVE = live; CFG.key = live ? key : ''; CFG.secret = live ? secret : ''; API_VER = null; verP = null;
  STATE_FILE = path.join(CFG.dataDir, LIVE ? 'state-live.json' : 'state-paper.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { }
  Object.assign(S, { paper: { idr: CFG.paperIdr, deposited: CFG.paperIdr }, positions: [], orders: [], history: [], totalPnl: 0, dayKey: '', dayPnl: 0 }, st);
  S.orders = Array.isArray(S.orders) ? S.orders : []; S.orders.forEach(o => { o.cancelling = false; }); S.positions.forEach(p => { p.closing = false; });
  S.settings = { ...S.settings, ...keep, botActive: false };
  L.idr = null; L.hold = null; L.coins = {}; L.err = '';
  flushState(); pushState();
}
function rememberEnv(key, secret) {
  const f = path.join(__dirname, '.env'); let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { }
  const set = (k, v) => { const re = new RegExp('^' + k + '=.*$', 'm'); t = re.test(t) ? t.replace(re, k + '=' + v) : t + (t && !t.endsWith('\n') ? '\n' : '') + k + '=' + v + '\n'; };
  set('INDODAX_API_KEY', key); set('INDODAX_SECRET_KEY', secret); set('LIVE_TRADING', 'true');
  try { fs.writeFileSync(f, t); } catch (e) { log('Gagal menulis .env:', e.message); }
}

// ---------- HTTP server ----------
const PUB = path.join(__dirname, 'public');
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((ok, no) => { let b = ''; req.on('data', d => { b += d; if (b.length > 2e6) { no(new Error('terlalu besar')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(new Error('JSON tidak valid')); } }); }); }
const OK_HOSTS = String(E.ALLOWED_HOSTS || E.RENDER_EXTERNAL_HOSTNAME || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const okHost = h => { const x = String(h || '').toLowerCase(); return new RegExp('^(localhost|127\\.0\\.0\\.1|\\[::1\\]):' + CFG.port + '$').test(x) || OK_HOSTS.includes(x.split(':')[0]); };
// ---------- Login (akun lokal) ----------
// Akun disimpan di data/auth.json (kata sandi di-hash scrypt + salt). Tanpa akun, aplikasi terbuka seperti biasa.
// Lupa kata sandi: tutup server, hapus data/auth.json, jalankan lagi.
const AUTH_FILE = path.join(CFG.dataDir, 'auth.json');
let AUTH = null; try { const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); if (a && a.user && a.salt && a.hash) AUTH = a; } catch (e) { }
const SESS = new Map(), LOGIN_TRY = [];
const pwHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function saveAuth() { if (AUTH && AUTH.env) return; try { if (AUTH) { fs.writeFileSync(AUTH_FILE + '.tmp', JSON.stringify(AUTH)); fs.renameSync(AUTH_FILE + '.tmp', AUTH_FILE); } else fs.rmSync(AUTH_FILE, { force: true }); } catch (e) { log('Gagal simpan akun:', e.message); } }
function cookieOf(req, k) { const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]+)').exec(req.headers.cookie || ''); return m ? decodeURIComponent(m[1]) : null; }
function sessOf(req) { const t = cookieOf(req, 'tb_sess'), s = t && SESS.get(t); if (!s) return null; if (s.exp < Date.now()) { SESS.delete(t); return null; } return s; }
function newSess(res, user) { const t = crypto.randomBytes(24).toString('hex'); SESS.set(t, { user, exp: Date.now() + 30 * 86400e3 }); res.setHeader('Set-Cookie', 'tb_sess=' + t + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + 30 * 86400); }
if (E.LOGIN_USER && E.LOGIN_PASSWORD) { const _s = crypto.randomBytes(16).toString('hex'); AUTH = { user: String(E.LOGIN_USER), salt: _s, hash: pwHash(E.LOGIN_PASSWORD, _s), created: Date.now(), env: true }; } // akun tetap dari .env (opsional)
const ACCTS = new Map(); // akun dari env: nama -> {salt, hash}
{ const add = (u, p) => { u = String(u || '').trim(); p = String(p || '').trim(); if (!u || !p) return; const sl = crypto.randomBytes(16).toString('hex'); ACCTS.set(u, { salt: sl, hash: pwHash(p, sl) }); };
  String(E.LOGIN_USERS || '').split(',').forEach(x => { const i = x.indexOf(':'); if (i > 0) add(x.slice(0, i), x.slice(i + 1)); });
  if (E.LOGIN_USER && E.LOGIN_PASSWORD) add(E.LOGIN_USER, E.LOGIN_PASSWORD);
  if (ACCTS.size) AUTH = { user: [...ACCTS.keys()][0], salt: '', hash: '', created: Date.now(), env: true }; }
const userOk = u => /^[A-Za-z0-9._-]{3,32}$/.test(String(u || ''));
function checkPw(user, pw) { if (ACCTS.size) { const a = ACCTS.get(String(user || '').trim()); if (!a) return false; return crypto.timingSafeEqual(Buffer.from(pwHash(pw, a.salt), 'hex'), Buffer.from(a.hash, 'hex')); } if (!AUTH) return false; const h = pwHash(pw, AUTH.salt); return user === AUTH.user && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(AUTH.hash, 'hex')); }
// ---------- Profil klien per akun (nama tampilan, status, warna avatar, foto) ----------
// Disimpan di data/profiles.json dan juga di browser klien; bila disk server terhapus (hosting gratis), browser mengirim ulang.
const PROF_FILE = path.join(CFG.dataDir, 'profiles.json'), PROF_COLORS = ['violet', 'ocean', 'emerald', 'sunset', 'rose', 'gold'];
let PROFS = {}; try { const j = JSON.parse(fs.readFileSync(PROF_FILE, 'utf8')); if (j && typeof j === 'object') PROFS = j; } catch (e) { }
function saveProfs() { try { fs.writeFileSync(PROF_FILE + '.tmp', JSON.stringify(PROFS)); fs.renameSync(PROF_FILE + '.tmp', PROF_FILE); } catch (e) { } }
function profClean(b) {
  const tx = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n), im = String(b.img || '');
  if (im && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(im) || im.length > 150000)) throw new Error('Foto tidak valid atau terlalu besar');
  return { name: tx(b.name, 24), tag: tx(b.tag, 40), color: PROF_COLORS.includes(b.color) ? b.color : 'violet', img: im, at: Math.min(Date.now(), +b.at || Date.now()) };
}
// file statis yang boleh dibuka tanpa login (layar login, aplikasi terpasang/PWA)
const STATIC = { '/ind.js': 'application/javascript', '/i18n.js': 'application/javascript', '/sw.js': 'application/javascript', '/manifest.webmanifest': 'application/manifest+json', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-maskable.png': 'image/png' };
const srv = http.createServer(async (req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(403); return res.end('Forbidden'); } // cegah DNS rebinding
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(PUB, 'index.html')).pipe(res); }
    if (req.method === 'GET' && STATIC[u.pathname]) { const f = path.join(PUB, u.pathname.slice(1)); if (!fs.existsSync(f)) return send(res, 404, { error: 'Tidak ada' }); res.writeHead(200, { 'Content-Type': STATIC[u.pathname] + (/javascript|json/.test(STATIC[u.pathname]) ? '; charset=utf-8' : ''), 'Cache-Control': u.pathname === '/sw.js' ? 'no-cache' : 'no-store', ...(u.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) }); return fs.createReadStream(f).pipe(res); }
    // ---- login ----
    if (u.pathname === '/api/auth/status' && req.method === 'GET') { const se = sessOf(req); return send(res, 200, { enabled: !!AUTH, user: se ? se.user : null, name: AUTH && !(ACCTS.size > 1) ? AUTH.user : null }); }
    if (u.pathname.startsWith('/api/auth/') && req.method === 'POST') {
      if (req.headers['x-tradebot'] !== '1') return send(res, 403, { error: 'Ditolak' });
      const b = await readBody(req), a = u.pathname.slice(10), se = sessOf(req);
      if (a === 'login') {
        const now = Date.now(); while (LOGIN_TRY.length && now - LOGIN_TRY[0] > 60000) LOGIN_TRY.shift();
        if (LOGIN_TRY.length >= 8) return send(res, 429, { error: 'Terlalu banyak percobaan. Tunggu 1 menit.' });
        if (!AUTH) return send(res, 400, { error: 'Belum ada akun. Buat akun dulu.' });
        if (!checkPw(String(b.user || ''), String(b.pass || ''))) { LOGIN_TRY.push(now); return send(res, 401, { error: 'Nama pengguna atau kata sandi salah' }); }
        { const who = ACCTS.size ? String(b.user).trim() : AUTH.user; newSess(res, who); return send(res, 200, { ok: true, user: who }); }
      }
      if (a === 'logout') { const t = cookieOf(req, 'tb_sess'); if (t) SESS.delete(t); res.setHeader('Set-Cookie', 'tb_sess=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
      if (a === 'setup' && !AUTH && E.RENDER) return send(res, 403, { error: 'Di hosting, akun harus diatur lewat LOGIN_USERS di pengaturan Environment.' });
      if (a === 'setup' && AUTH && AUTH.env) return send(res, 403, { error: 'Akun diatur lewat pengaturan Environment (LOGIN_USERS)' });
      if (a === 'setup') { // buat akun (atau ganti kata sandi saat sudah masuk)
        if (AUTH && !se) return send(res, 401, { error: 'Masuk dulu untuk mengganti akun' });
        if (AUTH && !checkPw(AUTH.user, String(b.old || ''))) return send(res, 401, { error: 'Kata sandi lama salah' });
        if (!userOk(b.user)) return send(res, 400, { error: 'Nama pengguna 3–32 karakter: huruf, angka, titik, garis bawah, strip' });
        if (String(b.pass || '').length < 6) return send(res, 400, { error: 'Kata sandi minimal 6 karakter' });
        const salt = crypto.randomBytes(16).toString('hex'); AUTH = { user: String(b.user), salt, hash: pwHash(b.pass, salt), created: AUTH ? AUTH.created : Date.now() }; saveAuth();
        SESS.clear(); newSess(res, AUTH.user); return send(res, 200, { ok: true, user: AUTH.user });
      }
      if (a === 'disable') return send(res, 403, { error: 'Login wajib dan tidak bisa dihapus' });
      if (false) { if (!AUTH || !se || !checkPw(AUTH.user, String(b.pass || ''))) return send(res, 401, { error: 'Kata sandi salah' }); AUTH = null; saveAuth(); SESS.clear(); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'Tidak dikenal' });
    }
    if (!AUTH && u.pathname.startsWith('/api/')) return send(res, 401, { error: 'Buat akun dulu', auth: true, setup: true });
    if (AUTH && u.pathname.startsWith('/api/') && !sessOf(req)) return send(res, 401, { error: 'Perlu masuk (login) dulu', auth: true });
    if (EDITION === 'basic' && u.pathname === '/api/mi' && u.searchParams.get('kind') === 'saham') return send(res, 403, { error: 'Laporan Market Intelligence saham tersedia di paket Pro dan Max.', edition: 'basic' });
    if (EDITION === 'basic' && BASIC_BLOCK.test(u.pathname)) return send(res, 403, { error: 'Trading manual dan bot tidak tersedia di paket Basic. Upgrade ke Pro atau Max.', edition: 'basic' });
    if (req.method === 'GET' && u.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ t: 'snap', s: view(), candles: M.candles.slice(-300), cur: M.cur }) + '\n\n');
      clients.add(res); const hb = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(hb); clients.delete(res); }); return;
    }
    if (req.method === 'GET' && u.pathname === '/ind.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(PUB, 'ind.js')).pipe(res); }
    if (req.method === 'GET' && u.pathname === '/api/botdash') return send(res, 200, botDash());
    if (req.method === 'GET' && u.pathname === '/api/candles') { // panel chart lain (key=pair|tf) atau riwayat panjang untuk replay (hist=1)
      const key = String(u.searchParams.get('key') || ''), [pair, tf] = key.split('|');
      if (u.searchParams.get('hist') === '1') { const n = Math.min(1000, Math.max(50, +u.searchParams.get('n') || 1000)); return send(res, 200, { candles: await histCandles(pair, tf, n) }); }
      const w = await xwLoad(key); if (!xwKeys().includes(key)) w.adhoc = true;
      return send(res, 200, { key, candles: w.candles.slice(-300), cur: w.cur });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/x/')) {
      const ex = String(u.searchParams.get('ex') || ''), sym = String(u.searchParams.get('symbol') || '').toUpperCase();
      try {
        if (!LINK_CEX.includes(ex)) throw new Error('Exchange tidak dikenal');
        if (u.pathname === '/api/x/symbols') return send(res, 200, (await xSymbols(ex)).map(({ symbol, base, quote }) => ({ symbol, base, quote })));
        if (u.pathname === '/api/x/price') return send(res, 200, { price: await xPrice(ex, sym) });
        if (u.pathname === '/api/x/orders') return send(res, 200, await xOpenOrders(ex, sym));
        if (u.pathname === '/api/x/info') return send(res, 200, await xInfo(ex, sym));
      } catch (e) { return send(res, 400, { error: e.status ? LINK_NAME[ex] + ': ' + e.message : e.message }); }
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/dex/')) {
      try {
        if (u.pathname === '/api/dex/jup/quote') {
          const q = new URLSearchParams(); for (const k of ['inputMint', 'outputMint', 'amount', 'slippageBps']) { const v = u.searchParams.get(k); if (!v || !/^[A-Za-z0-9]{1,64}$/.test(v)) throw new Error('Parameter ' + k + ' tidak valid'); q.set(k, v); }
          q.set('restrictIntermediateTokens', 'true'); return send(res, 200, await xFetch(XB.jup + '/swap/v1/quote?' + q, {}, 15000));
        }
        if (u.pathname === '/api/dex/jup/tokens') { const qq = String(u.searchParams.get('q') || '').slice(0, 60); return send(res, 200, await xFetch(XB.jup + '/tokens/v2/search?query=' + encodeURIComponent(qq), {}, 12000)); }
        if (u.pathname === '/api/dex/sol/balances') return send(res, 200, await solBalances(String(u.searchParams.get('owner') || '')));
        if (u.pathname === '/api/dex/kyber/route') {
          const ch = String(u.searchParams.get('chain') || ''); if (!EVM_CHAINS.includes(ch)) throw new Error('Jaringan tidak didukung');
          const q = new URLSearchParams(); for (const k of ['tokenIn', 'tokenOut', 'amountIn']) { const v = u.searchParams.get(k); if (!v || !/^(0x[0-9a-fA-F]{40}|\d{1,78})$/.test(v)) throw new Error('Parameter ' + k + ' tidak valid'); q.set(k, v); }
          const j = await xFetch(XB.kyber + '/' + ch + '/api/v1/routes?' + q, { headers: { 'x-client-id': 'TradeBotPro' } }, 15000);
          if (j.code !== 0 || !j.data) throw new Error(j.message || 'Rute tidak ditemukan'); return send(res, 200, j.data);
        }
      } catch (e) { return send(res, 400, { error: shortErr(e) }); }
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/mkt/')) {
      const pg = u.pathname.slice(9), fresh = u.searchParams.get('fresh') === '1';
      try {
        if (pg === 'chart') { const src = String(u.searchParams.get('src') || 'yahoo'), sym = String(u.searchParams.get('sym') || ''), rg = String(u.searchParams.get('range') || '1D'), cs = String(u.searchParams.get('csym') || '').toUpperCase().slice(0, 10), cpx = +u.searchParams.get('px') || 0;
          return send(res, 200, await cached('ch:' + src + ':' + sym + ':' + rg + ':' + cs, rg === '1D' ? 60e3 : 600e3, () => mktChart(src, sym, rg, { sym: cs, px: cpx }))); }
        const F = { crypto: [mktCrypto, 120e3], saham: [mktSaham, 120e3], forex: [mktForex, 30e3], commod: [mktCommod, 120e3], prop: [mktProp, 120e3], macro: [mktMacro, 300e3], global: [mktGlobal, 300e3] }[pg];
        if (pg === 'prop') { const d = await cached('pg:prop', 120e3, mktProp); return send(res, 200, { ...d, list: PROPS }); }
        if (!F) return send(res, 404, { error: 'Halaman tidak dikenal' });
        if (fresh && MKC['pg:' + pg] && !MKC['pg:' + pg].p) delete MKC['pg:' + pg];
        return send(res, 200, await cached('pg:' + pg, F[1], F[0]));
      } catch (e) { return send(res, 502, { error: shortErr(e) }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/wallets') return send(res, 200, { list: WAL.list, alarm: WAL.alarm });
    if (req.method === 'GET' && u.pathname === '/api/ei') { try { return send(res, 200, await eiReport(u.searchParams.get('fresh') === '1')); } catch (e) { return send(res, 502, { error: shortErr(e) }); } }
    if (req.method === 'GET' && u.pathname === '/api/assets') {
      try { return send(res, 200, { cat: u.searchParams.get('cat'), list: await assetList(String(u.searchParams.get('cat') || ''), u.searchParams.get('q')) }); } catch (e) { return send(res, 502, { error: shortErr(e) }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/profile') { const se = sessOf(req), k = se ? se.user : 'local'; return send(res, 200, { user: k, env: !!(AUTH && AUTH.env), prof: PROFS[k] || null }); }
    if (req.method === 'GET' && u.pathname === '/api/quota') return send(res, 200, quotaView((sessOf(req) || {}).user || 'local', EDITION));
    if (req.method === 'GET' && (u.pathname === '/api/mi' || u.pathname === '/api/research' || u.pathname === '/api/ii/value')) {
      try { req.qBack = quotaTake((sessOf(req) || {}).user || 'local', EDITION, u.pathname === '/api/mi' ? 'mi' : u.pathname === '/api/research' ? 'rd' : 'ii'); } catch (e) { return send(res, 429, { error: e.message, quota: true }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/ii/value') { try { return send(res, 200, await cached('ii:value', 10 * 60e3, iiValue)); } catch (e) { if (req.qBack) req.qBack(); return send(res, 502, { error: shortErr(e) }); } }
    if (req.method === 'GET' && u.pathname === '/api/mi') {
      try { const fr = u.searchParams.get('fresh') === '1'; return send(res, 200, u.searchParams.get('kind') === 'saham' ? await marketIntelSaham(fr) : await marketIntel(fr)); } catch (e) { if (req.qBack) req.qBack(); return send(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/research') {
      const pair = String(u.searchParams.get('pair') || S.settings.pair);
      if (u.searchParams.get('fresh') === '1' && RES[pair] && !RES[pair].p) delete RES[pair];
      try { return send(res, 200, await research(pair)); } catch (e) { if (req.qBack) req.qBack(); return send(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/orderbook') {
      const pair = String(u.searchParams.get('pair') || S.settings.pair);
      if (!PAIRS[pair]) return send(res, 400, { error: 'Aset tidak dikenal' });
      try { return send(res, 200, await orderBook(pair)); } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/pairs') {
      const sm = (await summaries()) || {}, T = sm.tickers || {}, P24 = sm.prices_24h || {};
      if (Date.now() - UD.at > 300000 && Date.now() - (UD.tried || 0) > 60000) { UD.tried = Date.now(); usdtdNow().catch(() => { }); } // nilai terkini untuk daftar aset (tidak menunggu)
      const ext = Object.values(EXT).filter(x => !x.yahoo).map(x => ({ id: x.id, desc: x.desc, coin: x.coin, ext: true, maint: false, last: UD.now, chg: null, vol: 0 }));
      return send(res, 200, ext.concat(Object.values(PAIRS).map(p => { const t = T[p.ticker], last = t ? +t.last : 0, o24 = +P24[p.id]; return { id: p.id, desc: p.desc, coin: p.coin, maint: p.maint, last: last > 0 ? last : null, chg: last > 0 && o24 > 0 ? (last / o24 - 1) * 100 : null, vol: t ? +t.vol_idr || 0 : 0 }; })
        .sort((a, b) => b.vol - a.vol || a.desc.localeCompare(b.desc))));
    }
    if (req.method !== 'POST') { res.writeHead(404); return res.end('Not found'); }
    if (req.headers['x-tradebot'] !== '1') return send(res, 403, { error: 'Ditolak' }); // cegah CSRF dari situs lain
    const b = await readBody(req);
    if (u.pathname === '/api/profile') { const se = sessOf(req), k = se ? se.user : 'local'; if (b.reset) { delete PROFS[k]; saveProfs(); return send(res, 200, { ok: true, prof: null }); } let o; try { o = profClean(b); } catch (e) { return send(res, 400, { error: e.message }); } PROFS[k] = o; saveProfs(); return send(res, 200, { ok: true, prof: o }); }
    if (u.pathname === '/api/order') { const f = b.market === 'futures'; const p = await openPos({ idr: b.idr, sl: b.sl, tp: b.tp, isBot: false, ...(f ? { market: 'futures', side: b.side, lev: b.lev, mm: b.mm } : {}) }); return send(res, 200, { ok: true, id: p.id }); }
    if (u.pathname === '/api/sell') { const r = await sellNow(b); return send(res, 200, { ok: true, ...r }); }
    if (u.pathname === '/api/close') { await closePos(String(b.id || ''), 'Manual'); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/deposit') { if (LIVE) throw new Error('Deposit dilakukan langsung di aplikasi Indodax'); const a = Math.floor(+b.idr); if (!(a >= 10000 && a <= 1e10)) throw new Error('Minimal deposit simulasi Rp 10.000'); S.paper.idr += a; S.paper.deposited = (S.paper.deposited || 0) + a; save(); toast('💎 Deposit simulasi ' + fmt(a), 'success'); pushState(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/limit') { const o = await placeLimit(b); return send(res, 200, { ok: true, id: o.id }); }
    if (u.pathname === '/api/backtest') return send(res, 200, await runBacktest(b));
    if (u.pathname === '/api/alerts/add') {
      if (ALERTS.length >= 100) throw new Error('Terlalu banyak alert (maksimal 100)');
      const a = { id: uid('al_'), ...normAlert(b, null), on: true, armed: true, fires: 0, firedAt: null, createdAt: Date.now() }; a.lastPx = knownPrice(a.pair);
      ALERTS.push(a); saveAlerts(); wsSync(); pushState(); if (a.lastPx) checkAlerts(a.pair, a.lastPx); return send(res, 200, { ok: true, id: a.id });
    }
    if (u.pathname === '/api/alerts/update') { const i = ALERTS.findIndex(x => x.id === b.id); if (i < 0) throw new Error('Alert tidak ditemukan'); ALERTS[i] = normAlert(b, ALERTS[i]); saveAlerts(); wsSync(); pushState(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/alerts/del') { if (b.all === true) ALERTS = []; else { const n = ALERTS.length; ALERTS = ALERTS.filter(x => x.id !== b.id); if (ALERTS.length === n) throw new Error('Alert tidak ditemukan'); } saveAlerts(); wsSync(); pushState(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/history/clear') { const n = S.history.length; S.history = []; save(); toast('🗑️ Riwayat trade dihapus (' + n + ' baris). Total P&L tidak berubah.', 'info'); pushState(); return send(res, 200, { ok: true, removed: n }); }
    if (u.pathname === '/api/botlog/clear') { S.botLog = []; save(); pushState(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/cancel') { await cancelOrder(String(b.id || '')); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/license/activate') { const st = await LIC.activate(b.key); pushState(); toast('🔑 Lisensi aktif' + (st.expiresAt ? ' sampai ' + new Date(st.expiresAt).toLocaleDateString('id-ID') : ''), 'success'); return send(res, 200, { ok: true, license: st }); }
    if (u.pathname === '/api/license/check') { const st = await LIC.check(); pushState(); return send(res, 200, { ok: true, license: st }); }
    if (u.pathname === '/api/reset') { if (LIVE) throw new Error('Reset hanya untuk mode simulasi'); if (S.positions.length || S.orders.length) throw new Error('Tutup semua posisi dan batalkan order dulu'); S.paper = { idr: CFG.paperIdr, deposited: CFG.paperIdr }; S.history = []; S.totalPnl = 0; S.dayPnl = 0; save(); toast('Akun simulasi direset', 'info'); pushState(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/connect') {
      const provider = String(b.provider || 'indodax');
      if (provider !== 'indodax') throw new Error('Trading sungguhan baru lewat Indodax. Tokocrypto dan Binance bisa dihubungkan untuk melihat portofolio (baca saja).');
      if (!LIC.canLive()) throw new Error('Mode LIVE butuh lisensi aktif. Masukkan kunci lisensi di menu Lisensi dulu. Mode simulasi tetap gratis.');
      const key = String(b.key || '').trim(), secret = String(b.secret || '').trim();
      if (!key || !secret) throw new Error('API Key dan Secret Key harus diisi');
      if (S.positions.length || S.orders.length) throw new Error('Tutup semua posisi dan batalkan order terbuka dulu sebelum mengganti akun atau mode');
      let d;
      try { d = await detectVer({ key, secret }); }
      catch (e) {
        if (isNetErr(e)) throw new Error('Tidak bisa menjangkau Indodax. Periksa koneksi internet lalu coba lagi.');
        const clock = [e.e2, e.e1, e].some(x => x && /-1021|timestamp/i.test(x.message || ''));
        throw new Error('Indodax menolak kunci ini. ' + e.message + '. ' + (clock ? 'Jam komputer sepertinya tidak sinkron; aktifkan sinkronisasi waktu otomatis di Windows. ' : '') + 'Pastikan kunci dibuat di indodax.com/trade_api dengan izin view dan trade, dan jika memakai IP whitelist, IP komputer ini sudah didaftarkan.');
      }
      if (d.bal.canTrade === false) throw new Error('Kunci ini terhubung tetapi TIDAK punya izin trade. Buat kunci baru dengan izin view dan trade.');
      S.settings.botActive = false;
      setMode(true, key, secret); API_VER = d.ver;
      if (b.remember === true) rememberEnv(key, secret);
      refreshLive();
      toast('🔴 Terhubung ke Indodax Trade API ' + d.ver.toUpperCase() + ' (LIVE). Saldo IDR ' + fmt(d.bal.idr) + (b.remember === true ? ' · kunci disimpan di .env' : ''), 'info');
      if (d.bal.canWithdraw === true) toast('⚠️ Kunci ini punya izin WITHDRAW. Sebaiknya buat kunci baru tanpa izin tarik dana.', 'error');
      return send(res, 200, { ok: true, live: true });
    }
    if (u.pathname === '/api/link') { // Tokocrypto / Binance (portofolio, baca saja) / Arkham (data whale)
      const k = String(b.provider || ''); if (!LINKS[k]) throw new Error('Penyedia tidak dikenal. Pilih Tokocrypto, Binance, atau Arkham Intelligence.');
      const key = String(b.key || '').trim(), secret = String(b.secret || '').trim();
      if (!key || (LINK_ENV[k][1] && !secret)) throw new Error(LINK_ENV[k][1] ? 'API Key dan Secret Key harus diisi' : 'API Key harus diisi');
      const trade = LINK_CEX.includes(k) && b.trade === true;
      let r; try { r = await linkCheck(k, { key, secret, trade }); } catch (e) { throw new Error(linkErrMsg(k, e)); }
      Object.assign(LINKS[k], { key, secret, trade, on: true, at: Date.now(), err: '', assets: r.assets, total: r.assets.reduce((a, x) => a + (x.idr || 0), 0), warn: r.warn });
      if (b.remember === true) { setEnvVars([...LINK_ENV[k].map((n, i) => [n, i ? secret : key]), ...(LINK_TRADE_ENV[k] ? [[LINK_TRADE_ENV[k], trade ? 'true' : 'false']] : [])]); LINKS[k].saved = true; }
      if (['coinglass', 'glassnode'].includes(k)) MIC.at = 0;
      toast('🔗 ' + LINK_NAME[k] + ' terhubung' + (LINK_CEX.includes(k) ? ' · ' + r.assets.length + ' aset, perkiraan ' + fmt(LINKS[k].total) + (trade ? ' · trading diizinkan' : ' · baca saja') : k === 'arkham' ? ' · transfer whale tampil di Market Intelligence' : k === 'coinglass' ? ' · likuidasi tampil di Market Intelligence' : k === 'glassnode' ? ' · data on-chain tampil di Market Intelligence' : k === 'cmc' ? ' · data CoinMarketCap tampil di menu Crypto' : '') + (b.remember === true ? ' · kunci disimpan di .env' : ''), 'success');
      if (r.warn) toast('⚠️ ' + r.warn, 'info');
      if (k === 'arkham') MIC.at = 0;
      pushState(); return send(res, 200, { ok: true, link: linkView()[k] });
    }
    if (u.pathname === '/api/unlink') {
      const k = String(b.provider || ''); if (!LINKS[k]) throw new Error('Penyedia tidak dikenal');
      const wasSaved = LINKS[k].saved; Object.assign(LINKS[k], { key: '', secret: '', on: false, at: 0, err: '', assets: [], total: 0, warn: '', saved: false, trade: false });
      if (wasSaved) setEnvVars([...LINK_ENV[k].map(n => [n, '']), ...(LINK_TRADE_ENV[k] ? [[LINK_TRADE_ENV[k], 'false']] : [])]);
      MIC.at = 0;
      toast(LINK_NAME[k] + ' diputus. Kunci dihapus dari memori server' + (wasSaved ? ' dan dari .env' : '') + '.', 'info'); pushState(); return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/x/order') return send(res, 200, await xOrder(b));
    if (u.pathname === '/api/x/cancel') { await xCancel(String(b.ex || ''), String(b.symbol || ''), b.orderId); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/custom/save') {
      const cur = b.id ? CUSTOM.find(c => c.id === b.id) : null; if (b.id && !cur) throw new Error('API kustom tidak ditemukan');
      if (!cur && CUSTOM.length >= 30) throw new Error('Maksimal 30 API kustom');
      const o = normCustom(b, cur); o.id = cur ? cur.id : uid('api_');
      try { const r = await customCall(o, o.test, 'GET'); o.ok = r.ok; o.err = r.ok ? '' : 'HTTP ' + r.status + (r.json && (r.json.msg || r.json.message || r.json.error) ? ' · ' + String(r.json.msg || r.json.message || r.json.error).slice(0, 120) : ''); }
      catch (e) { o.ok = false; o.err = shortErr(e); }
      o.at = Date.now(); if (cur) Object.assign(cur, o); else CUSTOM.push(o); saveCustom();
      toast((o.ok ? '🔗 ' : '⚠️ ') + o.name + (o.ok ? ' tersimpan & uji koneksi berhasil' : ' tersimpan, tetapi uji koneksi gagal: ' + o.err), o.ok ? 'success' : 'error');
      pushState(); return send(res, 200, { ok: true, id: o.id, test: { ok: o.ok, err: o.err } });
    }
    if (u.pathname === '/api/custom/del') { const n = CUSTOM.length; CUSTOM = CUSTOM.filter(c => c.id !== b.id); if (CUSTOM.length === n) throw new Error('API kustom tidak ditemukan'); saveCustom(); toast('API kustom dihapus (kuncinya ikut dihapus)', 'info'); pushState(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/custom/call') {
      const c = CUSTOM.find(x => x.id === b.id), pre = { coinglass: ['CG-API-KEY', 'header', XB.cgl], glassnode: ['api_key', 'query', XB.gn], messari: ['x-messari-api-key', 'header', XB.messari], cmc: ['X-CMC_PRO_API_KEY', 'header', XB.cmc], arkham: ['API-Key', 'header', XB.arkham] }[b.id];
      let api2 = c; if (!api2 && pre && LINKS[b.id] && LINKS[b.id].on) api2 = { base: pre[2], auth: pre[1], keyName: pre[0], key: LINKS[b.id].key };
      if (!api2) throw new Error('Pilih API yang sudah terhubung');
      try { return send(res, 200, await customCall(api2, String(b.path || '/'), String(b.method || 'GET').toUpperCase(), b.body && typeof b.body === 'object' ? b.body : undefined)); } catch (e) { throw new Error('Panggilan gagal: ' + shortErr(e)); }
    }
    if (u.pathname === '/api/dex/jup/swap') {
      if (!b.quoteResponse || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(b.userPublicKey || ''))) throw new Error('Data swap tidak lengkap');
      const j = await xFetch(XB.jup + '/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: b.quoteResponse, userPublicKey: b.userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) }, 20000);
      if (!j.swapTransaction) throw new Error('Jupiter tidak mengembalikan transaksi'); return send(res, 200, { swapTransaction: j.swapTransaction, lastValidBlockHeight: j.lastValidBlockHeight });
    }
    if (u.pathname === '/api/dex/kyber/build') {
      const ch = String(b.chain || ''); if (!EVM_CHAINS.includes(ch)) throw new Error('Jaringan tidak didukung');
      const j = await xFetch(XB.kyber + '/' + ch + '/api/v1/route/build', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-client-id': 'TradeBotPro' }, body: JSON.stringify({ routeSummary: b.routeSummary, sender: b.sender, recipient: b.sender, slippageTolerance: Math.min(500, Math.max(1, Math.round(+b.slippageBps || 50))) }) }, 20000);
      if (j.code !== 0 || !j.data) throw new Error(j.message || 'KyberSwap gagal membuat transaksi'); return send(res, 200, j.data);
    }
    if (u.pathname === '/api/dex/log') {
      const rec = { at: Date.now(), ex: String(b.dex || 'dex').slice(0, 20), symbol: String(b.pair || '').slice(0, 40), side: 'swap', type: String(b.chain || '').slice(0, 20), qty: +b.amountIn || null, quote: +b.amountOut || null, price: null, orderId: String(b.tx || '').slice(0, 120), status: 'SENT' };
      S.xtrades = [rec, ...(S.xtrades || [])].slice(0, 60); save(); pushState(); return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/links/refresh') { await Promise.all(Object.keys(LINKS).filter(k => LINKS[k].key && k !== 'arkham').map(linkRefresh)); pushState(); return send(res, 200, { ok: true, links: linkView() }); }
    if (u.pathname === '/api/disconnect') {
      if (S.positions.length || S.orders.length) throw new Error('Tutup semua posisi dan batalkan order terbuka dulu sebelum kembali ke simulasi');
      S.settings.botActive = false;
      setMode(false);
      toast('🟢 Kembali ke mode SIMULASI. Kunci API dihapus dari memori server.', 'info');
      return send(res, 200, { ok: true, live: false });
    }
    if (u.pathname === '/api/wallets/save') {
      const o = normWallet(b), cur = WAL.list.find(x => x.id === b.id) || WAL.list.find(x => x.addr === o.addr && x.chain === o.chain);
      if (!cur && WAL.list.length >= 60) throw new Error('Maksimal 60 wallet');
      let item; if (cur) { Object.assign(cur, o, { upd: Date.now() }); item = cur; } else { item = { id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ...o, at: Date.now() }; WAL.list.unshift(item); }
      saveWal(); EIC.at = 0; return send(res, 200, { ok: true, item, list: WAL.list });
    }
    if (u.pathname === '/api/wallets/del') { const n = WAL.list.length; WAL.list = WAL.list.filter(x => x.id !== b.id); if (WAL.list.length === n) throw new Error('Wallet tidak ditemukan'); delete WSEEN[b.id]; saveWal(); EIC.at = 0; return send(res, 200, { ok: true, list: WAL.list }); }
    if (u.pathname === '/api/wallets/alarm') {
      if (b.on != null) { if (typeof b.on !== 'boolean') throw new Error('Nilai on tidak valid'); WAL.alarm.on = b.on; }
      if (b.min != null) { const n = +b.min; if (!(n >= 1000 && n <= 1e10)) throw new Error('Batas alarm $1.000 sampai $10 miliar'); WAL.alarm.min = Math.round(n); }
      if (b.every != null) { const n = Math.round(+b.every); if (!(n >= 1 && n <= 60)) throw new Error('Interval 1 sampai 60 menit'); WAL.alarm.every = n; }
      saveWal(); if (b.test) { await whaleTick(true); } return send(res, 200, { ok: true, alarm: WAL.alarm, log: WAL.log.slice(0, 20) });
    }
    if (u.pathname === '/api/prop/save') { const cur = b.id ? PROPS.find(x => x.id === b.id) : null; if (b.id && !cur) throw new Error('Listing tidak ditemukan'); if (!cur && PROPS.length >= 500) throw new Error('Maksimal 500 listing');
      const o = normProp(b, cur); if (cur) Object.assign(cur, o); else PROPS.unshift(o); savePropFile(); return send(res, 200, { ok: true, item: o, list: PROPS }); }
    if (u.pathname === '/api/prop/del') { const n = PROPS.length; PROPS = PROPS.filter(x => x.id !== b.id); if (PROPS.length === n) throw new Error('Listing tidak ditemukan'); savePropFile(); return send(res, 200, { ok: true, list: PROPS }); }
    if (u.pathname === '/api/settings') {
      const st = S.settings, oldPair = st.pair, oldTf = st.tf, oldCs = st.chartSrc || 'auto';
      if (b.chartSrc != null) { if (!CH_SRC.includes(b.chartSrc)) throw new Error('Sumber chart tidak dikenal'); st.chartSrc = b.chartSrc; }
      const oldMv = st.mainView || null;
      if (b.mainView !== undefined) { if (b.mainView === null || b.mainView === '') st.mainView = null; else { const mv = String(b.mainView); if (!extOf(mv)) throw new Error('Aset tidak dikenal'); st.mainView = mv; } }
      if (b.pair != null && b.pair === st.pair && b.mainView === undefined) st.mainView = null;
      if (b.pair != null && b.pair !== st.pair) { st.mainView = null; if (!PAIRS[b.pair]) throw new Error('Pair tidak dikenal'); if (S.positions.length || S.orders.length) throw new Error('Tutup semua posisi dan batalkan order terbuka sebelum ganti pair'); st.pair = b.pair; }
      if (b.tf != null && b.tf !== st.tf) { if (!TF_SEC[b.tf]) throw new Error('Timeframe tidak dikenal'); st.tf = b.tf; }
      const oldStrat = st.strategy, oldBotTf = st.bot.cfg[st.strategy].tf;
      if (b.strategy != null && b.strategy !== st.strategy) { if (!STRATS.includes(b.strategy)) throw new Error('Strategi tidak dikenal'); st.strategy = b.strategy; }
      if (b.ind != null) st.ind = patchInd(st.ind, b.ind, false); // indikator chart bisa diatur kapan saja
      if (b.bot != null) st.bot = patchBot(st.bot, b.bot); // pengaturan bot juga bisa diubah saat bot berjalan; berlaku di sinyal berikutnya
      if (b.fibDraw !== undefined) { // Fibonacci gambar manual untuk satu pair (null = hapus)
        const pr = b.fibPair != null ? String(b.fibPair) : st.pair; if (!chartPair(pr)) throw new Error('Pair tidak dikenal');
        st.fibDraw = st.fibDraw || {};
        if (b.fibDraw === null) delete st.fibDraw[pr]; else st.fibDraw[pr] = normFib(b.fibDraw, true);
      }
      if (b.fibTpl !== undefined) st.fibTpl = b.fibTpl === null ? null : normFib(b.fibTpl, false);
      if (b.chart != null) st.chart = normChart({ ...b.chart, __cur: st.chart }, true);
      if (b.usdtdSrc != null) { if (!['auto', 'coingecko', 'alt'].includes(b.usdtdSrc)) throw new Error('Sumber USDT.D tidak dikenal'); if (st.usdtdSrc !== b.usdtdSrc) { st.usdtdSrc = b.usdtdSrc; for (const k of Object.keys(UDH)) delete UDH[k]; for (const k of Object.keys(XW)) if (k.startsWith('usdtd|')) delete XW[k]; for (const k of Object.keys(histCache)) if (k.startsWith('usdtd|')) delete histCache[k]; } }
      if (b.layout != null) { st.layout = normLayout(b.layout, true); xwSync(); }
      if (b.compare != null) { st.compare = normCompare(b.compare, true); xwSync(); }
      else if (b.tf != null || b.pair != null || (st.mainView || null) !== oldMv) xwSync();
      if (b.drawings !== undefined) { // gambar satu aset (null = hapus semua)
        const pr = b.drawPair != null ? String(b.drawPair) : st.pair; if (!chartPair(pr)) throw new Error('Pair tidak dikenal');
        st.drawings = st.drawings || {}; if (b.drawings === null || (Array.isArray(b.drawings) && !b.drawings.length)) delete st.drawings[pr]; else st.drawings[pr] = normDrawings(b.drawings);
      }
      if (b.botSize != null) { const v = Math.floor(+b.botSize); if (!(v >= P().minIdr && v <= 1e13)) throw new Error('Ukuran bot minimal ' + fmt(P().minIdr)); st.botSize = v; }
      if (b.botSl != null) { const v = +b.botSl; if (!(v > 0 && v < 50)) throw new Error('Bot SL tidak valid'); st.botSl = v; }
      if (b.botTp != null) { const v = +b.botTp; if (!(v > 0 && v < 100)) throw new Error('Bot TP tidak valid'); st.botTp = v; }
      for (const k of ['botSlOn', 'botTpOn']) if (b[k] != null) { if (typeof b[k] !== 'boolean') throw new Error('Nilai ' + k + ' tidak valid'); st[k] = b[k]; }
      if (b.botMarket != null) { if (!['spot', 'futures'].includes(b.botMarket)) throw new Error('Pasar bot tidak dikenal'); if (b.botMarket === 'futures' && LIVE) throw new Error(FUT_LIVE_MSG); st.botMarket = b.botMarket; }
      for (const k of ['botLev', 'futLev']) if (b[k] != null) { const v = Math.round(+b[k]); if (!(v >= 1 && v <= FUT_MAX_LEV)) throw new Error('Leverage harus 1x sampai ' + FUT_MAX_LEV + 'x'); st[k] = v; }
      for (const k of ['botMM', 'futMM']) if (b[k] != null) { if (!['isolated', 'cross'].includes(b[k])) throw new Error('Mode margin tidak dikenal'); st[k] = b[k]; }
      if (b.botActive != null) {
        const on = !!b.botActive;
        if (on && S.dayPnl <= -CFG.dailyLoss) throw new Error('Batas rugi harian tercapai; bot tidak bisa dinyalakan hari ini');
        if (on && LIVE && b.confirmLive !== true) throw new Error('Konfirmasi mode live diperlukan');
        const was = st.botActive; st.botActive = on;
        if (on && !was) { BOT.entryBucket = 0; const bc = st.bot.cfg[st.strategy]; blog('info', 'Bot dinyalakan · ' + st.strategy + ' · ' + bc.tf + ' · ' + fmt(st.botSize) + ' · order ' + st.bot.entry + ' · cek ' + (st.bot.check === 'live' ? 'langsung' : 'saat candle tutup') + ' · ' + (LIVE ? 'LIVE' : 'simulasi')); toast('🤖 Bot aktif (' + (LIVE ? 'LIVE, dana sungguhan' : 'simulasi') + ') · ' + st.strategy + ' · timeframe ' + bc.tf + ' · order ' + st.bot.entry + ' · cek ' + (st.bot.check === 'live' ? 'langsung' : 'saat candle tutup'), 'info'); }
        if (!on && was) {
          toast('⏸️ Bot dimatikan', 'error'); blog('info', 'Bot dimatikan');
          for (const o of S.orders.filter(x => x.isBot && x.kind === 'buy')) cancelOrder(o.id, true).catch(e => toast('Gagal membatalkan limit bot: ' + e.message, 'error')); // order masuk bot yang belum terisi ikut dibatalkan
          if (b.closeBotPos) for (const bp of S.positions.filter(p => p.isBot)) closePos(bp.id, 'Bot dimatikan');
        }
      }
      save();
      const reBot = st.strategy !== oldStrat || st.bot.cfg[st.strategy].tf !== oldBotTf;
      if ((st.chartSrc || 'auto') !== oldCs) { for (const k of Object.keys(XW)) delete XW[k]; for (const k of Object.keys(histCache)) delete histCache[k]; }
      if (st.pair !== oldPair || st.tf !== oldTf || (st.mainView || null) !== oldMv || (st.chartSrc || 'auto') !== oldCs) { M.ch24 = null; M.ref24 = 0; await loadHistory(); if (st.pair !== oldPair) wsResub(oldPair); await botLoad(true); broadcast({ t: 'snap', s: view(), candles: M.candles.slice(-300), cur: M.cur }); }
      else { if (reBot) await botLoad(true); else if (b.ind != null || b.bot != null || b.strategy != null || b.fibDraw !== undefined || b.botSl != null) botRefresh(); pushState(); }
      return send(res, 200, { ok: true });
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { send(res, 400, { error: e.message }); }
});

// simpan perubahan terakhir saat server ditutup (Ctrl+C, jendela ditutup, atau dihentikan)
process.on('unhandledRejection', e => { try { log('Galat tak tertangani:', (e && e.message) || e); } catch (x) { } }); // server tetap hidup bila satu sumber data gagal
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => { flushState(); process.exit(0); }); } catch (e) { } }

if (require.main !== module) module.exports = { evalStrat, backtest, noLL, normBot, patchBot, exits, IND, normChart, normLayout, normDrawings }; // dipakai uji otomatis
else (async () => {
  await loadPairs(); await loadHistory(); await botLoad(true); S.settings.layout = normLayout(S.settings.layout); S.settings.compare = normCompare(S.settings.compare); xwSync();
  if (LIVE) refreshLive();
  wsConnect();
  LIC.start();
  srv.listen(CFG.port, CFG.host, () => {
    console.log('\n⚡ Veramas ' + PLAN_NAME[EDITION] + ' berjalan di http://localhost:' + CFG.port);
    console.log('   Mode: ' + (LIVE ? '🔴 LIVE (dana sungguhan di Indodax)' : '🟢 SIMULASI (harga asli Indodax, saldo pura-pura)'));
    console.log('   Ukuran trade bot: tidak dibatasi · batas rugi harian: ' + fmt(CFG.dailyLoss) + '\n');
  });
})();
