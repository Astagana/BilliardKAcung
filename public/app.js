// Skrip klasik (bukan modul): lebih tahan terhadap hosting/browser yang bermasalah dengan ES module.
window.__appLoaded = true;
// three.js dimuat belakangan (saat pertandingan dimulai) supaya login/lobi tetap jalan
// walaupun CDN three.js gagal dimuat.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
let THREE = null;

if (!window.Billiard) {
  const el = document.getElementById('authErr');
  if (el) el.textContent = 'File physics.js gagal dimuat. Pastikan folder public/ lengkap.';
  throw new Error('physics.js tidak termuat');
}
const B = window.Billiard;
const { L, W, R } = B;
const $ = id => document.getElementById(id);
const API_BASE = String(window.API_BASE || '').replace(/\/+$/, '');

/* ====================== util ====================== */
let token = localStorage.getItem('bt') || '';
let me = null, catalog = [];
let es = null;
const cueById = id => catalog.find(c => c.id === id) || catalog[0];

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) { if (k == null) continue; e.append(k.nodeType ? k : document.createTextNode(String(k))); }
  return e;
}

async function api(path, body) {
  const opt = { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(API_BASE + path, opt);
  let j = {}; try { j = await r.json(); } catch { /* kosong */ }
  if (!r.ok) {
    if (r.status === 401 && token && !path.startsWith('/api/login') && !path.startsWith('/api/register')) logout(true);
    throw new Error(j.error || ('Error ' + r.status));
  }
  return j;
}

function toast(text, ms = 2800) {
  const d = h('div', {}, text);
  $('toast').append(d);
  setTimeout(() => d.remove(), ms);
}
function showScreen(id) {
  for (const s of ['auth', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== id);
}

/* ====================== auth ====================== */
async function doAuth(kind) {
  $('authErr').textContent = '';
  try {
    const r = await api('/api/' + kind, { name: $('aName').value, password: $('aPass').value });
    token = r.token; localStorage.setItem('bt', token);
    $('aPass').value = '';
    await boot();
  } catch (e) { $('authErr').textContent = e.message; }
}
$('bLogin').onclick = () => doAuth('login');
$('bReg').onclick = () => doAuth('register');
$('aPass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth('login'); });

function logout(silent) {
  if (!silent && token) api('/api/logout', {}).catch(() => {});
  token = ''; localStorage.removeItem('bt');
  if (es) { es.close(); es = null; }
  G.active = false; me = null;
  showScreen('auth');
}
$('bLogout').onclick = () => logout(false);

async function boot() {
  if (!catalog.length) catalog = (await api('/api/catalog')).cues;
  me = await api('/api/me');
  showScreen('lobby');
  renderLobby();
  connect();
}

/* ====================== SSE ====================== */
function connect() {
  if (es) es.close();
  es = new EventSource(API_BASE + '/api/events?token=' + encodeURIComponent(token));
  const on = (n, fn) => es.addEventListener(n, e => { try { fn(JSON.parse(e.data)); } catch (x) { console.error(x); } });
  on('friend_update', () => refresh());
  on('toast', d => toast(d.text));
  on('invite', onInvite);
  on('match_found', d => { startMatch(d); toast('Lawan ditemukan!'); });
  on('match_resume', d => startMatch(d));
  on('aim', d => { if (G.active) { G.opp.angle = d.angle; G.opp.pull = d.pull; } });
  on('shot', onOppShot);
  on('state', onState);
  on('match_end', onMatchEnd);
  on('opponent_status', d => { if (G.active) toast(d.online ? 'Lawan terhubung kembali' : `Lawan terputus (${d.seconds} dtk untuk kembali)`, 4000); });
}
async function refresh() {
  if (!token) return;
  try { me = await api('/api/me'); renderLobby(); } catch { /* abaikan */ }
}

function onInvite(d) {
  if (G.active) return;
  const ov = $('overlay'), card = $('ovCard');
  card.replaceChildren(
    h('h2', {}, '⚔️ Tantangan!'),
    h('p', {}, `${d.from} menantangmu bermain.`),
    h('div', { class: 'btns', style: 'display:flex;gap:10px;margin-top:12px' },
      h('button', { class: 'pri', style: 'flex:1', onclick: async () => { ov.classList.add('hidden'); try { await api('/api/challenge/respond', { from: d.from, accept: true }); } catch (e) { toast(e.message); } } }, 'Terima'),
      h('button', { style: 'flex:1', onclick: async () => { ov.classList.add('hidden'); try { await api('/api/challenge/respond', { from: d.from, accept: false }); } catch { /* */ } } }, 'Tolak')));
  ov.classList.remove('hidden');
  setTimeout(() => { if (!G.active && card.textContent.includes('Tantangan')) ov.classList.add('hidden'); }, 30000);
}

/* ====================== lobi ====================== */
let tab = 'home', qTimer = null, qStart = 0;
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderLobby(); });

function renderLobby() {
  if (!me) return;
  $('lName').textContent = me.name;
  $('lCoins').textContent = me.coins.toLocaleString('id-ID');
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  for (const t of ['home', 'shop', 'friends']) $('tab-' + t).classList.toggle('hidden', t !== tab);
  $('fBadge').textContent = me.incoming.length ? `(${me.incoming.length})` : '';
  // home
  const cue = cueById(me.cue);
  $('statsBox').replaceChildren(
    ...[['Menang', me.wins], ['Kalah', me.losses], ['Stik', cue ? cue.name : '-']].map(([k, v]) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, k))));
  $('queueIdle').classList.toggle('hidden', me.queued);
  $('queueBox').classList.toggle('hidden', !me.queued);
  if (me.queued && !qTimer) { qStart = Date.now(); qTimer = setInterval(() => { $('qTime').textContent = Math.floor((Date.now() - qStart) / 1000); }, 500); }
  if (!me.queued && qTimer) { clearInterval(qTimer); qTimer = null; }
  renderShop(); renderFriends();
}
$('bFind').onclick = async () => { try { await api('/api/queue/join', {}); await refresh(); } catch (e) { toast(e.message); } };
$('bCancelFind').onclick = async () => { try { await api('/api/queue/leave', {}); await refresh(); } catch (e) { toast(e.message); } };

function meter(label, val, min, max) {
  const pct = Math.round((val - min) / (max - min) * 100);
  return h('div', { class: 'meter' }, h('label', {}, label), h('div', { class: 'tr' }, h('i', { style: `width:${Math.max(6, pct)}%` })));
}
function renderShop() {
  $('shopBox').replaceChildren(...catalog.map(c => {
    const owned = me.owned.includes(c.id), eq = me.cue === c.id;
    let act;
    if (eq) act = h('button', { disabled: '' }, '✔ Dipakai');
    else if (owned) act = h('button', { class: 'pri', onclick: async () => { try { me = await api('/api/shop/equip', { cue: c.id }); renderLobby(); } catch (e) { toast(e.message); } } }, 'Pakai');
    else act = h('button', { class: 'pri', disabled: me.coins < c.price ? '' : null, onclick: async () => { try { me = await api('/api/shop/buy', { cue: c.id }); renderLobby(); toast('Dibeli: ' + c.name); } catch (e) { toast(e.message); } } }, 'Beli');
    return h('div', { class: 'cue' + (eq ? ' eq' : '') },
      h('div', { class: 'nm' }, c.name),
      h('div', { class: 'bar', style: `background:linear-gradient(90deg,${c.color},${c.color} 70%,#e9dcc0 70%)` }),
      meter('Power', c.power, 1, 1.35), meter('Garis', c.guide, 70, 280), meter('Spin', c.english, 0.6, 1),
      h('div', { class: 'act' }, act, h('span', { class: 'price' }, c.price ? '🪙 ' + c.price.toLocaleString('id-ID') : 'Gratis')));
  }));
}
function renderFriends() {
  const box = $('friendsBox'), rows = [];
  if (me.incoming.length) {
    rows.push(h('div', { class: 'sub' }, 'Permintaan masuk'));
    for (const n of me.incoming) rows.push(h('div', { class: 'row' }, h('span', { class: 'sp' }, n),
      h('button', { class: 'pri', onclick: () => friendAct('accept', n) }, 'Terima'),
      h('button', { onclick: () => friendAct('decline', n) }, 'Tolak')));
  }
  rows.push(h('div', { class: 'sub' }, `Teman (${me.friends.length})`));
  if (!me.friends.length) rows.push(h('div', { class: 'sub' }, 'Belum ada teman. Tambahkan lewat nama pengguna.'));
  for (const f of me.friends) rows.push(h('div', { class: 'row' },
    h('span', { class: 'dot' + (f.online ? ' on' : '') }),
    h('span', { class: 'sp' }, f.name, f.busy ? ' (bertanding)' : ''),
    h('button', { class: 'pri', disabled: (!f.online || f.busy) ? '' : null, onclick: () => challenge(f.name) }, 'Tantang'),
    h('button', { onclick: () => { if (confirm('Hapus ' + f.name + ' dari teman?')) friendAct('remove', f.name); } }, '✕')));
  if (me.outgoing.length) {
    rows.push(h('div', { class: 'sub' }, 'Menunggu persetujuan'));
    for (const n of me.outgoing) rows.push(h('div', { class: 'row' }, h('span', { class: 'sp' }, n), h('button', { onclick: () => friendAct('decline', n) }, 'Batal')));
  }
  box.replaceChildren(...rows);
}
async function friendAct(kind, name) {
  try { await api('/api/friends/' + kind, { name }); await refresh(); } catch (e) { toast(e.message); }
}
async function challenge(name) {
  try { await api('/api/challenge', { name }); toast('Tantangan dikirim ke ' + name); } catch (e) { toast(e.message); }
}
$('bAddFriend').onclick = async () => {
  const n = $('fName').value.trim(); if (!n) return;
  try { const r = await api('/api/friends/add', { name: n }); $('fName').value = ''; toast(r.status === 'friends' ? 'Kalian sekarang berteman!' : 'Permintaan dikirim'); await refresh(); }
  catch (e) { toast(e.message); }
};

/* ====================== state game ====================== */
const G = {
  active: false, matchId: null, you: 0, players: [], balls: [], game: null,
  phase: 'wait',            // aim | wait | moving | over
  angle: 0, power: 0.6, spin: 0, curPull: 6,
  topView: false, placing: false,
  cam: { dist: 85, elev: 0.5 },
  simulating: false, acc: 0, pending: null, awaiting: false, strike: null, cueHidden: false,
  opp: { angle: 0, pull: 6 }, deadline: 0, endInfo: null,
};

/* ====================== three.js ====================== */
let renderer, scene, camera, cueGroup, buttMat, guideLine, objLine, ghost;
const ballMeshes = [];
const texCache = {};
let camPos, camLook;
const BALL_COL = ['#f4f4f0', '#f5c518', '#1e4fd8', '#d62828', '#6a1b9a', '#f57c00', '#1b8a3a', '#7b1e1e', '#111111'];
const colorOf = id => id === 0 ? '#f4f4f0' : BALL_COL[id > 8 ? id - 8 : id];

function ballTexture(id) {
  if (texCache[id]) return texCache[id];
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const col = colorOf(id);
  if (id > 8) { g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 512, 256); g.fillStyle = col; g.fillRect(0, 56, 512, 144); }
  else { g.fillStyle = col; g.fillRect(0, 0, 512, 256); }
  if (id > 0) {
    for (const x of [128, 384]) {
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, 128, 34, 0, 7); g.fill();
      g.fillStyle = '#111'; g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(id), x, 131);
    }
  } else { g.fillStyle = '#d62828'; g.beginPath(); g.arc(128, 128, 9, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return (texCache[id] = t);
}

function init3D() {
  camPos = new THREE.Vector3(0, 150, 100); camLook = new THREE.Vector3();
  renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1018);
  camera = new THREE.PerspectiveCamera(50, 1, 1, 1500);

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1f2b, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(40, 220, 60); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 110, bottom: -110, near: 10, far: 500 });
  scene.add(sun);
  const lamp = new THREE.PointLight(0xfff1d0, 0.6, 600); lamp.position.set(0, 140, 0); scene.add(lamp);

  buildTable(); buildCue(); buildGuide();
  resize(); addEventListener('resize', resize);
  requestAnimationFrame(loop);
}

function buildTable() {
  const box = (w, hgt, d, x, y, z, mat, shadow = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), mat);
    m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; scene.add(m); return m;
  };
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshStandardMaterial({ color: 0x0d7a45, roughness: 0.95 }));
  cloth.rotation.x = -Math.PI / 2; cloth.receiveShadow = true; scene.add(cloth);
  const wood = new THREE.MeshStandardMaterial({ color: 0x5a3418, roughness: 0.45 });
  const rub = new THREE.MeshStandardMaterial({ color: 0x0a5d36, roughness: 0.9 });
  const rw = 14;
  box(L + 2 * rw, 6, rw, 0, 1.5, -(W / 2 + rw / 2), wood);
  box(L + 2 * rw, 6, rw, 0, 1.5, (W / 2 + rw / 2), wood);
  box(rw, 6, W, -(L / 2 + rw / 2), 1.5, 0, wood);
  box(rw, 6, W, (L / 2 + rw / 2), 1.5, 0, wood);
  box(L + 2 * rw, 10, W + 2 * rw, 0, -5.2, 0, wood);
  // bantalan karet (ada celah di lubang)
  for (const sz of [-1, 1]) for (const [a, b] of [[-L / 2 + 9, -8], [8, L / 2 - 9]])
    box(b - a, 3.5, 3, (a + b) / 2, 1.75, sz * (W / 2 + 1.5), rub, false);
  for (const sx of [-1, 1])
    box(3, 3.5, W - 18, sx * (L / 2 + 1.5), 1.75, 0, rub, false);
  // lubang
  const hole = new THREE.MeshBasicMaterial({ color: 0x020202 });
  for (const p of B.POCKETS) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(p.r, 24), hole);
    m.rotation.x = -Math.PI / 2; m.position.set(p.x - L / 2, 0.04, p.y - W / 2); scene.add(m);
  }
  // kaki meja + lantai
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(6, 7, 70, 16), wood);
    leg.position.set(sx * (L / 2 + 4), -45, sz * (W / 2 + 4)); leg.castShadow = true; scene.add(leg);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ color: 0x1a1f2b, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -80; floor.receiveShadow = true; scene.add(floor);
}

function buildCue() {
  cueGroup = new THREE.Group();
  const mk = (rt, rb, hgt, y, mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, hgt, 16), mat);
    m.position.y = y; m.castShadow = true; cueGroup.add(m); return m;
  };
  mk(0.36, 0.36, 1.2, 0.6, new THREE.MeshStandardMaterial({ color: 0x3b82f6 }));
  mk(0.38, 0.38, 2.2, 2.3, new THREE.MeshStandardMaterial({ color: 0xf5f5f0 }));
  mk(0.7, 0.4, 78, 3.4 + 39, new THREE.MeshStandardMaterial({ color: 0xe2c48a, roughness: 0.5 }));
  buttMat = new THREE.MeshStandardMaterial({ color: 0xa0722d, roughness: 0.4, metalness: 0.15 });
  mk(1.25, 0.7, 66, 81.4 + 33, buttMat);
  cueGroup.visible = false;
  scene.add(cueGroup);
}

function buildGuide() {
  const mkLine = (color, op) => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op }));
    l.frustumCulled = false; l.visible = false; scene.add(l); return l;
  };
  guideLine = mkLine(0xffffff, 0.8);
  objLine = mkLine(0xfde047, 0.9);
  ghost = new THREE.Mesh(new THREE.SphereGeometry(R, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
  ghost.visible = false; scene.add(ghost);
}
function setLine(line, x1, z1, x2, z2, y = 0.5) {
  const p = line.geometry.attributes.position;
  p.setXYZ(0, x1, y, z1); p.setXYZ(1, x2, y, z2); p.needsUpdate = true;
}

function rebuildBalls() {
  for (const m of ballMeshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  ballMeshes.length = 0;
  const geo = new THREE.SphereGeometry(R, 32, 24);
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(geo.clone(), new THREE.MeshStandardMaterial({ map: ballTexture(i), roughness: 0.22, metalness: 0.05 }));
    m.castShadow = true; m.userData = { px: null, py: null, fall: 0 };
    scene.add(m); ballMeshes.push(m);
  }
}

function resize() {
  if (!renderer) return;
  const w = innerWidth, hh = innerHeight;
  renderer.setSize(w, hh, false);
  camera.aspect = w / hh; camera.updateProjectionMatrix();
}

/* ====================== kamera, stik, panduan ====================== */
const ang2 = (a) => new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
function fitDist() { return Math.max(190, 330 / camera.aspect); }

function updateCamera(dt) {
  const mine = G.phase === 'aim' && G.game.turn === G.you;
  let tp, tl;
  if (mine && !G.topView && !G.placing) {
    const cb = G.balls[0], dir = ang2(G.angle), e = G.cam.elev, d = G.cam.dist;
    const cx = cb.x - L / 2, cz = cb.y - W / 2;
    tp = new THREE.Vector3(cx - dir.x * Math.cos(e) * d, R + Math.sin(e) * d, cz - dir.z * Math.cos(e) * d);
    tl = new THREE.Vector3(cx + dir.x * 25, R, cz + dir.z * 25);
  } else if (mine) {
    tp = new THREE.Vector3(0, fitDist(), 10); tl = new THREE.Vector3(0, 0, 0);
  } else {
    const d = fitDist();
    tp = new THREE.Vector3(0, d * 0.82, d * 0.6); tl = new THREE.Vector3(0, 0, 0);
  }
  const k = 1 - Math.exp(-6 * dt);
  camPos.lerp(tp, k); camLook.lerp(tl, k);
  camera.position.copy(camPos); camera.lookAt(camLook);
}

function updateCue(now) {
  const cb = G.balls[0];
  let ang = G.angle, pull = 6, show = false;
  if (G.strike) {
    const s = G.strike, p = Math.min(1, (now - s.t0) / s.dur);
    ang = s.shot.angle; pull = s.from + (-0.5 - s.from) * p * p; show = true;
    if (p >= 1) { G.strike = null; G.cueHidden = true; startSim(s.shot, s.cue); show = false; }
  } else if (G.phase === 'aim' && G.game.turn === G.you) {
    ang = G.angle; pull = 2 + G.power * 28; show = true;
  } else if (G.phase === 'wait' && !G.cueHidden) {
    G.opp.pullS = (G.opp.pullS ?? G.opp.pull) + (G.opp.pull - (G.opp.pullS ?? G.opp.pull)) * 0.25;
    ang = G.opp.angle; pull = G.opp.pullS; show = true;
  }
  G.curPull = pull;
  if (!show || G.cueHidden || cb.in || G.phase === 'over') { cueGroup.visible = false; return; }
  const turnPlayer = G.players[G.game.turn];
  const c = cueById(turnPlayer.cue);
  if (c) buttMat.color.set(c.color);
  const E = 0.07, bx = -Math.cos(ang) * Math.cos(E), bz = -Math.sin(ang) * Math.cos(E), by = Math.sin(E);
  const dist = R + 0.6 + pull;
  cueGroup.position.set(cb.x - L / 2 + bx * dist, R + by * dist, cb.y - W / 2 + bz * dist);
  cueGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(bx, by, bz));
  cueGroup.visible = true;
}

function updateGuide() {
  const show = G.active && G.phase === 'aim' && G.game.turn === G.you && !G.strike && !G.balls[0].in;
  guideLine.visible = objLine.visible = ghost.visible = false;
  if (!show) return;
  const cue = cueById(G.players[G.you].cue), cb = G.balls[0];
  const tr = B.aimTrace(G.balls, G.angle), len = Math.min(cue.guide, tr.t);
  const dx = Math.cos(G.angle), dy = Math.sin(G.angle);
  const x0 = cb.x - L / 2, z0 = cb.y - W / 2;
  setLine(guideLine, x0 + dx * R, z0 + dy * R, x0 + dx * len, z0 + dy * len);
  guideLine.visible = true;
  if (tr.ball !== null && tr.t <= cue.guide) {
    const gx = x0 + dx * tr.t, gz = z0 + dy * tr.t, ob = G.balls[tr.ball];
    ghost.position.set(gx, R, gz); ghost.visible = true;
    let ox = ob.x - L / 2 - gx, oz = ob.y - W / 2 - gz; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    const ll = Math.min(45, cue.guide * 0.35);
    setLine(objLine, ob.x - L / 2, ob.y - W / 2, ob.x - L / 2 + ox * ll, ob.y - W / 2 + oz * ll);
    objLine.visible = true;
  }
}

function updateBalls(dt) {
  for (let i = 0; i < 16; i++) {
    const b = G.balls[i], m = ballMeshes[i], u = m.userData;
    if (b.in) {
      u.fall += dt; m.position.y = R - 160 * u.fall * u.fall; m.visible = u.fall < 0.5;
      m.position.x = b.x - L / 2; m.position.z = b.y - W / 2; u.px = null;
      continue;
    }
    u.fall = 0; m.visible = true;
    m.position.set(b.x - L / 2, R, b.y - W / 2);
    if (u.px !== null) {
      const dx = b.x - u.px, dy = b.y - u.py, d = Math.hypot(dx, dy);
      if (d > 1e-5 && d < 20) m.rotateOnWorldAxis(new THREE.Vector3(dy / d, 0, -dx / d), d / R);
    }
    u.px = b.x; u.py = b.y;
  }
}

/* ====================== simulasi ====================== */
function startSim(shot, cueId) {
  G.ev = B.newEvents();
  B.launch(G.balls, shot, cueById(cueId));
  G.simulating = true; G.phase = 'moving'; G.acc = 0;
  updateCtrl();
}
function updateSim(dt) {
  G.acc += Math.min(dt, 0.05);
  let n = 0;
  while (G.acc >= B.DT && n < 40) { B.step(G.balls, B.DT, G.ev); G.acc -= B.DT; n++; }
  if (!B.isMoving(G.balls)) endSim();
}
function endSim() {
  G.simulating = false;
  for (const b of G.balls) { b.vx = 0; b.vy = 0; }
  if (G.pending) { const s = G.pending; G.pending = null; applyState(s); }
  else { G.awaiting = true; G.phase = 'wait'; updateCtrl(); }
}

/* ====================== alur pertandingan ====================== */
async function startMatch(info) {
  if (!renderer) {
    try {
      if (!THREE) THREE = await import(THREE_URL);
      init3D();
    } catch (e) {
      console.error(e);
      toast('Gagal memuat grafik 3D (three.js). Periksa koneksi internet lalu coba lagi.', 6000);
      api('/api/match/resign', { matchId: info.matchId }).catch(() => {});
      return;
    }
  }
  G.matchId = info.matchId; G.you = info.you; G.players = info.players;
  G.balls = B.makeBalls(info.seed);
  G.game = B.restore(G.balls, info.state);
  G.simulating = false; G.pending = null; G.awaiting = false; G.strike = null; G.endInfo = null;
  G.active = true; G.cam.elev = 0.5; G.cam.dist = 85;
  $('overlay').classList.add('hidden');
  if (qTimer) { clearInterval(qTimer); qTimer = null; }
  rebuildBalls();
  showScreen('game'); resize();
  camPos.set(0, 220, 150); camLook.set(0, 0, 0);
  setTurn(true);
  announce(G.game.turn === G.you ? 'Kamu mulai duluan! Pecahkan bola.' : `${G.players[G.game.turn].name} memulai`, 3000);
}

function defaultAngle() {
  const cb = G.balls[0]; let best = null, bd = 1e9;
  for (const b of G.balls) { if (b.id === 0 || b.in) continue; const d = Math.hypot(b.x - cb.x, b.y - cb.y); if (d < bd) { bd = d; best = b; } }
  return best ? Math.atan2(best.y - cb.y, best.x - cb.x) : 0;
}

function setTurn(silent) {
  G.cueHidden = false; G.strike = null; G.pending = null; G.awaiting = false;
  if (G.game.winner != null) { G.phase = 'over'; updateCtrl(); renderHud(); return; }
  const mine = G.game.turn === G.you;
  G.phase = mine ? 'aim' : 'wait';
  G.placing = mine && G.game.ballInHand;
  G.topView = G.placing;
  G.angle = defaultAngle();
  G.opp.angle = G.angle; G.opp.pull = 6; G.opp.pullS = 6;
  G.deadline = Date.now() + 75000;
  lastSent = { a: 99, p: 99, t: 0 };
  renderHud(); updateCtrl();
  if (!silent && mine) announce(G.placing ? 'Foul lawan, letakkan bola putih lalu tekan Posisi OK' : 'Giliranmu', 2000);
}

function applyState(s) {
  G.game = B.restore(G.balls, s.state ? s.state : s);
  const st = s.state || s;
  setTurn(true);
  if (st.msg) announce(st.msg, 2600);
  if (G.endInfo) showEnd(G.endInfo);
  else if (G.game.turn === G.you && G.game.winner == null && G.game.ballInHand) setTimeout(() => announce('Letakkan bola putih lalu tekan Posisi OK', 2500), 1800);
}

function onState(d) {
  if (!G.active || d.matchId !== G.matchId) return;
  if (G.simulating || G.strike || G.phase === 'moving') G.pending = d.state;
  else applyState(d.state);
}

function onOppShot(d) {
  if (!G.active || d.matchId !== G.matchId) return;
  const s = d.shot;
  G.phase = 'moving'; G.cueHidden = false; G.awaiting = false;
  G.strike = { t0: performance.now(), from: G.opp.pullS ?? 6, dur: 140, shot: s, cue: s.cue };
  updateCtrl();
}

function shoot() {
  if (G.phase !== 'aim' || G.placing) return;
  const cb = G.balls[0], bih = G.game.ballInHand;
  const shot = { angle: G.angle, power: G.power, spin: G.spin, cx: bih ? cb.x : null, cy: bih ? cb.y : null };
  const cueId = G.players[G.you].cue, from = G.curPull;
  G.phase = 'moving'; updateCtrl();
  api('/api/match/shot', { matchId: G.matchId, shot })
    .then(() => { shot.cx = bih ? cb.x : null; shot.cy = bih ? cb.y : null; G.strike = { t0: performance.now(), from, dur: 140, shot, cue: cueId }; })
    .catch(e => { toast(e.message); if (G.phase === 'moving' && !G.simulating) { G.phase = 'aim'; updateCtrl(); } });
}

function onMatchEnd(d) {
  if (!G.active || d.matchId !== G.matchId) { if (me) { me.coins = d.coins; } return; }
  G.endInfo = d;
  if (me) { me.coins = d.coins; if (d.won) me.wins++; else me.losses++; }
  const busy = G.simulating || G.strike || G.pending || G.phase === 'moving';
  if (!busy) showEnd(d);
  else setTimeout(() => { if (G.endInfo) showEnd(G.endInfo); }, d.reason === 'win' ? 15000 : 700);
}
function showEnd(d) {
  G.endInfo = null; G.phase = 'over'; updateCtrl();
  const why = { win: '', resign: d.won ? 'Lawan menyerah' : 'Kamu menyerah', timeout: d.won ? 'Lawan kehabisan waktu' : 'Waktumu habis', disconnect: d.won ? 'Lawan terputus' : 'Kamu terputus' }[d.reason] || '';
  $('ovCard').replaceChildren(
    h('h2', {}, d.won ? '🏆 Kamu menang!' : '😕 Kamu kalah'),
    why ? h('p', {}, why) : null,
    h('p', { class: 'price' }, `+${d.reward} 🪙  (total ${d.coins.toLocaleString('id-ID')})`),
    h('button', { class: 'pri', style: 'width:100%;margin-top:10px', onclick: backToLobby }, 'Kembali ke lobi'));
  $('overlay').classList.remove('hidden');
}
async function backToLobby() {
  $('overlay').classList.add('hidden');
  G.active = false; showScreen('lobby');
  tab = 'home'; await refresh();
}

/* ====================== HUD ====================== */
let bannerT = null;
function announce(text, ms = 2200) {
  const b = $('banner'); b.textContent = text; b.classList.add('on');
  clearTimeout(bannerT); bannerT = setTimeout(() => b.classList.remove('on'), ms);
}
function renderHud() {
  for (const i of [0, 1]) {
    const el = $('pl' + i), p = G.players[i], g = G.game.groups[i];
    el.querySelector('.n').textContent = p.name + (i === G.you ? ' (kamu)' : '');
    el.querySelector('.grp').textContent = g ? (g === 'solid' ? 'Bola penuh (1-7)' : 'Bola strip (9-15)') : 'Meja terbuka';
    const dots = el.querySelector('.dots'); dots.replaceChildren();
    if (g) {
      const ids = g === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
      for (const id of ids) if (!G.balls[id].in) { const d = h('div', { class: 'bd', style: `background:${colorOf(id)}` }, id); dots.append(d); }
      if (!ids.some(id => !G.balls[id].in)) dots.append(h('div', { class: 'bd', style: 'background:#111' }, 8));
    }
    el.classList.toggle('turn', G.game.turn === i && G.game.winner == null);
  }
}
function updateCtrl() {
  const my = G.phase === 'aim';
  $('ctrl').classList.toggle('off', !my);
  $('bShoot').disabled = !my || G.placing;
  $('bOk').classList.toggle('hidden', !(my && G.placing));
}
setInterval(() => {
  if (!G.active) return;
  const s = Math.max(0, Math.ceil((G.deadline - Date.now()) / 1000));
  $('timer').textContent = G.phase === 'moving' ? '…' : s;
}, 500);

/* ====================== input ====================== */
$('pow').oninput = e => { G.power = e.target.value / 100; };
$('spin').oninput = e => { G.spin = e.target.value / 100; };
$('bShoot').onclick = shoot;
$('bCam').onclick = () => { G.topView = !G.topView; };
$('bZin').onclick = () => { G.cam.dist = Math.max(45, G.cam.dist - 12); };
$('bZout').onclick = () => { G.cam.dist = Math.min(170, G.cam.dist + 12); };
$('bOk').onclick = () => { G.placing = false; G.topView = false; updateCtrl(); };
$('bQuit').onclick = async () => {
  if (G.phase === 'over' || !confirm('Menyerah dan kalah di pertandingan ini?')) return;
  try { await api('/api/match/resign', { matchId: G.matchId }); } catch (e) { toast(e.message); }
};
function hold(btn, dir) {
  let t = null;
  const stop = () => { clearInterval(t); t = null; };
  btn.addEventListener('pointerdown', e => { e.preventDefault(); if (G.phase !== 'aim') return; G.angle += dir * 0.002; t = setInterval(() => { G.angle += dir * 0.0025; }, 30); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
}
hold($('bL'), -1); hold($('bR'), 1);

const canvas = () => $('c');
function pickTable(e) {
  const r = canvas().getBoundingClientRect();
  const nd = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(nd, camera);
  const pt = new THREE.Vector3();
  if (!rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -R), pt)) return null;
  return { x: pt.x + L / 2, y: pt.z + W / 2 };
}
let drag = null;
function interactive() { return G.active && G.phase === 'aim' && G.game.turn === G.you; }
function handleTop(e) {
  const p = pickTable(e); if (!p) return;
  if (G.placing) {
    const x = Math.min(L - R, Math.max(R, p.x)), y = Math.min(W - R, Math.max(R, p.y));
    if (B.canPlace(G.balls, x, y)) { const cb = G.balls[0]; cb.x = x; cb.y = y; cb.in = false; G.angle = defaultAngle(); }
  } else {
    const cb = G.balls[0]; G.angle = Math.atan2(p.y - cb.y, p.x - cb.x);
  }
}
window.addEventListener('load', () => {
  const c = canvas();
  c.addEventListener('pointerdown', e => {
    if (!interactive()) return;
    c.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
    if (G.placing || G.topView) handleTop(e);
  });
  c.addEventListener('pointermove', e => {
    if (!drag || !interactive()) return;
    if (G.placing || G.topView) { handleTop(e); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    G.angle += dx * 0.0035;
    G.cam.elev = Math.min(1.25, Math.max(0.12, G.cam.elev - dy * 0.004));
  });
  const end = () => { drag = null; };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  c.addEventListener('wheel', e => { e.preventDefault(); G.cam.dist = Math.min(170, Math.max(45, G.cam.dist + e.deltaY * 0.05)); }, { passive: false });
});
addEventListener('keydown', e => {
  if (!interactive() || e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const k = e.key, st = e.shiftKey ? 0.02 : 0.004;
  if (k === 'ArrowLeft') G.angle -= st;
  else if (k === 'ArrowRight') G.angle += st;
  else if (k === 'ArrowUp') { $('pow').value = Math.min(100, +$('pow').value + 3); G.power = $('pow').value / 100; }
  else if (k === 'ArrowDown') { $('pow').value = Math.max(0, +$('pow').value - 3); G.power = $('pow').value / 100; }
  else if (k === ' ') { e.preventDefault(); shoot(); }
});

/* sinkronisasi bidikan ke lawan */
let lastSent = { a: 99, p: 99, t: 0 };
function syncAim() {
  if (!interactive() || G.strike) return;
  const now = performance.now(), pull = 2 + G.power * 28;
  if (now - lastSent.t < 130) return;
  if (Math.abs(G.angle - lastSent.a) < 0.002 && Math.abs(pull - lastSent.p) < 0.3) return;
  lastSent = { a: G.angle, p: pull, t: now };
  api('/api/match/aim', { matchId: G.matchId, angle: G.angle, pull }).catch(() => {});
}

/* ====================== loop ====================== */
let lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  if (!G.active || !G.game) return;
  if (G.simulating) updateSim(dt);
  updateBalls(dt);
  updateCamera(dt);
  updateCue(t);
  updateGuide();
  syncAim();
  renderer.render(scene, camera);
}

/* ====================== mulai ====================== */
if (token) boot().catch(() => showScreen('auth')); else showScreen('auth');
