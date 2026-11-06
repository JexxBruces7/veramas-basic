"""Jembatan MetaTrader 5 untuk Veramas (opsional).

Menyajikan harga bid/ask dan candle dari terminal MetaTrader 5 Anda ke Veramas (menu Forex),
hanya di komputer ini (http://127.0.0.1:5005). Tidak mengirim order.

Syarat:
  1. Windows dengan terminal MetaTrader 5 terpasang, terbuka, dan sudah login ke akun broker.
  2. Python 3.9+  lalu:  pip install MetaTrader5
Jalankan:  python mt5_bridge.py      (atau klik mt5_bridge.bat)
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import MetaTrader5 as mt5
except ImportError:
    raise SystemExit('Paket MetaTrader5 belum terpasang. Jalankan:  pip install MetaTrader5')

HOST, PORT = '127.0.0.1', 5005
TF = {'M1': mt5.TIMEFRAME_M1, 'M5': mt5.TIMEFRAME_M5, 'M15': mt5.TIMEFRAME_M15, 'M30': mt5.TIMEFRAME_M30, 'H1': mt5.TIMEFRAME_H1,
      'H4': mt5.TIMEFRAME_H4, 'D1': mt5.TIMEFRAME_D1, 'W1': mt5.TIMEFRAME_W1, 'MN1': mt5.TIMEFRAME_MN1}
_cache = {}


def find_symbol(name):
    """Cari simbol di broker (mis. EURUSD bisa bernama EURUSD.m atau EURUSDm)."""
    name = name.strip().upper()
    if name in _cache:
        return _cache[name]
    real = None
    if mt5.symbol_info(name) is not None:
        real = name
    else:
        for s in (mt5.symbols_get('*' + name + '*') or []):
            if s.name.upper().startswith(name) or s.name.upper().replace('.', '').startswith(name):
                real = s.name
                break
        if real is None and name == 'XAUUSD':
            for alt in ('GOLD', 'XAUUSD.', 'GOLD.'):
                if mt5.symbol_info(alt) is not None:
                    real = alt
                    break
    _cache[name] = real
    return real


def quotes(symbols):
    out = []
    for s in symbols:
        real = find_symbol(s)
        if not real:
            continue
        mt5.symbol_select(real, True)
        t, info = mt5.symbol_info_tick(real), mt5.symbol_info(real)
        if t is None or info is None:
            continue
        d1 = mt5.copy_rates_from_pos(real, mt5.TIMEFRAME_D1, 1, 1)
        prev = float(d1[0]['close']) if d1 is not None and len(d1) else None
        out.append({'symbol': real, 'bid': t.bid, 'ask': t.ask, 'time': t.time, 'spread': info.spread, 'digits': info.digits, 'prev_close': prev})
    return out


def rates(symbol, tf, n):
    real = find_symbol(symbol) or symbol
    mt5.symbol_select(real, True)
    r = mt5.copy_rates_from_pos(real, TF.get(tf, mt5.TIMEFRAME_H1), 0, max(10, min(int(n), 2000)))
    if r is None:
        return []
    return [{'time': int(x['time']), 'open': float(x['open']), 'high': float(x['high']), 'low': float(x['low']), 'close': float(x['close'])} for x in r]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == '/quotes':
                return self._send(200, quotes([s for s in q.get('symbols', [''])[0].split(',') if s]))
            if u.path == '/rates':
                return self._send(200, rates(q.get('symbol', ['EURUSD'])[0], q.get('tf', ['H1'])[0], q.get('n', ['200'])[0]))
            if u.path == '/':
                acc = mt5.account_info()
                return self._send(200, {'ok': True, 'server': acc.server if acc else None})
            self._send(404, {'error': 'tidak ditemukan'})
        except Exception as e:  # noqa: BLE001
            self._send(500, {'error': str(e)})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    if not mt5.initialize():
        raise SystemExit('Tidak bisa terhubung ke terminal MetaTrader 5: ' + str(mt5.last_error()) + '. Buka MT5 dan login dulu.')
    acc = mt5.account_info()
    print('Terhubung ke MetaTrader 5' + (' (' + acc.server + ')' if acc else '') + '. Jembatan aktif di http://%s:%d . Tekan Ctrl+C untuk berhenti.' % (HOST, PORT))
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    finally:
        mt5.shutdown()
