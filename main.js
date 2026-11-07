// Proces główny Electrona: okno, zapisy na dysku, sieć (TCP + wykrywanie UDP).
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const cp = require('child_process');

const DISC_PORT = 41234, GAME_PORT = 41235, GAME_ID = 'KlockiLas1';
let win = null;
let closing = false;

// ---------- zapisy ----------
// Zapisy leżą POZA folderem z grą (domyślnie %APPDATA%KlockiLaszapisy), dzięki czemu kopiowanie / podmiana
// folderu gry lub pliku EXE nigdy ich nie kasuje ani nie nadpisuje. Zmienna GRA_SAVE_DIR pozwala wskazać inny folder.
app.setName('KlockiLas');
function legacyDirs() { // gdzie wcześniejsze wersje trzymały zapisy (obok EXE)
  const d = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) d.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'zapisy'));
  d.push(path.join(path.dirname(process.execPath), 'zapisy'));
  d.push(path.join(__dirname, 'zapisy'));
  return d;
}
function saveDir() {
  const tryDirs = [];
  if (process.env.GRA_SAVE_DIR) tryDirs.push(process.env.GRA_SAVE_DIR);
  tryDirs.push(path.join(app.getPath('appData'), 'KlockiLas', 'zapisy'));
  tryDirs.push(path.join(app.getPath('userData'), 'zapisy'));
  for (const d of tryDirs) {
    try {
      fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK);
      migrateLegacy(d);
      return d;
    } catch (e) { /* następny */ }
  }
  return app.getPath('userData');
}
function migrateLegacy(dest) { // jednorazowo: skopiuj stare zapisy sprzed przeniesienia, jeśli nowych jeszcze nie ma
  try {
    if (fs.readdirSync(dest).some((f) => f.endsWith('.json'))) return;
    for (const old of legacyDirs()) {
      if (!fs.existsSync(old) || path.resolve(old) === path.resolve(dest)) continue;
      const files = fs.readdirSync(old).filter((f) => f.endsWith('.json'));
      if (!files.length) continue;
      for (const f of files) fs.copyFileSync(path.join(old, f), path.join(dest, f));
      return;
    }
  } catch (e) { /* nieważne */ }
}
let SAVE_DIR = null;
// ---------- zadania z zewnątrz (pliki JSON w folderze „zadania” obok zapisów) ----------
const tasksDir = () => path.join(path.dirname(SAVE_DIR), 'zadania');
const TASKS_README = `ZADANIA Z ZEWNĄTRZ – Klocki i Las
=================================

Tutaj możesz dodać własne zadania do gry. Wystarczy wrzucić do tego folderu plik z rozszerzeniem .json
(w grze: Ustawienia -> „Wczytaj ponownie zadania”, albo po prostu uruchom grę ponownie).
Zadania z plików pojawiają się obok zadań wbudowanych (mniej więcej co trzecie zadanie).

FORMAT
------
Plik to lista zadań (tablica JSON). Każde zadanie ma pola:

  "klasa"       – numer klasy (1-8) albo lista, np. [4, 5]. Gdy pominiesz – zadanie dla wszystkich klas.
  "pytanie"     – treść zadania.
  "odpowiedz"   – poprawna odpowiedź (liczba, np. 12 albo "3,5").
  "podpowiedz"  – (niepotrzebne) podpowiedź pokazywana po kliknięciu „Podpowiedź”.
  "typ"         – "liczba" (domyślnie), "ulamek" albo "wybor".

Typ "ulamek": "odpowiedz": "3/4" (uznawany także 6/8; dodaj "dokladnie": true, jeśli ułamek ma być skrócony).
Typ "wybor": podaj "opcje": ["a", "b", "c"] oraz "poprawna": 1 (numer opcji liczony od 0) albo tekst poprawnej opcji.

PRZYKŁAD (plik przyklad.json.txt – zmień nazwę na przyklad.json, żeby zadziałał)
------
[
  { "klasa": 5, "pytanie": "Ile to jest 7 · 8?", "odpowiedz": 56, "podpowiedz": "Tabliczka mnożenia." },
  { "klasa": [3, 4], "pytanie": "Która liczba jest największa?", "typ": "wybor", "opcje": ["101", "110", "99"], "poprawna": 1 },
  { "pytanie": "Ile to jest połowa z 3/4? (ułamek)", "typ": "ulamek", "odpowiedz": "3/8" }
]

Uwagi: plik zapisz w kodowaniu UTF-8. Błędne zadania są pomijane (w ustawieniach gry zobaczysz, ile wczytano).
`;
const TASKS_EXAMPLE = [
  { klasa: 5, pytanie: 'Ile to jest 7 · 8?', odpowiedz: 56, podpowiedz: 'Tabliczka mnożenia.' },
  { klasa: [3, 4], pytanie: 'Która liczba jest największa?', typ: 'wybor', opcje: ['101', '110', '99'], poprawna: 1 },
  { pytanie: 'Ile to jest połowa z 3/4? (ułamek)', typ: 'ulamek', odpowiedz: '3/8' },
];
function ensureTasksDir() {
  const d = tasksDir();
  try {
    fs.mkdirSync(d, { recursive: true });
    const r = path.join(d, 'CZYTAJ-MNIE.txt'); if (!fs.existsSync(r)) fs.writeFileSync(r, TASKS_README);
    const e = path.join(d, 'przyklad.json.txt'); if (!fs.existsSync(e)) fs.writeFileSync(e, JSON.stringify(TASKS_EXAMPLE, null, 2));
  } catch (err) { /* brak praw zapisu – trudno */ }
  return d;
}
// zadania z GitHuba: podpisana paczka zadania.json w repozytorium aktualizacji; zapamiętywana na dysku, żeby działała bez internetu
const onlineTasksFile = () => path.join(path.dirname(SAVE_DIR), 'zadania-online.json');
function readOnlineCache() {
  try {
    const f = onlineTasksFile(), m = verifyTasks(fs.readFileSync(f), fs.readFileSync(f + '.sig', 'utf8'));
    return { rev: String(m.rev || ''), tasks: m.tasks };
  } catch (e) { return null; }
}
ipcMain.handle('tasks:sync', async () => { // pobierz najnowsze zadania z GitHuba (po cichu; błąd = zostają zapamiętane)
  try {
    const t = '?t=' + Date.now(), buf = await fetchBuf(RAW + 'zadania.json' + t, 8000), sig = await fetchBuf(RAW + 'zadania.json.sig' + t, 8000);
    const m = verifyTasks(buf, sig.toString('utf8')), old = readOnlineCache();
    const changed = !old || old.rev !== String(m.rev || '');
    if (changed) { const f = onlineTasksFile(); fs.writeFileSync(f + '.tmp', buf); fs.writeFileSync(f + '.sig', sig); fs.renameSync(f + '.tmp', f); }
    return { ok: true, changed, count: m.tasks.length };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('tasks:load', () => {
  const d = ensureTasksDir(), files = [], tasks = [];
  const on = readOnlineCache();
  if (on) { files.push({ name: 'z GitHuba (automatycznie)', count: on.tasks.length }); tasks.push(...on.tasks); }
  try {
    for (const f of fs.readdirSync(d).filter((x) => x.toLowerCase().endsWith('.json'))) {
      try {
        let t = fs.readFileSync(path.join(d, f), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
        const arr = JSON.parse(t); const list = Array.isArray(arr) ? arr : (arr && Array.isArray(arr.zadania) ? arr.zadania : null);
        if (!list) throw new Error('plik musi zawierać listę zadań [ ... ]');
        files.push({ name: f, count: list.length }); tasks.push(...list);
      } catch (err) { files.push({ name: f, error: String(err.message).slice(0, 120) }); }
    }
  } catch (err) { /* pusty folder */ }
  return { dir: d, files, tasks };
});
ipcMain.on('tasks:openDir', () => { shell.openPath(ensureTasksDir()); });
const safe = (n) => String(n).replace(/[^a-zA-Z0-9_ąćęłńóśźżĄĆĘŁŃÓŚŹŻ-]/g, '_').slice(0, 40);
const bakDir = () => path.join(SAVE_DIR, 'kopie');
ipcMain.handle('save:dir', () => SAVE_DIR);
ipcMain.handle('save:read', (e, name) => {
  const f = path.join(SAVE_DIR, safe(name) + '.json');
  try {
    const t = fs.readFileSync(f, 'utf8'); JSON.parse(t); return t;
  } catch (err) {
    // plik brakuje albo jest uszkodzony (np. nagły koniec prądu) – spróbuj ostatniej kopii
    try { const t = fs.readFileSync(path.join(bakDir(), safe(name) + '.json'), 'utf8'); JSON.parse(t); return t; } catch (e2) { return null; }
  }
});
ipcMain.handle('save:write', (e, name, text) => {
  try {
    const f = path.join(SAVE_DIR, safe(name) + '.json');
    if (fs.existsSync(f)) { fs.mkdirSync(bakDir(), { recursive: true }); fs.copyFileSync(f, path.join(bakDir(), safe(name) + '.json')); }
    fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); return true;
  } catch (err) { return false; }
});
ipcMain.handle('save:list', (e, prefix) => {
  try { return fs.readdirSync(SAVE_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch (err) { return []; }
});
ipcMain.handle('save:delete', (e, name) => { try { fs.unlinkSync(path.join(SAVE_DIR, safe(name) + '.json')); return true; } catch (err) { return false; } });
ipcMain.on('save:openDir', () => { shell.openPath(SAVE_DIR); });
ipcMain.handle('sys:info', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  return { ips, test: process.env.GRA_TEST || null, host: os.hostname() };
});
ipcMain.on('sys:copy', (e, s) => { require('electron').clipboard.writeText(String(s).slice(0, 500)); });
// <cloud-client>
// Klient zapisów w chmurze: szyfrowanie po stronie gry i rozmowa z serwerem zapisów (server/saves.js na Mikrusie).
// Z hasła gracza (scrypt, 64 bajty) powstają DWA niezależne klucze: „auth” (dowód tożsamości dla serwera) i „enc” (szyfrowanie zapisu, nigdy nie opuszcza gry).
// Serwer widzi tylko auth i szyfrogram – nie zna hasła i nie przeczyta zapisów. Łączymy się wyłącznie przez HTTPS.
const cloud = (() => {
const crypto = require('crypto');


function deriveKeys(name, password) {
  const salt = Buffer.from('klocki-i-las-v1|' + String(name).trim().toLowerCase(), 'utf8');
  const k = crypto.scryptSync(String(password).normalize('NFKC'), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return { auth: k.subarray(0, 32).toString('base64'), enc: Buffer.from(k.subarray(32, 64)) };
}
const aad = (name, kind) => Buffer.from('klocki|' + String(name).trim().toLowerCase() + '|' + kind, 'utf8'); // wiąże szyfrogram z graczem i rodzajem zapisu
function encrypt(keys, name, kind, text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
  c.setAAD(aad(name, kind));
  const ct = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}
function decrypt(keys, name, kind, iv, ct) {
  const buf = Buffer.from(ct, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(iv, 'base64'));
  d.setAAD(aad(name, kind)); d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}

class CloudError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; Object.assign(this, extra || {}); } }
const CODES = { 401: 'auth', 404: 'none', 409: 'conflict', 413: 'full', 429: 'locked', 507: 'full' };

async function call(base, method, path, auth, body, opts = {}) {
  const u = new URL(base);
  if (u.protocol !== 'https:' && !opts.insecure) throw new CloudError('insecure', 'połączenie z serwerem zapisów musi być szyfrowane (https)');
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), opts.timeout || 25000);
  let r;
  try {
    r = await fetch(base.replace(/\/$/, '') + path, { method, signal: ac.signal, headers: { 'X-Auth': auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new CloudError('nonet', 'brak połączenia z serwerem zapisów'); } finally { clearTimeout(t); }
  let j = {}; try { j = await r.json(); } catch (e) { /* pusta odpowiedź */ }
  if (!r.ok) throw new CloudError(CODES[r.status] || 'server', j.error || ('błąd serwera ' + r.status), { rev: j.rev });
  return j;
}
const enc = encodeURIComponent;
async function push(base, name, keys, kind, text, rev, opts) {
  const { iv, ct } = encrypt(keys, name, kind, text);
  return call(base, 'PUT', `/v1/blob/${enc(name)}/${kind}`, keys.auth, { rev, iv, ct }, opts);
}
async function pull(base, name, keys, kind, opts) { // zwraca { rev, text } albo rzuca CloudError('none' | 'auth' | ...)
  const j = await call(base, 'GET', `/v1/blob/${enc(name)}/${kind}`, keys.auth, null, opts);
  let text; try { text = decrypt(keys, name, kind, j.iv, j.ct); } catch (e) { throw new CloudError('corrupt', 'zapis na serwerze jest uszkodzony albo zaszyfrowany innym hasłem'); }
  return { rev: j.rev, text };
}
const meta = (base, name, keys, opts) => call(base, 'GET', `/v1/meta/${enc(name)}`, keys.auth, null, opts);
const rekey = (base, name, oldKeys, newKeys, opts) => call(base, 'POST', `/v1/rekey/${enc(name)}`, oldKeys.auth, { newAuth: newKeys.auth }, opts);
const removeAccount = (base, name, keys, opts) => call(base, 'DELETE', `/v1/account/${enc(name)}`, keys.auth, null, opts);
return { deriveKeys, encrypt, decrypt, push, pull, meta, rekey, removeAccount, CloudError };
})();
// </cloud-client>

const CLOUD_URL = process.env.GRA_CLOUD || 'https://klockisave.mikrus.dev', CLOUD_OPTS = process.env.GRA_CLOUD ? { insecure: true } : {}; // GRA_CLOUD tylko do testów (adres http)
const cloudSessions = new Map(); // imię (małymi literami) -> klucze; tylko w pamięci, nigdy na dysku
const cname = (n) => String(n || '').trim().toLowerCase();
const cres = (e) => ({ ok: false, code: e.code || 'server', error: String(e.message || e), rev: e.rev });
ipcMain.handle('cloud:login', (e, name, pw) => { try { cloudSessions.set(cname(name), cloud.deriveKeys(name, pw)); return { ok: true }; } catch (err) { return cres(err); } });
ipcMain.on('cloud:logout', (e, name) => { cloudSessions.delete(cname(name)); });
ipcMain.handle('cloud:push', async (e, name, kind, text, rev) => {
  const k = cloudSessions.get(cname(name)); if (!k) return { ok: false, code: 'nosession' };
  if (typeof text !== 'string' || text.length > 12e6) return { ok: false, code: 'full' };
  try { await cloud.push(CLOUD_URL, name, k, kind, text, rev, CLOUD_OPTS); return { ok: true }; } catch (err) { return cres(err); }
});
ipcMain.handle('cloud:pull', async (e, name, kind) => {
  const k = cloudSessions.get(cname(name)); if (!k) return { ok: false, code: 'nosession' };
  try { const r = await cloud.pull(CLOUD_URL, name, k, kind, CLOUD_OPTS); return { ok: true, rev: r.rev, text: r.text }; } catch (err) { return cres(err); }
});
ipcMain.handle('cloud:meta', async (e, name) => {
  const k = cloudSessions.get(cname(name)); if (!k) return { ok: false, code: 'nosession' };
  try { return { ok: true, meta: await cloud.meta(CLOUD_URL, name, k, CLOUD_OPTS) }; } catch (err) { return cres(err); }
});
ipcMain.handle('cloud:rekey', async (e, name, newPw) => { // zmiana hasła: nowy klucz na serwerze (stare zapisy znikają – gra wyśle je ponownie)
  const old = cloudSessions.get(cname(name)), nk = cloud.deriveKeys(name, newPw);
  try { if (old) await cloud.rekey(CLOUD_URL, name, old, nk, CLOUD_OPTS); cloudSessions.set(cname(name), nk); return { ok: true, hadAccount: !!old }; } catch (err) { if (err.code === 'none') { cloudSessions.set(cname(name), nk); return { ok: true }; } return cres(err); }
});
ipcMain.handle('cloud:remove', async (e, name) => {
  const k = cloudSessions.get(cname(name)); if (!k) return { ok: false, code: 'nosession' };
  try { await cloud.removeAccount(CLOUD_URL, name, k, CLOUD_OPTS); return { ok: true }; } catch (err) { return cres(err); }
});
// hasła graczy: w profilu zapisujemy tylko sól i skrót (scrypt) – samego hasła nie da się odczytać
ipcMain.handle('pw:hash', (e, pw) => {
  const salt = crypto.randomBytes(16), hash = crypto.scryptSync(String(pw).slice(0, 100), salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
});
ipcMain.handle('pw:verify', (e, pw, rec) => {
  try {
    const hash = crypto.scryptSync(String(pw).slice(0, 100), Buffer.from(rec.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(hash, Buffer.from(rec.hash, 'base64'));
  } catch (err) { return false; }
});
ipcMain.on('sys:quit', () => { closing = true; app.quit(); });

// ---------- sieć ----------
let server = null, hostPort = 0, clients = new Map(), nextConn = 1, sock = null;
let bcastTimer = null, bcastSock = null, scanSock = null, hostInfo = { name: 'Gra', players: 1 };

function emit(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) onLine(l); }
    if (buf.length > 50e6) buf = '';
  };
}
function broadcastAddrs() {
  const out = new Set(['255.255.255.255', '127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
    if (i.family !== 'IPv4' || i.internal) continue;
    const ip = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
    out.add(ip.map((o, k) => (o | (~m[k] & 255))).join('.'));
  }
  return [...out];
}
// ---------- gra przez Internet (serwer pośredniczący) ----------
// Gospodarz łączy się z serwerem pośredniczącym i dostaje kod gry (np. ABC-DEF); koledzy wpisują kod. Nikt nie musi ustawiać routera.
// Serwer (server/relay.js) działa na Mikrusie; adres można zmienić zmienną GRA_RELAY (host:port) – np. do testów.
const RELAY = (process.env.GRA_RELAY || 'bob338.mikrus.xyz:20338').split(':'), RELAY_HOST = RELAY[0], RELAY_PORT = +RELAY[1] || 20338;
let relay = null;
function startRelay() { // zwraca { ok, code } albo { ok:false, error }; błąd nie przeszkadza w grze w sieci lokalnej
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    const s = net.connect({ host: RELAY_HOST, port: RELAY_PORT, timeout: 6000 });
    relay = s; s.setNoDelay(true);
    s.on('connect', () => { s.setTimeout(0); s.setKeepAlive(true, 20000); s.write(JSON.stringify({ op: 'host', g: GAME_ID }) + '\n'); });
    s.on('data', lineReader((l) => {
      let m; try { m = JSON.parse(l); } catch (err) { return; }
      if (m.t === 'hosted') fin({ ok: true, code: m.code });
      else if (m.t === 'err') fin({ ok: false, error: m.msg });
      else if (m.t === 'conn') {
        const id = m.conn;
        clients.set(id, { write: (line) => { try { s.write(JSON.stringify({ t: 'to', to: id, line: line.replace(/\n$/, '') }) + '\n'); } catch (err) { } }, destroy: () => { } });
        emit('net:conn', { conn: id });
      } else if (m.t === 'msg') { try { emit('net:msg', { from: m.from, msg: JSON.parse(m.m) }); } catch (err) { } }
      else if (m.t === 'disc') { clients.delete(m.conn); emit('net:disc', { conn: m.conn }); }
    }));
    s.on('timeout', () => { fin({ ok: false, error: 'brak połączenia z serwerem gry' }); s.destroy(); });
    s.on('error', (err) => fin({ ok: false, error: err.code || String(err.message) }));
    s.on('close', () => { fin({ ok: false, error: 'serwer zamknął połączenie' }); if (relay === s) { relay = null; for (const [id] of clients) if (id >= 1000) { clients.delete(id); emit('net:disc', { conn: id }); } emit('net:relayLost', {}); } });
  });
}
function stopHost() {
  if (relay) { try { relay.destroy(); } catch (e) { } relay = null; }
  if (bcastTimer) clearInterval(bcastTimer); bcastTimer = null;
  if (bcastSock) { try { bcastSock.close(); } catch (e) { } bcastSock = null; }
  for (const c of clients.values()) { try { c.destroy(); } catch (e) { } }
  clients.clear();
  if (server) { try { server.close(); } catch (e) { } server = null; }
}
function leave() {
  stopHost();
  if (sock) { try { sock.destroy(); } catch (e) { } sock = null; }
}
ipcMain.handle('net:host', async (e, info) => {
  leave();
  hostInfo = { name: info.name, players: 1, hid: Math.random().toString(36).slice(2, 10) };
  return new Promise((resolve) => {
    let port = GAME_PORT, tries = 0;
    const start = () => {
      server = net.createServer((c) => {
        const id = nextConn++;
        c.setNoDelay(true);
        clients.set(id, c);
        c.on('data', lineReader((l) => { try { emit('net:msg', { from: id, msg: JSON.parse(l) }); } catch (err) { } }));
        c.on('close', () => { clients.delete(id); emit('net:disc', { conn: id }); });
        c.on('error', () => { });
        emit('net:conn', { conn: id });
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && tries++ < 10) { port++; server.close(); start(); } else resolve({ ok: false, error: String(err.message) });
      });
      server.listen(port, '0.0.0.0', () => {
        hostPort = port;
        bcastSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        bcastSock.bind(0, () => {
          try { bcastSock.setBroadcast(true); } catch (err) { }
          const send = () => {
            const msg = Buffer.from(JSON.stringify({ g: GAME_ID, name: hostInfo.name, port: hostPort, players: hostInfo.players, hid: hostInfo.hid }));
            for (const a of broadcastAddrs()) { try { bcastSock.send(msg, DISC_PORT, a); } catch (err) { } }
          };
          send(); bcastTimer = setInterval(send, 1500);
          startRelay().then((r) => resolve({ ok: true, port: hostPort, code: r.ok ? r.code : null, relayError: r.ok ? null : r.error }));
        });
        bcastSock.on('error', () => { });
      });
    };
    start();
  });
});
ipcMain.on('net:setInfo', (e, info) => { hostInfo = { ...hostInfo, ...info }; });
ipcMain.handle('net:join', (e, ip, port) => {
  leave();
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect({ host: ip, port: port || GAME_PORT, timeout: 6000 });
    sock = s;
    s.setNoDelay(true);
    s.on('connect', () => { done = true; s.setTimeout(0); resolve({ ok: true }); });
    s.on('data', lineReader((l) => { try { emit('net:msg', { from: 0, msg: JSON.parse(l) }); } catch (err) { } }));
    s.on('timeout', () => { if (!done) { done = true; resolve({ ok: false, error: 'Przekroczono czas oczekiwania' }); } s.destroy(); });
    s.on('error', (err) => { if (!done) { done = true; resolve({ ok: false, error: err.code || String(err.message) }); } });
    s.on('close', () => { if (sock === s) sock = null; emit('net:closed', {}); });
  });
});
ipcMain.handle('net:joinCode', (e, code) => { // dołączenie przez Internet po kodzie gry
  leave();
  return new Promise((resolve) => {
    let done = false, ready = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    const s = net.connect({ host: RELAY_HOST, port: RELAY_PORT, timeout: 8000 });
    sock = s; s.setNoDelay(true);
    s.on('connect', () => { s.setTimeout(0); s.setKeepAlive(true, 20000); s.write(JSON.stringify({ op: 'join', g: GAME_ID, code: String(code || '').slice(0, 20) }) + '\n'); });
    s.on('data', lineReader((l) => {
      if (!ready) {
        let m; try { m = JSON.parse(l); } catch (err) { return; }
        if (m.t === 'ok') { ready = true; fin({ ok: true }); } else { fin({ ok: false, error: m.msg || 'błąd serwera' }); s.destroy(); }
        return;
      }
      try { emit('net:msg', { from: 0, msg: JSON.parse(l) }); } catch (err) { }
    }));
    s.on('timeout', () => { fin({ ok: false, error: 'Nie można połączyć się z serwerem gry (sprawdź internet)' }); s.destroy(); });
    s.on('error', (err) => fin({ ok: false, error: 'Nie można połączyć się z serwerem gry (' + (err.code || err.message) + ')' }));
    s.on('close', () => { fin({ ok: false, error: 'Serwer zamknął połączenie' }); if (sock === s) sock = null; emit('net:closed', {}); });
  });
});
ipcMain.on('net:send', (e, msg, to, except) => {
  const line = JSON.stringify(msg) + '\n';
  if (server) {
    for (const [id, c] of clients) { if ((to == null || to === id) && id !== except) { try { c.write(line); } catch (err) { } } }
  } else if (sock) { try { sock.write(line); } catch (err) { } }
});
ipcMain.on('net:leave', () => leave());
ipcMain.handle('net:scan', () => {
  if (scanSock) return true;
  scanSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  scanSock.on('message', (buf, rinfo) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m.g === GAME_ID) emit('net:found', { ip: rinfo.address, port: m.port, name: m.name, players: m.players, hid: m.hid });
    } catch (err) { }
  });
  scanSock.on('error', () => { try { scanSock.close(); } catch (e) { } scanSock = null; });
  try { scanSock.bind(DISC_PORT, '0.0.0.0'); } catch (e) { scanSock = null; return false; }
  return true;
});
ipcMain.on('net:stopScan', () => { if (scanSock) { try { scanSock.close(); } catch (e) { } scanSock = null; } });


// ---------- aktualizacje z GitHuba ----------
// Gra sprawdza plik update.json w repozytorium (wersja + lista plików z sumami SHA-256), pobiera zmienione pliki,
// sprawdza sumy, podmienia pliki w resources/app i uruchamia się ponownie. Zapisy graczy leżą gdzie indziej – nie są ruszane.
const crypto = require('crypto');
// Pliki aktualizacji leżą w osobnym, publicznym repozytorium (kod źródłowy jest w prywatnym). Sam podpis chroni przed podmianą.
const REPO = 'remikk77/klocki-i-las-aktualizacje', BRANCH = 'main';
const RAW = (process.env.GRA_UPDATE_URL && process.env.GRA_UPDATE_DIR) ? process.env.GRA_UPDATE_URL : `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`; // adres testowy działa tylko razem z GRA_UPDATE_DIR
const { verifyManifest, verifyTasks } = require('./update-verify.js');
function cmpVer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
function selfUpdateInfo() { // czy ta kopia gry może sama się podmienić?
  if (process.env.GRA_UPDATE_DIR) return { ok: true, dir: process.env.GRA_UPDATE_DIR }; // tylko do testów
  const exe = path.basename(process.execPath).toLowerCase();
  if (exe === 'electron.exe' || exe === 'electron') return { ok: false, why: 'uruchomiona z folderu programisty' };
  if (__dirname.includes('.asar')) return { ok: false, why: 'wersja instalacyjna – pliki są w archiwum' };
  return { ok: true, dir: __dirname };
}
async function fetchBuf(url, ms = 20000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { 'Cache-Control': 'no-cache' } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' (' + url.replace(RAW, '') + ')'); return Buffer.from(await r.arrayBuffer()); }
  finally { clearTimeout(t); }
}
// pobiera update.json i update.json.sig, sprawdza podpis cyfrowy; bez prawidłowego podpisu nic z aktualizacji nie jest używane
const getManifest = async () => {
  const t = '?t=' + Date.now(), [buf, sig] = [await fetchBuf(RAW + 'update.json' + t, 15000), await fetchBuf(RAW + 'update.json.sig' + t, 15000)];
  return verifyManifest(buf, sig.toString('utf8'));
};
const localVersion = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir || __dirname, 'package.json'), 'utf8')).version; } catch (e) { return app.getVersion(); } };
ipcMain.handle('update:check', async () => {
  try {
    const m = await getManifest(), info = selfUpdateInfo(), local = localVersion(info.ok ? info.dir : __dirname);
    return { ok: true, local, remote: m.version, newer: cmpVer(m.version, local) > 0, notes: m.notes || '', canApply: info.ok, why: info.why };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('update:apply', async () => {
  const info = selfUpdateInfo();
  if (!info.ok) return { ok: false, error: 'Ta kopia gry nie może sama się zaktualizować (' + info.why + ').' };
  const base = path.dirname(info.dir), stage = path.join(base, 'update-staging'), bak = path.join(base, 'update-backup');
  const swapped = [];
  try {
    const m = await getManifest();
    if (cmpVer(m.version, localVersion(info.dir)) <= 0) return { ok: false, error: 'To nie jest nowsza wersja niż zainstalowana.' }; // ochrona przed cofnięciem do starej wersji
    if (m.electron && String(m.electron) !== String(process.versions.electron.split('.')[0])) return { ok: false, error: `Nowa wersja wymaga nowszego środowiska Electron (${m.electron}) – pobierz cały folder gry.` };
    if (!Array.isArray(m.files) || !m.files.length) throw new Error('pusta lista plików');
    fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(bak, { recursive: true, force: true });
    // 1) pobierz i sprawdź wszystko do folderu tymczasowego – dopiero potem cokolwiek podmieniamy
    for (let i = 0; i < m.files.length; i++) {
      const f = m.files[i];
      if (!/^[A-Za-z0-9_\-./]+$/.test(f.path) || f.path.includes('..') || f.path.startsWith('/')) throw new Error('niedozwolona ścieżka: ' + f.path);
      emit('update:progress', { i: i + 1, n: m.files.length, name: f.path });
      const buf = await fetchBuf(RAW + f.path + '?t=' + Date.now(), 60000);
      if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) throw new Error('suma kontrolna nie zgadza się: ' + f.path);
      const dest = path.join(stage, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf);
    }
    // 2) kopia zapasowa i podmiana (w razie błędu – przywrócenie)
    for (const f of m.files) {
      const dest = path.join(info.dir, f.path), b = path.join(bak, f.path);
      if (fs.existsSync(dest)) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(dest, b); }
      swapped.push(f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(stage, f.path), dest + '.new'); fs.renameSync(dest + '.new', dest);
    }
    // 3) numer wersji zapisujemy na końcu – dopiero wtedy aktualizacja jest „skończona”
    const pj = path.join(info.dir, 'package.json'); let p = {}; try { p = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { p = { name: 'klocki-i-las', productName: 'KlockiLas', main: 'main.js' }; }
    p.version = m.version; fs.writeFileSync(pj, JSON.stringify(p, null, 2));
    fs.rmSync(stage, { recursive: true, force: true });
    if (!process.env.GRA_UPDATE_DIR) setTimeout(() => { closing = true; app.relaunch(); app.exit(0); }, 1800);
    return { ok: true, version: m.version };
  } catch (e) {
    for (const rel of swapped) { try { const b = path.join(bak, rel); if (fs.existsSync(b)) fs.copyFileSync(b, path.join(info.dir, rel)); } catch (e2) { /* trudno */ } }
    fs.rmSync(stage, { recursive: true, force: true });
    return { ok: false, error: String(e.message || e) };
  }
});

// ---------- miejsce instalacji ----------
// Przy pierwszym uruchomieniu (np. zaraz po aktualizacji ze starej wersji) gra pyta, gdzie ma być zainstalowana.
// Domyślnie: folder, w którym już jest. „OK” zostawia ją tam; „Zmień folder…” kopiuje całą grę we wskazane miejsce i uruchamia stamtąd.
// Zawsze powstaje skrót na pulpicie. Wybór zapamiętuje plik %APPDATA%\KlockiLas\install-dir.txt (instalator też go zapisuje).
const { dialog } = require('electron');
const installMarker = () => process.env.GRA_INSTALL_MARKER || path.join(app.getPath('appData'), 'KlockiLas', 'install-dir.txt'); // zmienna tylko do testów
function readInstallMarker() { try { return fs.readFileSync(installMarker(), 'utf8').trim() || null; } catch (e) { return null; } }
function writeInstallMarker(dir) { try { fs.mkdirSync(path.dirname(installMarker()), { recursive: true }); fs.writeFileSync(installMarker(), dir); } catch (e) { /* trudno */ } }
const desktopDir = () => process.env.GRA_DESKTOP_DIR || app.getPath('desktop'); // zmienna tylko do testów
function makeDesktopShortcut(exe) {
  try {
    shell.writeShortcutLink(path.join(desktopDir(), 'Klocki i Las.lnk'), 'create', { target: exe, cwd: path.dirname(exe), description: 'Klocki i Las – 99 nocy', icon: exe, iconIndex: 0 });
    return true;
  } catch (e) { return false; }
}
function isSameDir(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function resolveTarget(chosen) { // wybrany folder niepusty i bez gry w środku → zrób w nim podfolder „Klocki i Las”
  try {
    if (!fs.existsSync(chosen)) return chosen;
    const list = fs.readdirSync(chosen);
    if (!list.length || list.some((f) => f.toLowerCase() === 'klockilas.exe')) return chosen;
    return path.join(chosen, 'Klocki i Las');
  } catch (e) { return chosen; }
}
async function ensureInstallLocation() { // zwraca true, gdy uruchomiono kopię w nowym miejscu (ta instancja ma się zamknąć)
  const exe = process.execPath, cur = path.dirname(exe), base = path.basename(exe).toLowerCase();
  if (base === 'electron.exe' || base === 'electron') return false; // folder programisty
  if (!process.env.GRA_INSTALL_DIR && (process.env.GRA_SCRIPT || process.env.GRA_TEST || process.env.GRA_UPDATE_DIR)) return false; // testy automatyczne
  const known = readInstallMarker();
  if (known) { // jest już zapisany wybór; jeśli to ta kopia – upewnij się, że skrót istnieje
    if (isSameDir(known, cur) && !fs.existsSync(path.join(desktopDir(), 'Klocki i Las.lnk'))) makeDesktopShortcut(exe);
    return false;
  }
  let dest = cur;
  const forced = process.env.GRA_INSTALL_DIR; // tylko do testów (bez okien)
  if (forced) dest = resolveTarget(forced);
  else {
    for (;;) {
      const r = dialog.showMessageBoxSync({
        type: 'question', title: 'Klocki i Las – miejsce instalacji', message: 'Gdzie zainstalować grę?', defaultId: 0, cancelId: 0, noLink: true,
        detail: `Proponowany folder:\n${dest}\n\nKliknij „OK”, aby zainstalować tutaj (w tym folderze gra już jest), albo „Zmień folder…”, aby wybrać inne miejsce.\nPostępy graczy zostają – nie leżą w folderze gry. Na pulpicie pojawi się skrót.`,
        buttons: ['OK', 'Zmień folder…'],
      });
      if (r === 0) break;
      const pick = dialog.showOpenDialogSync({ title: 'Wybierz folder dla gry', defaultPath: path.dirname(dest), properties: ['openDirectory', 'createDirectory'] });
      if (pick && pick[0]) dest = resolveTarget(pick[0]);
    }
  }
  if (isSameDir(dest, cur)) { writeInstallMarker(cur); makeDesktopShortcut(exe); return false; }
  // kopiowanie całej gry (Electron + pliki) do nowego folderu
  if (path.resolve(dest).toLowerCase().startsWith(path.resolve(cur).toLowerCase() + path.sep)) { dialog.showErrorBox('Klocki i Las', 'Nie można instalować w podfolderze folderu, w którym gra już jest.'); return false; }
  const wait = new BrowserWindow({ width: 460, height: 170, frame: false, resizable: false, alwaysOnTop: true, backgroundColor: '#10151c', webPreferences: { sandbox: true } });
  wait.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#10151c;color:#fff;font:20px Segoe UI,Arial;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">Instaluję grę…<br>chwilę to potrwa ⏳</body>'));
  try {
    fs.mkdirSync(dest, { recursive: true });
    await fs.promises.cp(cur, dest, { recursive: true, force: true, filter: (s) => !/[\\/](update-staging|update-backup)([\\/]|$)/.test(s) });
    const newExe = path.join(dest, path.basename(exe));
    if (!fs.existsSync(newExe)) throw new Error('po kopiowaniu brakuje pliku ' + newExe);
    writeInstallMarker(dest); makeDesktopShortcut(newExe);
    wait.destroy();
    if (!forced) dialog.showMessageBoxSync({ type: 'info', title: 'Klocki i Las', message: 'Gra zainstalowana!', detail: `Nowe miejsce:\n${dest}\n\nNa pulpicie jest skrót „Klocki i Las”. Gra uruchomi się teraz z nowego miejsca.\nStary folder (${cur}) możesz usunąć – zapisy graczy zostają.`, buttons: ['OK'] });
    const child = cp.spawn(newExe, [], { detached: true, stdio: 'ignore', cwd: dest }); child.unref();
    return true;
  } catch (e) {
    try { wait.destroy(); } catch (e2) { /* nieważne */ }
    if (!forced) dialog.showErrorBox('Klocki i Las', 'Nie udało się zainstalować w nowym miejscu:\n' + (e.message || e) + '\n\nGra uruchomi się z obecnego folderu.');
    else console.log('INSTALL ERROR', e.message || e);
    return false;
  }
}

// ---------- okno ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 760, minWidth: 900, minHeight: 600, backgroundColor: '#10151c', title: 'Klocki i Las – 99 nocy',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    closing = true;
    emit('app:closing', {});
    setTimeout(() => { app.quit(); }, 7500);
  });
  win.webContents.on('console-message', (e, level, message) => { if (process.env.GRA_TEST) console.log('[renderer]', message); });
  if (process.env.GRA_SCRIPT) { // tylko do testów automatycznych: uruchom skrypt w oknie gry, gdy gra jest gotowa
    win.webContents.on('did-finish-load', () => {
      let code = ''; try { code = fs.readFileSync(process.env.GRA_SCRIPT, 'utf8'); } catch (e) { return; }
      const run = `(async()=>{ for(let i=0;i<400&&!window.__T;i++) await new Promise(r=>setTimeout(r,100)); if(!window.__T) return; const {S,P,keys,mobs,H,THREE,B,SEA,SPAWN,weather,villagers,villagesNear,villagerScreen,craftScreen,mainMenu,tryPlace,useBlock,getTarget}=window.__T; const world=window.__T.world; ${code}
})().catch(e=>console.log('SCRIPT ERROR '+e.message))`;
      win.webContents.executeJavaScript(run).catch((e) => console.log('SCRIPT ERROR', e.message));
    });
  }
  if (process.env.GRA_SHOT) {
    const [delay, file] = process.env.GRA_SHOT.split('|');
    setTimeout(async () => {
      for (let i = 0; i < 6; i++) {
        try {
          win.show(); win.focus();
          const img = await win.webContents.capturePage();
          fs.writeFileSync(file, img.toPNG());
          console.log('SHOT saved', file);
          break;
        } catch (e) { console.log('shot retry', e.message); await new Promise((r) => setTimeout(r, 1000)); }
      }
      if (process.env.GRA_EXIT) { closing = true; app.quit(); }
    }, Number(delay));
  }
}
ipcMain.on('app:closeReady', () => { closing = true; app.quit(); });

app.whenReady().then(async () => {
  SAVE_DIR = saveDir();
  let moved = false;
  try { moved = await ensureInstallLocation(); } catch (e) { console.log('install error', e.message); }
  if (moved) { closing = true; app.exit(0); return; }
  createWindow();
});
app.on('window-all-closed', () => { leave(); app.quit(); });
