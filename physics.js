/* Mesin fisika + aturan 8-ball. Dipakai bersama oleh server (Node) dan klien (browser). */
(function (root) {
  'use strict';

  const L = 254, W = 127, R = 2.86;
  const MAX_V = 430, DECEL = 75, DRAG = 0.25;
  const E_WALL = 0.74, E_BALL = 0.96, STOP_V = 3, DT = 1 / 240;
  const POCKETS = [
    { x: 0, y: 0, r: 6.6 }, { x: L / 2, y: 0, r: 6.0 }, { x: L, y: 0, r: 6.6 },
    { x: 0, y: W, r: 6.6 }, { x: L / 2, y: W, r: 6.0 }, { x: L, y: W, r: 6.6 },
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function groupOf(id) { return id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe'; }

  function makeBalls(seed) {
    const rnd = mulberry32(seed >>> 0);
    const balls = [];
    for (let i = 0; i < 16; i++) balls.push({ id: i, x: 0, y: 0, vx: 0, vy: 0, in: false, spin: 0 });
    balls[0].x = L * 0.25; balls[0].y = W / 2;
    const fx = L * 0.72, fy = W / 2, dx = Math.sqrt(3) * R + 0.03, dy = 2 * R + 0.03;
    const pos = [];
    for (let r = 0; r < 5; r++) for (let k = 0; k <= r; k++) pos.push([fx + r * dx, fy + (k - r / 2) * dy]);
    const solids = shuffle([1, 2, 3, 4, 5, 6, 7], rnd);
    const stripes = shuffle([9, 10, 11, 12, 13, 14, 15], rnd);
    const slot = new Array(15);
    slot[4] = 8; slot[10] = solids.pop(); slot[14] = stripes.pop();
    const rest = shuffle(solids.concat(stripes), rnd);
    for (let i = 0; i < 15; i++) if (slot[i] === undefined) slot[i] = rest.pop();
    for (let i = 0; i < 15; i++) { const b = balls[slot[i]]; b.x = pos[i][0]; b.y = pos[i][1]; }
    return balls;
  }

  function newGame() { return { turn: 0, groups: [null, null], ballInHand: false, winner: null, breakDone: false }; }
  function newEvents() { return { pocketed: [], firstHit: null, spinDone: false }; }

  function isMoving(balls) {
    for (const b of balls) if (!b.in && (b.vx !== 0 || b.vy !== 0)) return true;
    return false;
  }

  function launch(balls, shot, cue) {
    const cb = balls[0];
    if (shot.cx != null && shot.cy != null) {
      cb.x = Math.min(L - R, Math.max(R, shot.cx));
      cb.y = Math.min(W - R, Math.max(R, shot.cy));
    }
    cb.in = false;
    const p = Math.min(1, Math.max(0, shot.power));
    const v = MAX_V * (0.06 + 0.94 * p) * cue.power;
    cb.vx = Math.cos(shot.angle) * v;
    cb.vy = Math.sin(shot.angle) * v;
    cb.spin = Math.max(-1, Math.min(1, shot.spin || 0)) * cue.english;
  }

  function step(balls, dt, ev) {
    const n = balls.length;
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (b.in) continue;
      b.x += b.vx * dt; b.y += b.vy * dt;
      const s = Math.hypot(b.vx, b.vy);
      if (s > 0) {
        const ns = s - (DECEL + DRAG * s) * dt;
        if (ns <= STOP_V) { b.vx = 0; b.vy = 0; }
        else { const k = ns / s; b.vx *= k; b.vy *= k; }
      }
      // lubang
      let potted = false;
      for (const p of POCKETS) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < p.r) {
          b.in = true; b.vx = 0; b.vy = 0;
          if (ev) ev.pocketed.push(b.id);
          potted = true; break;
        }
      }
      if (potted) continue;
      // bantalan
      if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx) * E_WALL; }
      else if (b.x > L - R) { b.x = L - R; b.vx = -Math.abs(b.vx) * E_WALL; }
      if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy) * E_WALL; }
      else if (b.y > W - R) { b.y = W - R; b.vy = -Math.abs(b.vy) * E_WALL; }
    }
    // tabrakan bola
    const D2 = 4 * R * R;
    for (let i = 0; i < n; i++) {
      const a = balls[i]; if (a.in) continue;
      for (let j = i + 1; j < n; j++) {
        const c = balls[j]; if (c.in) continue;
        const dx = c.x - a.x, dy = c.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= D2 || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const ov = (2 * R - d) / 2;
        a.x -= nx * ov; a.y -= ny * ov; c.x += nx * ov; c.y += ny * ov;
        const rvn = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
        if (rvn <= 0) continue;
        const cue = i === 0 ? a : null;
        let ux = 0, uy = 0;
        if (cue) { const ps = Math.hypot(a.vx, a.vy); if (ps > 0) { ux = a.vx / ps; uy = a.vy / ps; } }
        const imp = (1 + E_BALL) / 2 * rvn;
        a.vx -= imp * nx; a.vy -= imp * ny; c.vx += imp * nx; c.vy += imp * ny;
        if (i === 0) {
          if (ev && ev.firstHit === null) ev.firstHit = c.id;
          if (ev && !ev.spinDone) {
            a.vx += ux * a.spin * 0.6 * rvn; a.vy += uy * a.spin * 0.6 * rvn;
            ev.spinDone = true;
          }
        }
      }
    }
  }

  function beginShot(game, balls) {
    const me = game.turn, g = game.groups[me];
    let cleared = false;
    if (g) cleared = balls.every(b => b.id === 0 || b.id === 8 || groupOf(b.id) !== g || b.in);
    return { me, myGroup: g, clearedBefore: cleared, isBreak: !game.breakDone };
  }

  function respotEight(balls) {
    const b = balls[8];
    let x = L * 0.72 + 2 * (Math.sqrt(3) * R + 0.03);
    const y = W / 2;
    const free = (px) => balls.every(o => o.id === 8 || o.in || Math.hypot(o.x - px, o.y - y) >= 2 * R + 0.05);
    while (!free(x) && x < L - R) x += 2 * R + 0.1;
    b.in = false; b.x = x; b.y = y; b.vx = 0; b.vy = 0;
  }

  /* Menerapkan aturan setelah semua bola berhenti. Mengembalikan pesan. */
  function resolve(game, balls, ev, ctx) {
    const me = ctx.me, pocketed = ev.pocketed;
    const cueIn = pocketed.includes(0), eightIn = pocketed.includes(8);
    let foul = false, reason = '';
    if (cueIn) { foul = true; reason = 'Bola putih masuk lubang'; }
    else if (ev.firstHit === null) { foul = true; reason = 'Tidak mengenai bola apa pun'; }
    else {
      const fg = groupOf(ev.firstHit);
      if (ctx.myGroup) {
        const ok = ctx.clearedBefore ? fg === 'eight' : fg === ctx.myGroup;
        if (!ok) { foul = true; reason = 'Salah memukul bola pertama'; }
      } else if (fg === 'eight') { foul = true; reason = 'Bola 8 dipukul lebih dulu'; }
    }
    game.breakDone = true;
    if (eightIn) {
      if (ctx.isBreak) respotEight(balls);
      else {
        game.winner = (!foul && ctx.clearedBefore) ? me : 1 - me;
        if (game.winner === me) return 'Bola 8 masuk, menang!';
        return foul ? 'Bola 8 masuk saat foul, kalah' : 'Bola 8 masuk terlalu cepat, kalah';
      }
    }
    if (!foul && !game.groups[me]) {
      const first = pocketed.find(id => id !== 0 && id !== 8);
      if (first !== undefined) {
        const g = groupOf(first);
        game.groups[me] = g; game.groups[1 - me] = g === 'solid' ? 'stripe' : 'solid';
      }
    }
    const mine = pocketed.filter(id => id !== 0 && id !== 8 && (!game.groups[me] || groupOf(id) === game.groups[me]));
    if (foul) {
      game.turn = 1 - me; game.ballInHand = true;
      if (cueIn) { const cb = balls[0]; cb.in = false; cb.x = L * 0.25; cb.y = W / 2; cb.vx = 0; cb.vy = 0; }
      return 'Foul: ' + reason;
    }
    game.ballInHand = false;
    if (mine.length) return 'Masuk! Lanjut main';
    game.turn = 1 - me;
    return 'Ganti giliran';
  }

  function aimTrace(balls, ang) {
    const c = balls[0], dx = Math.cos(ang), dy = Math.sin(ang);
    let tWall = Infinity;
    if (dx > 1e-9) tWall = Math.min(tWall, (L - R - c.x) / dx); else if (dx < -1e-9) tWall = Math.min(tWall, (R - c.x) / dx);
    if (dy > 1e-9) tWall = Math.min(tWall, (W - R - c.y) / dy); else if (dy < -1e-9) tWall = Math.min(tWall, (R - c.y) / dy);
    let tBall = Infinity, hit = null;
    for (const b of balls) {
      if (b.id === 0 || b.in) continue;
      const fx = c.x - b.x, fy = c.y - b.y;
      const bb = fx * dx + fy * dy, cc = fx * fx + fy * fy - 4 * R * R;
      const disc = bb * bb - cc;
      if (disc < 0) continue;
      const t = -bb - Math.sqrt(disc);
      if (t > 0 && t < tBall) { tBall = t; hit = b.id; }
    }
    if (tBall < tWall) return { t: tBall, ball: hit };
    return { t: Math.max(0, tWall), ball: null };
  }

  function canPlace(balls, x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    if (!(x >= R && x <= L - R && y >= R && y <= W - R)) return false;
    for (const b of balls) {
      if (b.id === 0 || b.in) continue;
      if (Math.hypot(b.x - x, b.y - y) < 2 * R + 0.05) return false;
    }
    return true;
  }

  /* snapshot: {b:[[x,y,in]*16], g:game, msg} */
  function snapshot(balls, game, msg) {
    return {
      b: balls.map(b => [Math.round(b.x * 1000) / 1000, Math.round(b.y * 1000) / 1000, b.in ? 1 : 0]),
      g: JSON.parse(JSON.stringify(game)),
      msg: msg || '',
    };
  }
  function restore(balls, snap) {
    for (let i = 0; i < 16; i++) {
      const b = balls[i], s = snap.b[i];
      b.x = s[0]; b.y = s[1]; b.in = !!s[2]; b.vx = 0; b.vy = 0; b.spin = 0;
    }
    return JSON.parse(JSON.stringify(snap.g));
  }

  const API = {
    L, W, R, MAX_V, DT, POCKETS,
    makeBalls, newGame, newEvents, isMoving, launch, step,
    beginShot, resolve, aimTrace, canPlace, snapshot, restore, groupOf,
  };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.Billiard = API;
})(typeof window !== 'undefined' ? window : globalThis);
