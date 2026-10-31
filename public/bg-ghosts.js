/* NOXVOID — живой фон из призраков (canvas).
   Спрайты берутся из атласа assets/bg/ghosts-atlas.webp, их раскладки — из assets/bg/ghosts-data.js (window.NX_GHOSTS).
   Что делает: индивидуальный медленный дрейф и «глубина»; мягкое отталкивание от курсора (только мышь);
   клик/касание по призраку (бегство, замирание); редкие короткие глитчи. Всё рисуется позади интерфейса,
   событий мыши у холста нет. Один цикл requestAnimationFrame; при скрытой вкладке и prefers-reduced-motion цикл не работает. */
(function () {
  "use strict";
  var D = window.NX_GHOSTS, doc = document;
  var space = doc.querySelector(".bg-space"), cv = doc.querySelector(".bg-ghosts");
  if (!D || !space || !cv || !cv.getContext) return;

  var ctx = cv.getContext("2d");
  var mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
  var mqFine = matchMedia("(hover: hover) and (pointer: fine)");
  var mqMob = matchMedia("(max-width: 760px)");

  /* ---------- настройки (всё в одном месте) ---------- */
  var CFG = {
    idleMs: 50,              // в покое ~20 кадров/с (дрейф очень медленный)
    busyMs: 33,              // при реакции на курсор ~30 кадров/с; во время бегства/глитча — каждый кадр
    scale: [0.5, 0.5],      // разрешение холста: компьютер / телефон (тени размытые, так дешевле)
    repelMid: { R: 240, push: [90, 150], k: [3.2, 5.5] },   // радиус реакции, макс. смещение, жёсткость пружины
    repelFar: { R: 320, push: [50, 90], k: [2.2, 4] },
    watchChance: 0.16,       // шанс «замереть и наблюдать» вместо бегства
    maxBusy: 3,              // не больше стольких призраков в состоянии клика одновременно
    glitchEvery: [7000, 17000]
  };

  var img = new Image(), alpha = null, atlasOk = false;
  var spr = {}; D.sprites.forEach(function (s) { spr[s.id] = s; });
  var G = [], vw = 0, vh = 0, k = 1, q = 1, layoutKey = "", sparksCv = null, fast = false;
  var enabled = false, running = false, raf = 0, last = 0, lastDraw = 0, glTimer = 0, busy = false, lastNow = 0;
  var cur = { x: -9999, y: -9999, sx: -9999, sy: -9999, on: false };
  var prot = [], protAt = -1e9, fxs = [];
  var eyeCv = null, wa = null;
  var rnd = Math.random, rr = function (a, b) { return a + rnd() * (b - a); };
  var ease = function (u) { u = u < 0 ? 0 : u > 1 ? 1 : u; return u * u * (3 - 2 * u); };
  var easeOut = function (u) { u = u < 0 ? 0 : u > 1 ? 1 : u; return 1 - Math.pow(1 - u, 3); };

  /* ---------- сборка сцены ---------- */
  function build() {
    layoutKey = mqMob.matches ? "mobile" : "desktop";
    var L = D.layouts[layoutKey], m = mqMob.matches ? 0.7 : 1;
    G = L.items.map(function (it, i) {
      var s = spr[it.s], mid = s.layer === "mid", C = mid ? CFG.repelMid : CFG.repelFar, T = 6.283;
      return {
        s: s, id: it.s, i: i, mid: mid, nx: it.x, ny: it.y, sc: it.sc || 1, eyes: !!it.e, hx: 0, hy: 0,
        ax: rr(10, 30) * (mid ? 1 : 1.3) * m, ay: rr(8, 22) * (mid ? 1 : 1.3) * m,                 // амплитуды дрейфа
        fx1: T / rr(80, 190), fx2: T / rr(45, 100), fy1: T / rr(90, 210), fy2: T / rr(50, 110),         // периоды: у каждого свои
        px1: rr(0, T), px2: rr(0, T), py1: rr(0, T), py2: rr(0, T),
        zd: rr(0.03, 0.09) * (mid ? 1 : 0.6), fz: T / rr(60, 150), pz: rr(0, T),                      // приближение/удаление
        tw: rr(0, 400), pushx: 0, pushy: 0, vx: 0, vy: 0,
        kk: rr(C.k[0], C.k[1]), bias: rr(-0.35, 0.35), sens: rr(0.7, 1.3), R: C.R, maxPush: rr(C.push[0], C.push[1]),
        mode: "drift", mt: 0, md: 0, rfx: 0, rfy: 0, ex: 0, ey: 0, dirx: 0, diry: 0, dist: 0,
        ev: 1, evT: 1, ep: rr(0, T), ef: T / rr(5, 9), fl: -1e9, fd: 0, fk: 0, gl: null, dis: null, fl2: -1e9,
        x: 0, y: 0, s2: 1, a: 1, bm: 0
      };
    });
  }

  function view() {
    vw = innerWidth; vh = innerHeight; q = CFG.scale[mqMob.matches ? 1 : 0];
    cv.width = Math.round(vw * q); cv.height = Math.round(vh * q);
    var L = D.layouts[layoutKey]; k = Math.max(vw / L.W, vh / L.H);
    var ox = (vw - L.W * k) / 2, oy = (vh - L.H * k) / 2;
    G.forEach(function (g) { g.hx = ox + g.nx * L.W * k; g.hy = oy + g.ny * L.H * k; });
    drawSparks();
    refreshProt(performance.now());
  }

  // Искры: рисуются один раз на отдельном холсте под призраками (не перерисовываются каждый кадр)
  function drawSparks() {
    if (!sparksCv) { sparksCv = doc.createElement("canvas"); sparksCv.className = "bg-sparks"; space.insertBefore(sparksCv, cv); }
    sparksCv.width = vw; sparksCv.height = vh;
    var x = sparksCv.getContext("2d"), n = Math.round(vw * vh / 9500), s = 7;
    var r = function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (var i = 0; i < n; i++) {
      var px = r() * vw, py = Math.pow(r(), 0.8) * vh, c = r(), rad = 0.5 + r() * 0.85;
      var col = c < 0.78 ? "150,90,255" : c < 0.95 ? "225,120,255" : "198,255,0";
      x.fillStyle = "rgba(" + col + "," + (0.18 + r() * 0.34) + ")"; x.beginPath(); x.arc(px, py, rad, 0, 7); x.fill();
      if (rad > 1.05) { var g = x.createRadialGradient(px, py, 0, px, py, rad * 4); g.addColorStop(0, "rgba(" + col + ",.13)"); g.addColorStop(1, "rgba(" + col + ",0)"); x.fillStyle = g; x.beginPath(); x.arc(px, py, rad * 4, 0, 7); x.fill(); }
    }
  }
  function makeEye() {
    var c = doc.createElement("canvas"); c.width = c.height = 64; var x = c.getContext("2d");
    var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(198,255,0,.34)"); g.addColorStop(0.35, "rgba(198,255,0,.09)"); g.addColorStop(1, "rgba(198,255,0,0)");
    x.fillStyle = g; x.beginPath(); x.arc(32, 32, 32, 0, 7); x.fill();
    x.fillStyle = "rgba(244,255,232,.95)"; x.beginPath(); x.ellipse(32, 32, 7, 13, 0, 0, 7); x.fill();
    return c;
  }

  /* ---------- защищённые зоны (интерфейс) ---------- */
  var PROT = ".topbar,.strip,.identity > *,.modal-panel,.sec-head,.about-text,.facts,.clip,.foot > *";
  function refreshProt(now) {
    prot = []; protAt = now;
    var els = doc.querySelectorAll(PROT);
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) prot.push([r.left - 14, r.top - 14, r.right + 14, r.bottom + 14]);
    }
  }
  function inProt(x, y) { for (var i = 0; i < prot.length; i++) { var p = prot[i]; if (x >= p[0] && x <= p[2] && y >= p[1] && y <= p[3]) return true; } return false; }
  // Новое место для головы призрака: в его «зоне», вне текста и кнопок
  function pickSpot(g) {
    refreshProt(performance.now());
    var rx = (mqMob.matches ? 0.4 : 0.3) * vw, ry = 0.3 * vh;
    for (var i = 0; i < 40; i++) {
      var x = g.hx + rr(-rx, rx), y = g.hy + rr(-ry, ry);
      if (x < vw * 0.04 || x > vw * 0.96 || y < vh * 0.06 || y > vh * 0.94) continue;
      if (!inProt(x, y)) return { x: x, y: y };
    }
    return { x: g.hx, y: g.hy };
  }

  /* ---------- обновление ---------- */
  function place(g) {
    var w = g.tw;
    var ox = g.ax * (Math.sin(g.fx1 * w + g.px1) + 0.5 * Math.sin(g.fx2 * w + g.px2)) * k;
    var oy = g.ay * (Math.sin(g.fy1 * w + g.py1) + 0.5 * Math.sin(g.fy2 * w + g.py2)) * k;
    g.x = g.hx + g.rfx * vw + ox + g.pushx + g.ex;
    g.y = g.hy + g.rfy * vh + oy + g.pushy + g.ey;
    g.s2 = k * g.sc / g.s.res * (1 + g.zd * Math.sin(g.fz * w + g.pz)) * (g.mode === "watch" ? 1 + 0.03 * ease((lastNow - g.mt) / 700) : 1);
  }

  function update(dt, now) {
    lastNow = now; busy = fxs.length > 0; fast = busy;
    var repel = enabled && cur.on && mqFine.matches && !mqMob.matches;
    if (repel) { var f = 1 - Math.exp(-dt * 9); cur.sx += (cur.x - cur.sx) * f; cur.sy += (cur.y - cur.sy) * f; }
    if (now - protAt > 700) { refreshProt(now); G.forEach(function (g) { g.evT = inProt(g.x, g.y) ? 0 : 1; }); }
    for (var i = 0; i < G.length; i++) {
      var g = G[i], tm = (now - g.mt) / 1000;
      if (g.mode !== "watch") g.tw += dt;
      // мягкое отталкивание: целевое смещение зависит от расстояния до курсора, движение — пружина с инерцией
      var tx = 0, ty = 0;
      if (repel && (g.mode === "drift" || g.mode === "appear")) {
        var dx = g.x - cur.sx, dy = g.y - cur.sy, d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < g.R) {
          var st = Math.pow(1 - d / g.R, 2), c = Math.cos(g.bias), s = Math.sin(g.bias);
          var ux = (dx * c - dy * s) / d, uy = (dx * s + dy * c) / d;
          tx = ux * st * g.maxPush * g.sens * k; ty = uy * st * g.maxPush * g.sens * k;
        }
      }
      var cc = 2 * Math.sqrt(g.kk) * 0.85;
      g.vx += (g.kk * (tx - g.pushx) - cc * g.vx) * dt; g.vy += (g.kk * (ty - g.pushy) - cc * g.vy) * dt;
      g.pushx += g.vx * dt; g.pushy += g.vy * dt;
      if (Math.abs(tx) + Math.abs(ty) > 0.5 || Math.abs(g.vx) + Math.abs(g.vy) > 0.4) busy = true;
      // состояния
      var bm = 0, a = 1;
      if (g.mode === "flee") {
        var e = easeOut(tm / g.md); g.ex = g.dirx * g.dist * e; g.ey = g.diry * g.dist * e;
        var u = (tm - 0.3) / (g.md - 0.3); a = u <= 0 ? 1 : 1 - ease(u); bm = ease(u);
        if (tm >= g.md) { g.mode = "gone"; g.mt = now; g.md = rr(1.5, 4.5); }
      } else if (g.mode === "gone") {
        a = 0;
        if (tm >= g.md) { var sp = pickSpot(g); g.rfx = (sp.x - g.hx) / vw; g.rfy = (sp.y - g.hy) / vh; g.ex = g.ey = 0; g.pushx = g.pushy = g.vx = g.vy = 0; g.mode = "appear"; g.mt = now; g.md = 1.6; g.fl = now; g.fk = 0.4; g.fd = 0.5; }
      } else if (g.mode === "appear") {
        var ua = ease(tm / g.md); a = ua; bm = 1 - ua;
        if (tm >= g.md) { g.mode = "drift"; g.mt = now; }
      } else if (g.mode === "watch" && tm >= g.md) { g.mode = "drift"; g.mt = now; }
      if (g.dis) {
        var du = (now - g.dis.t0) / g.dis.d;
        if (du >= 1) { g.dis = null; } else { var bu = du < 0.3 ? ease(du / 0.3) : du < 0.6 ? 1 : 1 - ease((du - 0.6) / 0.4); a *= 1 - 0.9 * bu; bm = Math.max(bm, bu); }
      }
      g.a = a; g.bm = bm;
      if (g.mode !== "drift") busy = true;
      if (g.mode === "flee" || g.mode === "appear" || g.gl) fast = true;
      g.ev += (g.evT - g.ev) * Math.min(1, dt * 4);
      if (g.gl && (now - g.gl.t0) / g.gl.d >= 1) { g.gl = null; g.s.tp = g.s.tg = null; }
      place(g);
    }
    for (var j = fxs.length - 1; j >= 0; j--) if ((now - fxs[j].t0) / fxs[j].d >= 1) fxs.splice(j, 1);
  }

  /* ---------- отрисовка ---------- */
  function tintOf(sp, which) {
    var key = which === "p" ? "tp" : "tg"; if (sp[key]) return sp[key];
    var c = doc.createElement("canvas"); c.width = sp.w; c.height = sp.h; var x = c.getContext("2d");
    x.drawImage(sp.cv, 0, 0); x.globalCompositeOperation = "source-in";
    x.fillStyle = which === "p" ? "rgb(160,80,255)" : "rgb(198,255,0)"; x.fillRect(0, 0, sp.w, sp.h);
    sp[key] = c; return c;
  }
  function blurOf(sp) {
    if (sp.bl !== undefined && sp.bl !== null) { sp.blAt = lastNow; return sp.bl; }
    if (!("filter" in ctx)) { sp.bl = null; return null; }
    var p = 24, c = doc.createElement("canvas"); c.width = sp.w + 2 * p; c.height = sp.h + 2 * p; var x = c.getContext("2d");
    x.filter = "blur(10px)"; x.drawImage(sp.cv, p, p); sp.bl = c; sp.blAt = lastNow; return c;
  }

  function drawGhost(g, now) {
    var sp = g.s, a = g.a; if (a < 0.01) return;
    var s = g.s2, dx = g.x - sp.ax * s, dy = g.y - sp.ay * s, dw = sp.w * s, dh = sp.h * s;
    if (dx > vw || dy > vh || dx + dw < 0 || dy + dh < 0) return;
    var gl = g.gl, gu = gl ? (now - gl.t0) / gl.d : 1;
    if (gl && gu < 1) {      // RGB-разнос: фиолетовая и зелёная копии, затухает к концу
      var am = gl.amp * (1 - gu) * s;
      ctx.globalAlpha = a * 0.6 * (1 - gu); ctx.drawImage(tintOf(sp, "p"), 0, 0, sp.w, sp.h, dx - am, dy, dw, dh);
      ctx.globalAlpha = a * 0.45 * (1 - gu); ctx.drawImage(tintOf(sp, "g"), 0, 0, sp.w, sp.h, dx + am, dy + am * 0.15, dw, dh);
    }
    var bl = g.bm > 0.04 ? blurOf(sp) : null;
    ctx.globalAlpha = bl ? a * (1 - g.bm * 0.85) : a;
    if (gl && gu < 1 && gl.slices) {   // горизонтальные смещения полос
      for (var i = 0; i < gl.slices.length; i++) {
        var q = gl.slices[i], sy = Math.floor(q.f0 * sp.h), sh = Math.max(1, Math.ceil((q.f1 - q.f0) * sp.h));
        ctx.drawImage(sp.cv, 0, sy, sp.w, sh, dx + q.dx * s * (1 - gu), dy + sy * s, dw, sh * s);
      }
    } else ctx.drawImage(sp.cv, 0, 0, sp.w, sp.h, dx, dy, dw, dh);
    if (bl) { ctx.globalAlpha = a * g.bm * 0.9; ctx.drawImage(bl, dx - 24 * s, dy - 24 * s, bl.width * s, bl.height * s); }
  }

  function drawEyes(g, now) {
    var sp = g.s, a = g.a; if (a < 0.02 || !sp.eyes.length) return;
    var t = now / 1000, e = g.eyes ? (0.34 + 0.24 * Math.sin(t * g.ef + g.ep)) * g.ev : 0;
    var fu = (now - g.fl) / 1000, fe = 0;
    if (fu >= 0 && fu < g.fd + 0.45) fe = (fu < 0.07 ? fu / 0.07 : fu < 0.07 + g.fd ? 1 : 1 - (fu - 0.07 - g.fd) / 0.38) * (g.fk || 1);
    var f2 = (now - g.fl2) / 1000; if (f2 >= 0 && f2 < 0.25) fe = Math.max(fe, f2 < 0.05 ? f2 / 0.05 : 1 - (f2 - 0.05) / 0.2);
    if (g.mode === "watch") fe = Math.max(fe, 0.85 * ease((now - g.mt) / 400));
    if (fe < 0) fe = 0; e = Math.max(e, fe);
    if (e < 0.02) return;
    var s = g.s2, dx = g.x - sp.ax * s, dy = g.y - sp.ay * s, r = 0.04 * sp.S * sp.res * s * (1 + 1.1 * fe) * 1.2;
    ctx.globalAlpha = Math.min(1, e) * (g.mode === "flee" ? Math.max(a, 0.25) : a);
    for (var i = 0; i < sp.eyes.length; i++) {
      var ey = sp.eyes[i], X = dx + ey[0] * s, Y = dy + ey[1] * s;
      if (g.mode === "watch" && cur.on) { var vx = cur.sx - X, vy = cur.sy - Y, d = Math.sqrt(vx * vx + vy * vy) || 1, m = Math.min(3 * s, d * 0.02); X += vx / d * m; Y += vy / d * m; }
      ctx.save(); ctx.translate(X, Y); ctx.rotate(ey[2] + Math.PI / 2); ctx.drawImage(eyeCv, -r, -r, 2 * r, 2 * r); ctx.restore();
    }
  }

  function draw(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, cv.width, cv.height); ctx.setTransform(q, 0, 0, q, 0, 0);
    for (var i = 0; i < G.length; i++) drawGhost(G[i], now);
    for (var j = 0; j < G.length; j++) drawEyes(G[j], now);
    for (var fi = 0; fi < fxs.length; fi++) drawFx(fxs[fi], now);       // не «q»: имя занято масштабом холста
    ctx.globalAlpha = 1;
  }
  function drawFx(f, now) {     // тонкие цифровые полосы и кратковременный «разрыв» строки холста
    var u = (now - f.t0) / f.d, al = 1 - u;
    f.bars.forEach(function (b) { ctx.globalAlpha = b.a * al; ctx.fillStyle = b.c; ctx.fillRect(b.x, b.y, b.w, b.h); });
    if (f.tear && u < 0.6) { ctx.globalAlpha = 0.75; ctx.drawImage(cv, 0, f.tear.y * q, cv.width, f.tear.h * q, f.tear.dx, f.tear.y, vw, f.tear.h); }
  }

  /* ---------- цикл ---------- */
  function loop(now) {
    raf = 0; if (!running) return;
    if (!fast && now - lastDraw < (busy ? CFG.busyMs : CFG.idleMs)) { raf = requestAnimationFrame(loop); return; }
    var dt = Math.min(0.08, (now - last) / 1000); last = now; lastDraw = now;
    update(dt, now); draw(now);
    raf = requestAnimationFrame(loop);
  }
  function start() { if (running || !enabled || doc.hidden || !atlasOk) return; running = true; last = performance.now(); raf = requestAnimationFrame(loop); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function staticFrame() { var now = performance.now(); lastNow = now; G.forEach(function (g) { g.evT = 1; g.ev = 1; g.a = 1; g.bm = 0; place(g); }); draw(now); }

  /* ---------- курсор, клики, касания ---------- */
  function onMove(e) {
    if (e.pointerType && e.pointerType !== "mouse") return;
    if (!cur.on) { cur.sx = e.clientX; cur.sy = e.clientY; }
    cur.x = e.clientX; cur.y = e.clientY; cur.on = true;
  }
  function onLeave() { cur.on = false; cur.sx = cur.sy = -9999; }

  var HERO = ".hero-art";
  function wraithAt(x, y) {       // курсор над самим персонажем (непрозрачный пиксель арта)
    var im = doc.getElementById("heroImg"); if (!im || !im.naturalWidth) return false;
    if (!wa) {
      try {
        var c = doc.createElement("canvas"); c.width = 96; c.height = Math.round(96 * im.naturalHeight / im.naturalWidth);
        var x2 = c.getContext("2d"); x2.drawImage(im, 0, 0, c.width, c.height); wa = { w: c.width, h: c.height, d: x2.getImageData(0, 0, c.width, c.height).data };
      } catch (err) { wa = { bad: 1 }; }
    }
    if (wa.bad) return true;
    var r = im.getBoundingClientRect(), s = Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
    var pos = (getComputedStyle(im).objectPosition || "50% 50%").split(" ");
    var u = (x - (r.left + (r.width - w) * parseFloat(pos[0]) / 100)) / w, v = (y - (r.top + (r.height - h) * parseFloat(pos[1]) / 100)) / h;
    if (u < 0 || v < 0 || u > 1 || v > 1) return false;
    return wa.d[(Math.min(wa.h - 1, v * wa.h | 0) * wa.w + Math.min(wa.w - 1, u * wa.w | 0)) * 4 + 3] > 40;
  }
  // Пустое место страницы: сам html/body/контейнер, а не текст, кнопка, ссылка или персонаж
  function isBgTarget(t, x, y) {
    if (!t || t.nodeType !== 1) return false;
    if (t.closest(HERO)) return !wraithAt(x, y);
    var n = t.tagName; if (n === "HTML" || n === "BODY") return true;
    return t.matches(".app,.stage,.sections,.sec,.foot,.about-grid");
  }

  function alphaAt(sp, u, v) {
    if (!alpha || u < 0 || v < 0 || u >= sp.w || v >= sp.h) return 0;
    return alpha[(sp.y + (v | 0)) * D.w + sp.x + (u | 0)];
  }
  function hit(x, y) {
    for (var i = G.length - 1; i >= 0; i--) {
      var g = G[i]; if (g.a < 0.3 || (g.mode !== "drift" && g.mode !== "appear" && g.mode !== "watch")) continue;
      var sp = g.s, s = g.s2, dx = x - g.x, dy = y - g.y;
      if (Math.sqrt(dx * dx + dy * dy) < 0.125 * sp.S * sp.res * s * 1.5) return g;       // голова с запасом
      var u = sp.ax + dx / s, v = sp.ay + dy / s, pad = 9 / s;
      if (alphaAt(sp, u, v) > 90 || alphaAt(sp, u + pad, v) > 90 || alphaAt(sp, u - pad, v) > 90 || alphaAt(sp, u, v + pad) > 90 || alphaAt(sp, u, v - pad) > 90) return g;
    }
    return null;
  }
  function onDown(e) {
    if (e.button > 0 || !isBgTarget(e.target, e.clientX, e.clientY)) return;
    var g = hit(e.clientX, e.clientY); if (g) trigger(g, e.clientX, e.clientY, null);
  }

  function slices(n, amt) {
    var out = [], y = 0, hot = 2 + (rnd() * 2 | 0);
    for (var i = 0; i < n; i++) { var h = (i === n - 1) ? 1 - y : rr(0.06, 0.2); h = Math.min(h, 1 - y); out.push({ f0: y, f1: y + h, dx: (i % Math.max(2, (n / hot) | 0) === 1 ? rr(-amt, amt) : 0) }); y += h; if (y >= 1) break; }
    out[out.length - 1].f1 = 1; return out;
  }
  function clearFx(g) { g.gl = null; g.dis = null; g.fl2 = -1e9; g.s.tp = g.s.tg = null; }

  // Реакция на клик/касание. kind: "flee" | "watch" | null (случайно, «замереть» бывает редко)
  function trigger(g, px, py, kind) {
    if (g.mode !== "drift" && g.mode !== "appear") return false;
    var cnt = 0; G.forEach(function (o) { if (o.mode !== "drift") cnt++; }); if (cnt >= CFG.maxBusy) return false;
    var now = performance.now(); clearFx(g);
    kind = kind || (rnd() < CFG.watchChance ? "watch" : "flee");
    g.fl = now; g.fd = 0.14; g.fk = 1;                                             // 1) вспышка глаз
    if (kind === "watch") { g.mode = "watch"; g.mt = now; g.md = rr(2.4, 3.8); g.gl = { t0: now, d: 260, amp: 3, slices: null }; }
    else {
      g.gl = { t0: now, d: 520, amp: rr(7, 11), slices: slices(8, 22) };             // 2) локальный RGB-глитч
      var ang = Math.atan2(g.y - py, g.x - px) + rr(-0.35, 0.35);
      g.dirx = Math.cos(ang); g.diry = Math.sin(ang); g.dist = rr(150, 260) * k * (g.mid ? 1 : 0.7);   // 3) бегство от точки клика
      g.ex = g.ey = 0; g.mode = "flee"; g.mt = now; g.md = rr(1.1, 1.5);                              // 4) растворение внутри update()
    }
    busy = true; fast = true; if (!running) start();      // fast: следующий же кадр рисуем сразу, без ожидания «покойной» частоты
    return true;
  }

  /* ---------- редкие фоновые глитчи ---------- */
  function onScreen(g) { return g.x > 0 && g.x < vw && g.y > 0 && g.y < vh; }
  function glitchOnce() {
    if (doc.hidden || !running) return;
    var now = performance.now();
    G.forEach(function (g) { var sp = g.s; if (sp.bl && now - (sp.blAt || 0) > 15000) sp.bl = null; });   // освобождаем кэш размытых копий
    var pool = G.filter(function (g) { return g.mode === "drift" && g.a > 0.5 && onScreen(g) && !g.gl && !g.dis; });
    if (!pool.length || fxs.length) return;
    var g = pool[(rnd() * pool.length) | 0], r = rnd();
    if (r < 0.28) g.gl = { t0: now, d: 240, amp: 0, slices: slices(7, 26) };
    else if (r < 0.5) g.gl = { t0: now, d: 300, amp: rr(5, 9), slices: null };
    else if (r < 0.68) {
      var bars = [], n = 2 + (rnd() * 2 | 0);
      for (var i = 0; i < n; i++) bars.push({ x: rr(0, vw * 0.4), y: rr(vh * 0.1, vh * 0.9) | 0, w: rr(vw * 0.2, vw * 0.6), h: 1 + (rnd() * 2 | 0), a: rr(0.07, 0.14), c: rnd() < 0.6 ? "rgb(150,80,255)" : "rgb(198,255,0)" });
      fxs.push({ t0: now, d: 170, bars: bars, tear: rnd() < 0.5 ? { y: rr(vh * 0.15, vh * 0.8) | 0, h: 6 + (rnd() * 14 | 0), dx: rr(-18, 18) } : null });
    } else if (r < 0.82) g.fl2 = now;
    else g.dis = { t0: now, d: 2200 };                       // силуэт растворяется в дымке и возвращается
  }
  function scheduleGlitch() {
    clearTimeout(glTimer); if (!enabled) return;
    glTimer = setTimeout(function () { glitchOnce(); scheduleGlitch(); }, rr(CFG.glitchEvery[0], CFG.glitchEvery[1]));
  }

  /* ---------- жизненный цикл ---------- */
  var rzT = 0;
  function onResize() {
    clearTimeout(rzT);
    rzT = setTimeout(function () {
      var key = mqMob.matches ? "mobile" : "desktop";
      if (key !== layoutKey) build();
      view(); if (!enabled) staticFrame();
    }, 150);
  }
  function onVis() { if (doc.hidden) stop(); else start(); }

  function enable() {
    if (enabled) return; enabled = true; wa = null;
    doc.addEventListener("pointermove", onMove, { passive: true });
    doc.addEventListener("pointerdown", onDown, { passive: true });
    doc.documentElement.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onLeave);
    doc.addEventListener("visibilitychange", onVis);
    start(); scheduleGlitch();
  }
  function disable() {
    enabled = false; stop(); clearTimeout(glTimer); fxs = []; cur.on = false;
    doc.removeEventListener("pointermove", onMove); doc.removeEventListener("pointerdown", onDown);
    doc.documentElement.removeEventListener("mouseleave", onLeave); window.removeEventListener("blur", onLeave);
    doc.removeEventListener("visibilitychange", onVis);
    G.forEach(function (g) { g.mode = "drift"; g.ex = g.ey = g.pushx = g.pushy = g.vx = g.vy = 0; clearFx(g); });
  }
  function apply() { if (mqReduce.matches) { disable(); view(); staticFrame(); } else { enable(); } }

  img.onload = function () {
    try {       // карта прозрачности атласа для точных кликов (при file:// недоступна — тогда по голове)
      var c = doc.createElement("canvas"); c.width = D.w; c.height = D.h; var x = c.getContext("2d");
      x.drawImage(img, 0, 0); var d = x.getImageData(0, 0, D.w, D.h).data; alpha = new Uint8Array(D.w * D.h);
      for (var i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
    } catch (err) { alpha = null; }
    D.sprites.forEach(function (sp) {        // каждый спрайт — в свой небольшой холст: рисовать из него быстрее, чем из подпрямоугольника огромного атласа
      var c = doc.createElement("canvas"); c.width = sp.w; c.height = sp.h; c.getContext("2d").drawImage(img, sp.x, sp.y, sp.w, sp.h, 0, 0, sp.w, sp.h); sp.cv = c;
    });
    atlasOk = true; eyeCv = makeEye(); build(); view();
    window.addEventListener("resize", onResize);
    if (mqReduce.addEventListener) mqReduce.addEventListener("change", apply); else if (mqReduce.addListener) mqReduce.addListener(apply);
    apply();
  };
  img.onerror = function () { /* атлас недоступен — остаются дымка и туман */ };
  function begin() { img.src = D.atlas; }
  if (doc.readyState === "complete") setTimeout(begin, 150); else window.addEventListener("load", function () { setTimeout(begin, 150); });

  // Небольшой интерфейс для проверки и отладки (ничего не меняет сам)
  window.NXBG = {
    ghosts: function () { return G; },
    trigger: function (i, kind) { var g = G[i]; return g ? trigger(g, g.x - 40, g.y, kind) : false; },
    spot: function (i) { return G[i] ? pickSpot(G[i]) : null; },
    isBgTarget: isBgTarget, hit: hit,
    state: function () { return { enabled: enabled, running: running, layout: layoutKey, count: G.length, atlas: atlasOk, hitMap: !!alpha, k: k, fx: fxs.length, fine: mqFine.matches }; }
  };
})();
