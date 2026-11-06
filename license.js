// Lisensi Veramas: kunci terikat ke satu komputer (installId), dicek ke server lisensi.
// Mode simulasi selalu gratis. Mode LIVE (dana sungguhan) dan order baru butuh lisensi aktif.
// Jika server lisensi tidak bisa dihubungi, lisensi tetap berlaku sampai LICENSE_GRACE_DAYS hari
// sejak pengecekan sukses terakhir (bawaan 30 hari), lalu dianggap tidak aktif.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400e3;
const KEY_RE = /^TBP-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

function createLicense(opts) {
  const dataDir = opts.dataDir;
  const serverUrl = String(opts.serverUrl || '').replace(/\/$/, '');
  const graceMs = (+opts.graceDays || 30) * DAY;
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetch || globalThis.fetch;
  const version = opts.version || 'dev';
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const LF = path.join(dataDir, 'license.json');
  const IF = path.join(dataDir, 'install.json');

  function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
  function writeJson(f, v) {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); }
    catch (e) { console.warn('Gagal simpan lisensi:', e.message); }
  }

  // ID perangkat acak, dibuat sekali. Ikut terbawa saat zip diekstrak menimpa folder (data tidak dihapus).
  let inst = readJson(IF, null);
  if (!inst || !inst.installId) { inst = { installId: crypto.randomUUID(), createdAt: now() }; writeJson(IF, inst); }
  const installId = inst.installId;

  let L = readJson(LF, null) || {};
  const save = () => writeJson(LF, L);

  function keyShape(k) { return KEY_RE.test(String(k || '').trim().toUpperCase()); }

  // Keadaan efektif dari data tersimpan, tanpa menghubungi server.
  function effective() {
    const t = now();
    if (!L.key) return { active: false, reason: 'no-key' };
    if (L.revoked) return { active: false, reason: 'revoked' };
    if (!L.lastOk) return { active: false, reason: 'never-checked' };
    if (L.expiresAt && t >= L.expiresAt) return { active: false, reason: 'expired' };
    if (!L.active) return { active: false, reason: L.reason || 'inactive' };
    const graceUntil = L.lastOk + graceMs;
    if (t > graceUntil) return { active: false, reason: 'grace-over' };
    return { active: true, reason: 'ok', graceUntil };
  }

  // LICENSE_DISABLED=1 menonaktifkan pengecekan lisensi (mode LIVE terbuka untuk semua). Default: lisensi aktif.
  const DISABLED = /^(1|true|yes)$/i.test(String(process.env.LICENSE_DISABLED || ''));
  function canLive() { return DISABLED ? true : effective().active; }

  function status() {
    const e = effective(), t = now();
    const daysLeft = L.expiresAt ? Math.max(0, Math.ceil((L.expiresAt - t) / DAY)) : null;
    return {
      hasKey: !!L.key,
      keyMasked: L.key ? L.key.slice(0, 4) + '-••••-••••-••••-' + L.key.slice(-4) : null,
      active: e.active,
      reason: e.reason,
      expiresAt: L.expiresAt || null,
      daysLeft,
      lastCheck: L.lastOk || null,
      graceUntil: e.graceUntil || (L.lastOk ? L.lastOk + graceMs : null),
      serverConfigured: !!serverUrl,
      serverError: L.serverError || null,
      installShort: installId.slice(0, 8),
      plan: L.plan || null,
    };
  }

  async function post(p, body) {
    if (!serverUrl) throw Object.assign(new Error('Server lisensi belum diatur (LICENSE_SERVER)'), { noServer: true });
    const r = await fetchImpl(serverUrl + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, installId, version }), signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
    let j = {}; try { j = await r.json(); } catch (e) { }
    return { status: r.status, body: j };
  }

  // Aktivasi: ikat kunci ke komputer ini.
  async function activate(rawKey) {
    const key = String(rawKey || '').trim().toUpperCase();
    if (!keyShape(key)) throw new Error('Format kunci salah. Contoh: TBP-ABCD-EFGH-JKLM-NPQR');
    const r = await post('/api/activate', { key });
    if (r.status === 409) throw new Error(r.body.error || 'Kunci ini sudah dipakai di komputer lain. Minta reset ke admin.');
    if (r.status !== 200 || !r.body.active) throw new Error(r.body.error || ('Kunci tidak aktif (' + (r.body.reason || r.status) + ')'));
    L = { key, plan: r.body.plan || null, lastOk: now(), active: true, revoked: false, expiresAt: r.body.expiresAt || null, reason: 'ok', serverError: null };
    save(); onChange();
    return status();
  }

  // Pengecekan berkala ke server. Jika server tidak bisa dihubungi, kondisi tersimpan dipakai.
  async function check() {
    if (!L.key) return status();
    try {
      const r = await post('/api/check', { key: L.key });
      if (r.status === 200) {
        if (r.body.active) {
          L.active = true; L.revoked = false; L.lastOk = now(); L.reason = 'ok'; L.expiresAt = r.body.expiresAt || L.expiresAt; L.plan = r.body.plan || L.plan; L.serverError = null;
        } else {
          L.active = false; L.reason = r.body.reason || 'inactive'; L.lastOk = now(); L.serverError = null;
          if (r.body.reason === 'revoked') L.revoked = true;
          if (r.body.reason === 'bound-other') L.reason = 'bound-other';
        }
      } else {
        L.serverError = r.body.error || ('HTTP ' + r.status);
      }
    } catch (e) {
      L.serverError = e.noServer ? e.message : 'Tidak bisa menjangkau server lisensi';
    }
    save(); onChange();
    return status();
  }

  let timer = null;
  function start(intervalMs) {
    if (!serverUrl) return;
    const first = setTimeout(() => { check().catch(() => {}); }, 5000); first.unref && first.unref();
    timer = setInterval(() => { check().catch(() => {}); }, intervalMs || DAY);
    timer.unref && timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function forget() { L = {}; save(); return status(); }

  return { installId, status, canLive, activate, check, start, stop, forget, keyShape, _state: () => L, KEY_RE };
}

module.exports = { createLicense, DAY };
