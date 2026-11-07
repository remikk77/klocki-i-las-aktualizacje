// Weryfikacja aktualizacji: plik update.json musi być podpisany kluczem prywatnym autora (Ed25519).
// Klucz publiczny jest wpisany tutaj; klucz prywatny leży tylko u autora (poza repozytorium i poza GitHubem),
// więc nawet po przejęciu konta GitHub nikt nie przygotuje aktualizacji, którą gra uzna za prawdziwą.
const crypto = require('crypto');

const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEA1/Hht0N8+SCnQTuhSIOBir3D5+Ddci6t9Q+dt/+NAmI=';
const PRODUCT = 'klocki-i-las';
const ALLOWED = /^(main\.js|preload\.js|update-verify\.js|renderer\/(index\.html|style\.css|bundle\.js))$/; // tylko te pliki wolno podmienić

function publicKey(der) { return crypto.createPublicKey({ key: Buffer.from(der || PUBLIC_KEY_DER_B64, 'base64'), format: 'der', type: 'spki' }); }

// manifestBuf – dokładne bajty pobranego update.json, sigB64 – zawartość update.json.sig. Zwraca obiekt manifestu albo rzuca błąd.
function verifyManifest(manifestBuf, sigB64, keyDerB64) {
  let ok = false;
  try { ok = crypto.verify(null, manifestBuf, publicKey(keyDerB64), Buffer.from(String(sigB64).trim(), 'base64')); } catch (e) { ok = false; }
  if (!ok) throw new Error('podpis aktualizacji jest nieprawidłowy – aktualizacja odrzucona');
  const m = JSON.parse(manifestBuf.toString('utf8'));
  if (m.product !== PRODUCT) throw new Error('to nie jest aktualizacja tej gry');
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version))) throw new Error('nieprawidłowy numer wersji');
  if (!Array.isArray(m.files) || !m.files.length) throw new Error('pusta lista plików');
  for (const f of m.files) {
    if (!ALLOWED.test(f.path)) throw new Error('niedozwolony plik w aktualizacji: ' + f.path);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error('nieprawidłowa suma kontrolna: ' + f.path);
  }
  return m;
}

// Paczka zadań (zadania.json + zadania.json.sig) – podpisana tym samym kluczem co aktualizacje. To same dane (tekst), nie kod,
// ale podpis chroni przed podrzuceniem własnych „zadań” przez kogoś, kto przejąłby konto GitHub.
function verifyTasks(buf, sigB64, keyDerB64) {
  let ok = false;
  try { ok = crypto.verify(null, buf, publicKey(keyDerB64), Buffer.from(String(sigB64).trim(), 'base64')); } catch (e) { ok = false; }
  if (!ok) throw new Error('podpis zadań jest nieprawidłowy – zadania odrzucone');
  if (buf.length > 3e6) throw new Error('paczka zadań jest za duża');
  const m = JSON.parse(buf.toString('utf8'));
  if (m.product !== PRODUCT || m.kind !== 'zadania') throw new Error('to nie jest paczka zadań tej gry');
  if (!Array.isArray(m.tasks)) throw new Error('brak listy zadań');
  return m;
}

module.exports = { verifyManifest, verifyTasks, ALLOWED, PUBLIC_KEY_DER_B64 };
