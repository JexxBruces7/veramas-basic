// Indikator teknikal. Dipakai server (sinyal bot) DAN browser (gambar chart), jadi angkanya selalu sama.
// Semua fungsi mengembalikan array sepanjang input; nilai belum tersedia = null.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.IND = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const nz = v => v != null && isFinite(v);

  // Simple Moving Average
  function sma(v, n) {
    const o = new Array(v.length).fill(null);
    for (let i = n - 1; i < v.length; i++) {
      let s = 0, ok = true;
      for (let j = i - n + 1; j <= i; j++) { if (!nz(v[j])) { ok = false; break; } s += v[j]; }
      if (ok) o[i] = s / n;
    }
    return o;
  }

  // Exponential Moving Average: benih = SMA n nilai pertama, lalu k = 2/(n+1)
  function ema(v, n) {
    const o = new Array(v.length).fill(null), k = 2 / (n + 1); let prev = null;
    for (let i = 0; i < v.length; i++) {
      if (prev == null) {
        if (i < n - 1) continue;
        let s = 0, ok = true;
        for (let j = i - n + 1; j <= i; j++) { if (!nz(v[j])) { ok = false; break; } s += v[j]; }
        if (ok) { prev = s / n; o[i] = prev; }
      } else if (nz(v[i])) { prev = v[i] * k + prev * (1 - k); o[i] = prev; }
    }
    return o;
  }

  // MACD = EMA(cepat) - EMA(lambat); sinyal = EMA(sig) dari garis MACD; histogram = MACD - sinyal
  function macd(closes, fast, slow, sig) {
    const a = ema(closes, fast), b = ema(closes, slow);
    const line = closes.map((_, i) => nz(a[i]) && nz(b[i]) ? a[i] - b[i] : null);
    const signal = ema(line, sig);
    const hist = line.map((x, i) => nz(x) && nz(signal[i]) ? x - signal[i] : null);
    return { macd: line, signal, hist };
  }

  // Stochastic (slow): %K mentah = (close - low_n) / (high_n - low_n) * 100, diperhalus SMA(smooth); %D = SMA(d) dari %K
  function stoch(c, kP, dP, smooth) {
    const raw = new Array(c.length).fill(null);
    for (let i = kP - 1; i < c.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kP + 1; j <= i; j++) { if (c[j].high > hh) hh = c[j].high; if (c[j].low < ll) ll = c[j].low; }
      raw[i] = hh === ll ? 50 : (c[i].close - ll) / (hh - ll) * 100;
    }
    const k = sma(raw, Math.max(1, smooth)), d = sma(k, Math.max(1, dP));
    return { k, d };
  }

  // Fibonacci retracement dari swing (high tertinggi dan low terendah) pada n candle terakhir.
  // dir 'up'   : low muncul sebelum high, level diukur turun dari high (koreksi naik).
  // dir 'down' : high muncul sebelum low, level diukur naik dari low.
  // r = 0 di ujung swing terbaru, r = 1 di awal swing.
  const RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  function fib(c, n, extra) {
    const w = c.slice(-n); if (w.length < 5) return null;
    let hi = -Infinity, lo = Infinity, iHi = -1, iLo = -1;
    w.forEach((x, i) => { if (x.high >= hi) { hi = x.high; iHi = i; } if (x.low <= lo) { lo = x.low; iLo = i; } });
    if (!(hi > lo)) return null;
    const dir = iHi > iLo ? 'up' : 'down';
    const at = r => dir === 'up' ? hi - r * (hi - lo) : lo + r * (hi - lo);
    const set = RATIOS.slice(); if (nz(extra) && !set.includes(+extra)) set.push(+extra);
    return { hi, lo, dir, levels: set.sort((a, b) => a - b).map(r => ({ r, price: at(r) })), at };
  }

  // Fibonacci yang digambar manual (dua titik seperti TradingView): level 0 di titik 2, level 1 di titik 1.
  // reverse = dibalik. dir 'up' berarti level 0 di atas level 1 (koreksi dari gerak naik).
  function fibLine(d) {
    if (!d || !d.p1 || !d.p2) return null;
    const a = d.reverse ? d.p1.price : d.p2.price, b = d.reverse ? d.p2.price : d.p1.price;
    if (!(a > 0 && b > 0) || a === b) return null;
    const at = r => a + (b - a) * r;
    return { dir: a > b ? 'up' : 'down', at, levels: (d.levels || []).filter(l => l.on).map(l => ({ r: l.r, price: at(l.r), col: l.col })).sort((x, y) => x.r - y.r) };
  }
  // gaya bawaan alat Fibonacci (warna level mengikuti TradingView)
  const FIB_STYLE = {
    levels: [[0, '#787b86', 1], [0.236, '#f23645', 1], [0.382, '#ff9800', 1], [0.5, '#4caf50', 1], [0.618, '#089981', 1], [0.786, '#00bcd4', 1], [1, '#787b86', 1], [1.618, '#2962ff', 1],
      [2.618, '#f23645', 0], [3.618, '#9c27b0', 0], [4.236, '#e91e63', 0], [1.272, '#ff9800', 0], [1.414, '#4caf50', 0], [0.65, '#089981', 0], [-0.272, '#00bcd4', 0], [-0.618, '#787b86', 0]]
      .map(([r, col, on]) => ({ r, on: !!on, col })),
    trend: true, trendCol: '#787b86', lineW: 1, lineStyle: 0, extend: 'none', reverse: false, prices: true, lvlShow: true, lvlAs: 'values',
    labelH: 'left', labelV: 'middle', bg: true, bgOp: 12, fontSize: 11,
  };

  // Bollinger Bands: tengah = SMA(n); atas/bawah = tengah ± k × simpangan baku n harga terakhir
  function bb(v, n, k) {
    const mid = sma(v, n), up = new Array(v.length).fill(null), lo = new Array(v.length).fill(null);
    for (let i = 0; i < v.length; i++) {
      if (mid[i] == null) continue; let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (v[j] - mid[i]) * (v[j] - mid[i]);
      const sd = Math.sqrt(s / n); up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
    }
    return { mid, up, lo };
  }

  // RSI (Wilder): rata-rata naik / rata-rata turun, dihaluskan 1/n
  function rsi(v, n) {
    const o = new Array(v.length).fill(null); if (v.length <= n) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (!nz(d)) return o; if (d > 0) g += d; else l -= d; }
    let ag = g / n, al = l / n; o[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = n + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1]; if (!nz(d)) continue;
      ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n; al = (al * (n - 1) + (d < 0 ? -d : 0)) / n;
      o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return o;
  }

  // Swing high/low: candle i adalah puncak bila high-nya lebih tinggi dari len candle di kiri dan tidak terlampaui len candle di kanan
  function isPivot(c, i, len, hi) {
    if (i - len < 0 || i + len >= c.length) return false; const v = hi ? c[i].high : c[i].low;
    for (let j = i - len; j <= i + len; j++) { if (j === i) continue; const w = hi ? c[j].high : c[j].low; if (hi ? (j < i ? w >= v : w > v) : (j < i ? w <= v : w < v)) return false; }
    return true;
  }
  // Struktur pasar: BOS = tembus swing searah tren, CHoCH = tembus swing berlawanan arah tren (tanda pembalikan).
  // Tembus dihitung dari harga TUTUP candle. Hasil: [{ type: 'BOS'|'CHoCH', dir: 'up'|'down', i (candle penembus), from (indeks swing), price }]
  function structure(c, len) {
    const ev = []; let hi = null, lo = null, trend = 0;
    for (let i = 0; i < c.length; i++) {
      const p = i - len;
      if (p >= len) { if (isPivot(c, p, len, true)) hi = { i: p, price: c[p].high }; if (isPivot(c, p, len, false)) lo = { i: p, price: c[p].low }; }
      if (hi && !hi.done && c[i].close > hi.price) { ev.push({ type: trend < 0 ? 'CHoCH' : 'BOS', dir: 'up', i, from: hi.i, price: hi.price }); hi.done = true; trend = 1; }
      if (lo && !lo.done && c[i].close < lo.price) { ev.push({ type: trend > 0 ? 'CHoCH' : 'BOS', dir: 'down', i, from: lo.i, price: lo.price }); lo.done = true; trend = -1; }
    }
    return ev;
  }
  // Order block: dibuat saat struktur berubah (CHoCH).
  // Hijau (support utama): bearish -> bullish; candle turun terakhir di titik terendah sebelum harga berbalik naik.
  // Merah (resistance utama): bullish -> bearish; candle naik terakhir di titik tertinggi sebelum harga berbalik turun.
  // end = candle yang menutup menembus zona (zona tidak berlaku lagi); null = masih aktif.
  function orderBlocks(c, len) {
    const out = [];
    for (const e of structure(c, len)) {
      if (e.type !== 'CHoCH') continue;
      const up = e.dir === 'up'; let m = e.from;
      for (let j = e.from; j <= e.i; j++) if (up ? c[j].low < c[m].low : c[j].high > c[m].high) m = j;
      let ob = -1; for (let j = m; j >= Math.max(0, m - 12); j--) if (up ? c[j].close < c[j].open : c[j].close > c[j].open) { ob = j; break; }
      if (ob < 0) ob = m;
      const o = { dir: up ? 'up' : 'down', i: ob, top: c[ob].high, bot: c[ob].low, at: e.i, end: null };
      for (let j = e.i + 1; j < c.length; j++) if (up ? c[j].close < o.bot : c[j].close > o.top) { o.end = j; break; }
      out.push(o);
    }
    return out;
  }
  // EMA cepat & lambat + titik silang: buy = cepat memotong ke atas lambat, sell = cepat memotong ke bawah
  function emaCross(v, f, s) {
    const a = ema(v, f), b = ema(v, s), sig = [];
    for (let i = 1; i < v.length; i++) {
      if (!nz(a[i]) || !nz(b[i]) || !nz(a[i - 1]) || !nz(b[i - 1])) continue;
      if (a[i - 1] <= b[i - 1] && a[i] > b[i]) sig.push({ i, side: 'buy' }); else if (a[i - 1] >= b[i - 1] && a[i] < b[i]) sig.push({ i, side: 'sell' });
    }
    return { fast: a, slow: b, sig };
  }

  return { sma, ema, macd, stoch, fib, fibLine, FIB_STYLE, RATIOS, nz, bb, rsi, isPivot, structure, orderBlocks, emaCross };
});
