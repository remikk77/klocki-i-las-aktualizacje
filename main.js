// Proces główny Electrona: okno, zapisy na dysku, sieć (TCP + wykrywanie UDP).
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const os = require('os');

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
ipcMain.handle('tasks:load', () => {
  const d = ensureTasksDir(), files = [], tasks = [];
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
function stopHost() {
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
          resolve({ ok: true, port: hostPort });
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
const { verifyManifest } = require('./update-verify.js');
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
    setTimeout(() => { app.quit(); }, 2500);
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

app.whenReady().then(() => {
  SAVE_DIR = saveDir();
  createWindow();
});
app.on('window-all-closed', () => { leave(); app.quit(); });
