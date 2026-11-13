'use strict';
/* Server billiard: akun, koin, toko stik, teman, matchmaking acak, pertandingan realtime (SSE).
   Tanpa dependensi: cukup `node server.js`. Server mensimulasikan setiap tembakan (otoritatif). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./public/physics.js');

const PORT = +process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const PUB = path.join(__dirname, 'public');

const START_COINS = 500, WIN_REWARD = 100, LOSE_REWARD = 20;
const AIM_MS = 75000, GRACE_MS = 4000, DISCONNECT_MS = 30000;

const CUES = [
  { id: 'kayu',   name: 'Kayu Standar', price: 0,    power: 1.00, guide: 70,  english: 0.60, color: '#a0722d' },
  { id: 'maple',  name: 'Maple Klasik', price: 250,  power: 1.04, guide: 90,  english: 0.65, color: '#d9b779' },
  { id: 'ebony',  name: 'Ebony Hitam',  price: 500,  power: 1.08, guide: 110, english: 0.70, color: '#222222' },
  { id: 'rubi',   name: 'Merah Rubi',   price: 800,  power: 1.11, guide: 130, english: 0.75, color: '#c0182d' },
  { id: 'safir',  name: 'Biru Safir',   price: 1200, power: 1.15, guide: 150, english: 0.80, color: '#1d4ed8' },
  { id: 'zamrud', name: 'Zamrud Hijau', price: 1700, power: 1.19, guide: 170, english: 0.85, color: '#059669' },
  { id: 'royal',  name: 'Emas Royal',   price: 2400, power: 1.23, guide: 190, english: 0.90, color: '#d4a017' },
  { id: 'karbon', name: 'Karbon Pro',   price: 3200, power: 1.27, guide: 210, english: 0.94, color: '#4b5563' },
  { id: 'naga',   name: 'Naga Api',     price: 4300, power: 1.31, guide: 240, english: 0.97, color: '#ea580c' },
  { id: 'galaxy', name: 'Galaxy Neon',  price: 6000, power: 1.35, guide: 280, english: 1.00, color: '#a855f7' },
];
const cueById = id => CUES.find(c => c.id === id);

/* ---------- database sederhana (file JSON) ---------- */
let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* baru */ }
db.users = db.users || {}; db.sessions = db.sessions || {};
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), e => { if (!e) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); });
  }, 300);
}
const getU = key => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(db.users, 'u_' + key)) ? db.users['u_' + key] : null;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/* ---------- util HTTP ---------- */
class HttpErr extends Error { constructor(s, m) { super(m); this.status = s; } }
const err = (s, m) => new HttpErr(s, m);
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) { reject(err(413, 'Terlalu besar')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(err(400, 'JSON tidak valid')); } });
    req.on('error', reject);
  });
}
const num = v => { const n = Number(v); if (!Number.isFinite(n)) throw err(400, 'Angka tidak valid'); return n; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- state runtime ---------- */
const clients = new Map();     // key -> Set(res)
const queue = [];              // key[]
const matches = new Map();     // id -> match
const userMatch = new Map();   // key -> matchId
const invites = new Map();     // target key -> {from, exp}
const attempts = new Map();    // ip -> [timestamps]

const isOnline = k => clients.has(k) && clients.get(k).size > 0;
function sendTo(key, event, data) {
  const set = clients.get(key); if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of set) r.write(msg);
}
function notifyFriends(key) {
  const u = getU(key); if (!u) return;
  for (const f of u.friends) sendTo(f, 'friend_update', {});
}
const currentMatch = key => { const id = userMatch.get(key); return id ? matches.get(id) : null; };

/* ---------- auth ---------- */
function auth(ctx) {
  const h = ctx.req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (ctx.url.searchParams.get('token') || '');
  if (!Object.prototype.hasOwnProperty.call(db.sessions, tok)) throw err(401, 'Sesi tidak valid, silakan masuk lagi');
  const key = db.sessions[tok].u, u = getU(key);
  if (!u) throw err(401, 'Akun tidak ditemukan');
  return { key, u, tok };
}
function throttle(ip) {
  const now = Date.now();
  const arr = (attempts.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 15) throw err(429, 'Terlalu banyak percobaan, coba lagi sebentar');
  arr.push(now); attempts.set(ip, arr);
}
function newSession(key) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[tok] = { u: key, t: Date.now() };
  save();
  return tok;
}
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }

/* ---------- profil ---------- */
function matchPayload(m, key) {
  const idx = m.players.indexOf(key);
  return {
    matchId: m.id, seed: m.seed, you: idx,
    players: m.players.map(k => ({ name: getU(k).name, cue: getU(k).cue })),
    state: B.snapshot(m.balls, m.game, ''),
  };
}
function profile(key) {
  const u = getU(key), m = currentMatch(key);
  return {
    name: u.name, coins: u.coins, owned: u.owned, cue: u.cue, wins: u.wins, losses: u.losses,
    friends: u.friends.map(f => ({ name: getU(f).name, online: isOnline(f), busy: userMatch.has(f) })),
    incoming: u.incoming.map(f => getU(f).name),
    outgoing: u.outgoing.map(f => getU(f).name),
    queued: queue.includes(key),
    inMatch: !!m,
  };
}
function findByName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) return null;
  const key = n.toLowerCase(), u = getU(key);
  return u ? { key, u } : null;
}

/* ---------- pertandingan ---------- */
function createMatch(a, b) {
  const order = Math.random() < 0.5 ? [a, b] : [b, a];
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  const m = {
    id: crypto.randomBytes(6).toString('hex'), players: order, seed,
    balls: B.makeBalls(seed), game: B.newGame(),
    deadline: Date.now() + AIM_MS + GRACE_MS, over: false, dc: [null, null],
  };
  matches.set(m.id, m);
  for (const k of order) {
    userMatch.set(k, m.id);
    const qi = queue.indexOf(k); if (qi >= 0) queue.splice(qi, 1);
    invites.delete(k);
  }
  for (const k of order) { sendTo(k, 'match_found', matchPayload(m, k)); notifyFriends(k); }
  return m;
}
function endMatch(m, winnerIdx, reason) {
  if (m.over) return;
  m.over = true;
  m.dc.forEach(t => t && clearTimeout(t));
  const out = [];
  m.players.forEach((k, i) => {
    const u = getU(k), won = i === winnerIdx;
    const reward = won ? WIN_REWARD : LOSE_REWARD;
    u.coins += reward;
    if (won) u.wins++; else u.losses++;
    userMatch.delete(k);
    out.push({ k, d: { matchId: m.id, winner: winnerIdx, reason, won, reward, coins: u.coins } });
  });
  save();
  matches.delete(m.id);
  for (const o of out) { sendTo(o.k, 'match_end', o.d); sendTo(o.k, 'friend_update', {}); notifyFriends(o.k); }
}
function getMatch(key, id) {
  const m = currentMatch(key);
  if (!m || m.id !== id || m.over) throw err(404, 'Pertandingan tidak ditemukan');
  return m;
}

function onOffline(key) {
  const qi = queue.indexOf(key); if (qi >= 0) queue.splice(qi, 1);
  notifyFriends(key);
  const m = currentMatch(key);
  if (m) {
    const idx = m.players.indexOf(key);
    sendTo(m.players[1 - idx], 'opponent_status', { online: false, seconds: DISCONNECT_MS / 1000 });
    clearTimeout(m.dc[idx]);
    m.dc[idx] = setTimeout(() => { if (!isOnline(key)) endMatch(m, 1 - idx, 'disconnect'); }, DISCONNECT_MS);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const m of [...matches.values()]) if (!m.over && now > m.deadline) endMatch(m, 1 - m.game.turn, 'timeout');
  for (const [k, v] of invites) if (now > v.exp) invites.delete(k);
}, 2000);

/* ---------- rute API ---------- */
const authed = fn => ctx => fn(auth(ctx), ctx.body, ctx);
const routes = {
  'GET /api/catalog': () => ({ cues: CUES, rewards: { win: WIN_REWARD, lose: LOSE_REWARD } }),

  'POST /api/register': ctx => {
    throttle(ctx.ip);
    const name = String(ctx.body.name || '').trim(), pw = String(ctx.body.password || '');
    if (!NAME_RE.test(name)) throw err(400, 'Nama 3-16 karakter: huruf, angka, garis bawah');
    if (pw.length < 6 || pw.length > 64) throw err(400, 'Password 6-64 karakter');
    const key = name.toLowerCase();
    if (getU(key)) throw err(409, 'Nama sudah dipakai');
    const salt = crypto.randomBytes(16).toString('hex');
    db.users['u_' + key] = {
      name, salt, hash: hashPw(pw, salt), coins: START_COINS, owned: ['kayu'], cue: 'kayu',
      friends: [], incoming: [], outgoing: [], wins: 0, losses: 0, created: Date.now(),
    };
    save();
    return { token: newSession(key), name };
  },
  'POST /api/login': ctx => {
    throttle(ctx.ip);
    const name = String(ctx.body.name || '').trim(), pw = String(ctx.body.password || '');
    const key = name.toLowerCase(), u = NAME_RE.test(name) ? getU(key) : null;
    if (!u) throw err(401, 'Nama atau password salah');
    const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw err(401, 'Nama atau password salah');
    return { token: newSession(key), name: u.name };
  },
  'POST /api/logout': authed(a => { delete db.sessions[a.tok]; save(); return { ok: true }; }),
  'GET /api/me': authed(a => profile(a.key)),

  'POST /api/shop/buy': authed((a, b) => {
    const c = cueById(b.cue);
    if (!c) throw err(404, 'Stik tidak ada');
    if (a.u.owned.includes(c.id)) throw err(400, 'Sudah dimiliki');
    if (a.u.coins < c.price) throw err(400, 'Koin tidak cukup');
    a.u.coins -= c.price; a.u.owned.push(c.id); save();
    return profile(a.key);
  }),
  'POST /api/shop/equip': authed((a, b) => {
    if (userMatch.has(a.key)) throw err(400, 'Tidak bisa ganti stik saat bertanding');
    const c = cueById(b.cue);
    if (!c || !a.u.owned.includes(c.id)) throw err(400, 'Stik belum dimiliki');
    a.u.cue = c.id; save();
    return profile(a.key);
  }),

  'POST /api/friends/add': authed((a, b) => {
    const t = findByName(b.name);
    if (!t) throw err(404, 'Pemain tidak ditemukan');
    if (t.key === a.key) throw err(400, 'Tidak bisa menambah diri sendiri');
    if (a.u.friends.includes(t.key)) throw err(400, 'Sudah berteman');
    if (a.u.incoming.includes(t.key)) { becomeFriends(a.key, t.key); return { status: 'friends' }; }
    if (!a.u.outgoing.includes(t.key)) { a.u.outgoing.push(t.key); t.u.incoming.push(a.key); save(); }
    sendTo(t.key, 'friend_update', {});
    sendTo(t.key, 'toast', { text: `${a.u.name} mengajak berteman` });
    return { status: 'requested' };
  }),
  'POST /api/friends/accept': authed((a, b) => {
    const t = findByName(b.name);
    if (!t || !a.u.incoming.includes(t.key)) throw err(404, 'Permintaan tidak ada');
    becomeFriends(a.key, t.key);
    return { ok: true };
  }),
  'POST /api/friends/decline': authed((a, b) => {   // tolak masuk / batalkan keluar
    const t = findByName(b.name);
    if (!t) throw err(404, 'Pemain tidak ditemukan');
    const rm = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
    rm(a.u.incoming, t.key); rm(t.u.outgoing, a.key); rm(a.u.outgoing, t.key); rm(t.u.incoming, a.key);
    save(); sendTo(t.key, 'friend_update', {});
    return { ok: true };
  }),
  'POST /api/friends/remove': authed((a, b) => {
    const t = findByName(b.name);
    if (!t) throw err(404, 'Pemain tidak ditemukan');
    const rm = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
    rm(a.u.friends, t.key); rm(t.u.friends, a.key);
    save(); sendTo(t.key, 'friend_update', {});
    return { ok: true };
  }),

  'POST /api/queue/join': authed(a => {
    if (userMatch.has(a.key)) throw err(400, 'Kamu sedang bertanding');
    if (queue.includes(a.key)) return { status: 'queued' };
    const others = queue.filter(k => k !== a.key && isOnline(k) && !userMatch.has(k));
    if (others.length) {
      const o = others[Math.floor(Math.random() * others.length)];
      createMatch(o, a.key);
      return { status: 'matched' };
    }
    queue.push(a.key);
    return { status: 'queued' };
  }),
  'POST /api/queue/leave': authed(a => { const i = queue.indexOf(a.key); if (i >= 0) queue.splice(i, 1); return { ok: true }; }),

  'POST /api/challenge': authed((a, b) => {
    const t = findByName(b.name);
    if (!t || !a.u.friends.includes(t.key)) throw err(400, 'Hanya bisa menantang teman');
    if (!isOnline(t.key)) throw err(400, 'Teman sedang offline');
    if (userMatch.has(t.key) || userMatch.has(a.key)) throw err(400, 'Salah satu sedang bertanding');
    const qi = queue.indexOf(a.key); if (qi >= 0) queue.splice(qi, 1);
    invites.set(t.key, { from: a.key, exp: Date.now() + 30000 });
    sendTo(t.key, 'invite', { from: a.u.name });
    return { ok: true };
  }),
  'POST /api/challenge/respond': authed((a, b) => {
    const from = findByName(b.from), inv = invites.get(a.key);
    if (!from || !inv || inv.from !== from.key || Date.now() > inv.exp) throw err(410, 'Undangan sudah kedaluwarsa');
    invites.delete(a.key);
    if (!b.accept) { sendTo(from.key, 'toast', { text: `${a.u.name} menolak tantangan` }); return { ok: true }; }
    if (!isOnline(from.key) || userMatch.has(from.key) || userMatch.has(a.key)) throw err(400, 'Tidak bisa memulai pertandingan');
    createMatch(from.key, a.key);
    return { ok: true };
  }),

  'POST /api/match/aim': authed((a, b) => {
    const m = getMatch(a.key, b.matchId), idx = m.players.indexOf(a.key);
    if (m.game.turn !== idx) return { ok: true };
    sendTo(m.players[1 - idx], 'aim', { angle: num(b.angle), pull: clamp(num(b.pull), 0, 40) });
    return { ok: true };
  }),
  'POST /api/match/shot': authed((a, b) => {
    const m = getMatch(a.key, b.matchId), idx = m.players.indexOf(a.key);
    if (m.game.turn !== idx || m.game.winner != null) throw err(409, 'Bukan giliranmu');
    const s = b.shot || {};
    const shot = {
      angle: num(s.angle), power: clamp(num(s.power), 0, 1), spin: clamp(num(s.spin || 0), -1, 1),
      cx: null, cy: null,
    };
    if (m.game.ballInHand) {
      if (s.cx == null || s.cy == null) throw err(400, 'Tentukan posisi bola putih');
      shot.cx = num(s.cx); shot.cy = num(s.cy);
      if (!B.canPlace(m.balls, shot.cx, shot.cy)) throw err(400, 'Posisi bola putih tidak valid');
    }
    const cue = cueById(a.u.cue) || CUES[0];
    shot.cue = cue.id;
    // simulasi otoritatif
    const ctx = B.beginShot(m.game, m.balls), ev = B.newEvents();
    B.launch(m.balls, shot, cue);
    let steps = 0;
    while (B.isMoving(m.balls) && steps < 240 * 60) { B.step(m.balls, B.DT, ev); steps++; }
    for (const ball of m.balls) { ball.vx = 0; ball.vy = 0; }
    const msg = B.resolve(m.game, m.balls, ev, ctx);
    const state = B.snapshot(m.balls, m.game, msg);
    m.deadline = Date.now() + steps / 240 * 1000 + AIM_MS + GRACE_MS;
    sendTo(m.players[1 - idx], 'shot', { matchId: m.id, shot });
    for (const k of m.players) sendTo(k, 'state', { matchId: m.id, state });
    if (m.game.winner != null) endMatch(m, m.game.winner, 'win');
    return { ok: true };
  }),
  'POST /api/match/resign': authed((a, b) => {
    const m = getMatch(a.key, b.matchId);
    endMatch(m, 1 - m.players.indexOf(a.key), 'resign');
    return { ok: true };
  }),
};

function becomeFriends(k1, k2) {
  const u1 = getU(k1), u2 = getU(k2);
  const rm = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
  rm(u1.incoming, k2); rm(u1.outgoing, k2); rm(u2.incoming, k1); rm(u2.outgoing, k1);
  if (!u1.friends.includes(k2)) u1.friends.push(k2);
  if (!u2.friends.includes(k1)) u2.friends.push(k1);
  save();
  sendTo(k1, 'friend_update', {}); sendTo(k2, 'friend_update', {});
  sendTo(k1, 'toast', { text: `Kamu berteman dengan ${u2.name}` });
  sendTo(k2, 'toast', { text: `Kamu berteman dengan ${u1.name}` });
}

/* ---------- SSE ---------- */
function sse(req, res, url) {
  const a = auth({ req, url });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  let set = clients.get(a.key);
  if (!set) { set = new Set(); clients.set(a.key, set); }
  const wasOffline = set.size === 0;
  set.add(res);
  if (wasOffline) notifyFriends(a.key);
  const m = currentMatch(a.key);
  if (m) {
    const idx = m.players.indexOf(a.key);
    clearTimeout(m.dc[idx]); m.dc[idx] = null;
    sendTo(m.players[1 - idx], 'opponent_status', { online: true });
    res.write(`event: match_resume\ndata: ${JSON.stringify(matchPayload(m, a.key))}\n\n`);
  }
  const hb = setInterval(() => res.write(': hb\n\n'), 20000);
  req.on('close', () => {
    clearInterval(hb);
    const s = clients.get(a.key);
    if (s) { s.delete(res); if (s.size === 0) { clients.delete(a.key); onOffline(a.key); } }
  });
}

/* ---------- file statis ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(pathname, res) {
  let p = decodeURIComponent(pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) throw err(403, 'Dilarang');
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* CORS: untuk frontend di domain lain (mis. Vercel). Isi ALLOWED_ORIGIN, pisahkan dengan koma,
   contoh: ALLOWED_ORIGIN=https://billiard.vercel.app,https://billiard-git-main-akun.vercel.app */
const ALLOWED = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED.length) return;
  if (ALLOWED.includes('*') || ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/api/events' && req.method === 'GET') return sse(req, res, url);
      const h = routes[req.method + ' ' + url.pathname];
      if (!h) throw err(404, 'Tidak ditemukan');
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await h({ req, url, body, ip: req.socket.remoteAddress });
      return send(res, 200, out || { ok: true });
    }
    return serveStatic(url.pathname, res);
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Kesalahan server' });
  }
});
server.listen(PORT, () => console.log(`Billiard berjalan di http://localhost:${PORT}`));
