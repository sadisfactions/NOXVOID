/* GLITCH//CORE — config binding + glitch scheduler.
   Эффекты запускаются редкими событиями через setTimeout (не rAF-цикл)
   и анимируются через Web Animations API (transform/opacity/clip-path). */
(function () {
  "use strict";

  var cfg = window.GLITCH_CONFIG || {};
  var doc = document;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };

  /* ---------- 1. Apply config ---------- */
  var root = doc.documentElement;
  if (cfg.colors) {
    if (cfg.colors.accent) root.style.setProperty("--lime", cfg.colors.accent);
    if (cfg.colors.accent2) root.style.setProperty("--purple", cfg.colors.accent2);
  }
  $$("[data-bind]").forEach(function (el) {
    var v = cfg[el.getAttribute("data-bind")];
    if (v != null) el.textContent = v;
  });
  if (cfg.nickname) {
    doc.title = cfg.nickname + " — стример Dota 2";
    $("#nick").setAttribute("aria-label", cfg.nickname);
  }
  $$("[data-link]").forEach(function (a) {
    var url = cfg.links && cfg.links[a.getAttribute("data-link")];
    if (url) a.href = url;
  });
  $$(".btn-label").forEach(function (l) { l.setAttribute("data-text", l.textContent); });
  $$(".brand-logo").forEach(function (l) { l.setAttribute("data-text", l.textContent); });

  /* ---------- 1b. Расписание ---------- */
  // Источник данных: сначала config.js (запасной вариант и работа без сервера),
  // затем /api/schedule из панели управления (если доступен) — см. блок 1d.
  var sch = cfg.schedule || { days: [] };
  var tzLabel = "", weekly = [], overrides = {};

  function setSchedule(s) {
    sch = s;
    tzLabel = s.timezoneLabel || "";
    weekly = (s.days || []).slice(0, 7);
    // Разовые изменения { date: "ГГГГ-ММ-ДД", active, start, end } заменяют недельный план на эту дату.
    overrides = {};
    (s.overrides || []).forEach(function (o) { if (o && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) overrides[o.date] = o; });
  }
  setSchedule(sch);

  var isoOf = function (dn) { return new Date(dn * 86400000).toISOString().slice(0, 10); };
  function planFor(dn, dow) {
    var o = overrides[isoOf(dn)], w = weekly[dow] || {};
    if (o) return { active: !!(o.active && o.start), start: o.start, end: o.end, changed: true, w: w };
    return { active: !!(w.active && w.start), start: w.start, end: w.end, changed: false, w: w };
  }

  // Текущая дата/время в часовом поясе расписания (dayNum — номер дня для арифметики дат)
  function tzNow() {
    var now = new Date(), dow, mins, dayNum;
    try {
      var p = {};
      new Intl.DateTimeFormat("en-US", { timeZone: sch.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(now).forEach(function (x) { p[x.type] = x.value; });
      dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
      mins = (+p.hour % 24) * 60 + (+p.minute);
      dayNum = Date.UTC(+p.year, +p.month - 1, +p.day) / 86400000;
      if (dow < 0 || isNaN(dayNum)) throw 0;
    } catch (e) {
      dow = (now.getDay() + 6) % 7; mins = now.getHours() * 60 + now.getMinutes();
      dayNum = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000;
    }
    return { dow: dow, mins: mins, sec: now.getSeconds(), dayNum: dayNum };
  }

  var daysEl = $("#schedDays");
  var pulseEls = [];   // общий массив: на него ссылается таймер импульсов, поэтому меняем его на месте

  function renderWeek() {
    daysEl.textContent = "";
    pulseEls.length = 0;
    var T0 = tzNow(), todayIdx = T0.dow;
    var tzEl = $("#schedTz");
    tzEl.textContent = "";
    if (weekly[todayIdx]) {
      tzEl.appendChild(doc.createTextNode("СЕГОДНЯ: "));
      var tb = doc.createElement("b"); tb.textContent = weekly[todayIdx].short; tzEl.appendChild(tb);
      if (tzLabel) tzEl.appendChild(doc.createTextNode(" · ВРЕМЯ: " + tzLabel));
    } else if (tzLabel) {
      tzEl.textContent = "ВРЕМЯ: " + tzLabel;
    }
    weekly.forEach(function (d, i) {
      var p = planFor(T0.dayNum - T0.dow + i, i), on = p.active;
      var cancelled = p.changed && !on && !!(d.active && d.start);   // стрим по плану был, но отменён
      var li = doc.createElement("li");
      li.className = "day" + (on ? " is-on" : "") + (p.changed && (on || cancelled) ? " is-changed" : "") + (i === todayIdx ? " is-today" : "");
      if (i === todayIdx) li.setAttribute("aria-current", "date");
      li.setAttribute("aria-label", (d.full || d.short) + ": " + (on ? "стрим в " + p.start + (p.end ? "–" + p.end : "") + " " + tzLabel + (p.changed ? " (изменение)" : "") : cancelled ? "стрим отменён" : "выходной"));
      var lamp = doc.createElement("span");
      lamp.className = "day-lamp"; lamp.setAttribute("aria-hidden", "true");
      lamp.innerHTML = '<i class="lamp-glow"></i><span class="lamp-core"><i class="lamp-pulse"></i></span>';
      var name = doc.createElement("span");
      name.className = "day-name"; name.setAttribute("aria-hidden", "true"); name.textContent = d.short;
      var time = doc.createElement("span");
      time.className = "day-time"; time.setAttribute("aria-hidden", "true");
      time.textContent = on ? p.start : cancelled ? "отмена" : "";
      if (on) {
        // у каждого активного дня своя скорость и фаза свечения — без синхронного мигания
        li.style.setProperty("--dur", (3.4 + Math.random() * 3).toFixed(2) + "s");
        li.style.setProperty("--delay", (-Math.random() * 5).toFixed(2) + "s");
        pulseEls.push($(".lamp-pulse", lamp));
      }
      li.appendChild(lamp); li.appendChild(name); li.appendChild(time);
      daysEl.appendChild(li);
    });
  }
  renderWeek();

  // «Следующий стрим» считается по плану (с учётом разовых изменений); это не статус эфира.
  function nextStream() {
    var t = tzNow();
    for (var off = 0; off < 15; off++) {
      var dow = (t.dow + off) % 7, p = planFor(t.dayNum + off, dow);
      if (!p.active) continue;
      var hm = p.start.split(":");
      var rem = (off * 1440 + (+hm[0]) * 60 + (+hm[1]) - t.mins) * 60 - t.sec;
      if (rem > 0) return { rem: rem, off: off, p: p, w: p.w };
    }
    return null;
  }
  var nextBox = $(".next"), cdEls = {};
  $$("#countdown [data-u]").forEach(function (b) { cdEls[b.getAttribute("data-u")] = b; });
  var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
  function renderNext() {
    var n = nextStream();
    var cnt = nextBox.querySelector(".next-count");
    if (!n) {
      $("#nextText").textContent = "расписание не задано";
      $("#nextWhen").textContent = "НЕ ЗАДАНО";
      cnt.style.display = "none";
      return false;
    }
    cnt.style.display = "";
    var label = n.off === 0 ? "сегодня" : n.off === 1 ? "завтра" : n.w.short;
    $("#nextText").textContent = label + ", " + n.p.start + (tzLabel ? " " + tzLabel : "");
    $("#nextWhen").textContent = (n.off < 2 ? label : n.w.full || n.w.short).toUpperCase() + " · " + n.p.start;
    var r = n.rem;
    var v = { d: Math.floor(r / 86400), h: Math.floor(r % 86400 / 3600), m: Math.floor(r % 3600 / 60), s: r % 60 };
    for (var k in v) if (cdEls[k] && cdEls[k].textContent !== pad(v[k])) cdEls[k].textContent = pad(v[k]);
    return true;
  }
  var cdTimer = 0;
  function cdStart() { if (!cdTimer && renderNext()) cdTimer = setInterval(renderNext, 1000); }
  function cdStop() { clearInterval(cdTimer); cdTimer = 0; }
  cdStart(); renderNext();

  // Статус эфира. Состояния: "live" | "offline" | "unknown" (источник данных неизвестен — не выдаём его за «офлайн»).
  // Начальное значение — config.js (statusLive), затем его заменяет ответ сервера (ручной переключатель или Twitch).
  // Все места на странице (шапка, расписание, нижняя строка) обновляются отсюда, поэтому не противоречат друг другу.
  var LIVE_TEXT = {
    live:    { label: "В ЭФИРЕ",             strip: "да",        next: "В ЭФИРЕ · СЛЕДУЮЩИЙ СТРИМ" },
    offline: { label: "НЕ В ЭФИРЕ",          strip: "нет",       next: "СЛЕДУЮЩИЙ СТРИМ" },
    unknown: { label: "СТАТУС УТОЧНЯЕТСЯ",   strip: "нет данных", next: "СЛЕДУЮЩИЙ СТРИМ" }
  };
  function setLive(st) {
    if (st === true) st = "live"; else if (!LIVE_TEXT[st]) st = "offline";
    var t = LIVE_TEXT[st];
    doc.body.classList.toggle("is-live", st === "live");
    doc.body.classList.toggle("is-unknown", st === "unknown");
    var set = function (sel, v) { var e = $(sel); if (e && e.textContent !== v) e.textContent = v; };
    set("#statusLabel", t.label); set("#liveChipText", t.label); set("#liveBadgeText", t.label); set("#liveText", t.strip); set(".next-k", t.next);
    ["#liveChip", "#liveBadge"].forEach(function (s) { var e = $(s); if (e) e.setAttribute("aria-label", "Статус трансляции: " + t.label); });
  }
  setLive(!!cfg.statusLive);

  /* ---------- 1d. Актуальное расписание из панели управления ---------- */
  // Работает только на сайте по http(s). Если API недоступен или пуст — остаются данные из config.js.
  // Запросы: при загрузке, раз в ~60 с пока вкладка видна, при возврате на вкладку и при появлении сети.
  var remote = { version: null, last: 0, busy: false, timer: 0 };
  var remoteOn = /^https?:$/.test(location.protocol);

  function validRemote(d) {
    return d && Array.isArray(d.days) && d.days.length === 7 && typeof d.timezone === "string" &&
      d.days.every(function (x) { return x && typeof x.short === "string"; });
  }
  function loadRemote() {
    if (!remoteOn || remote.busy || !window.fetch) return;
    remote.busy = true;
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    fetch("/api/schedule", { cache: "no-cache", signal: ctl ? ctl.signal : undefined })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!validRemote(data)) return;
        if (data.version !== remote.version) {
          remote.version = data.version;
          setSchedule(data);
          renderWeek();
          cdStop();
          if (doc.hidden) renderNext(); else cdStart();
        }
        setLive(data.live && (data.live.state || (data.live.on ? "live" : "offline")));
      })
      .catch(function () { /* сеть или сервер недоступны — оставляем последние известные данные */ })
      .then(function () { clearTimeout(t); remote.busy = false; remote.last = Date.now(); });
  }
  function pollLater() {
    clearTimeout(remote.timer);
    if (!remoteOn || doc.hidden) return;                       // в фоновой вкладке запросов нет
    remote.timer = setTimeout(function () { loadRemote(); pollLater(); }, 50000 + Math.random() * 20000);   // 60 с ± 10 с
  }
  if (remoteOn) {
    loadRemote(); pollLater();
    doc.addEventListener("visibilitychange", function () {
      if (doc.hidden) { clearTimeout(remote.timer); return; }
      renderWeek();                                            // обновить отметку «сегодня» после долгого простоя
      if (Date.now() - remote.last > 30000) loadRemote();      // данные могли устареть
      pollLater();
    });
    window.addEventListener("online", function () { loadRemote(); });
  }

  var heroSrc = cfg.heroImage || "assets/hero-placeholder.svg";
  // Мягкая подсветка глаз героя (config.js -> heroEyes). Позиция считается по реальному положению
  // картинки внутри блока (object-fit: contain + object-position), поэтому верна на любом экране.
  var eyeEl = $("#eyeGlow"), eyeCfg = cfg.heroEyes, heroBase = $("#heroImg");
  function placeEyes() {
    if (!eyeEl) return;
    if (!eyeCfg || !heroBase.naturalWidth) { eyeEl.hidden = true; return; }
    var r = heroBase.getBoundingClientRect(), s = Math.min(r.width / heroBase.naturalWidth, r.height / heroBase.naturalHeight);
    if (!(s > 0)) return;
    var w = heroBase.naturalWidth * s, h = heroBase.naturalHeight * s;
    var pos = (getComputedStyle(heroBase).objectPosition || "50% 50%").split(" ");
    var x = (r.width - w) * (parseFloat(pos[0]) / 100) + w * eyeCfg.x;
    var y = (r.height - h) * (parseFloat(pos[1]) / 100) + h * eyeCfg.y;
    var st = $("#artFloat").style;
    st.setProperty("--eye-x", x.toFixed(1) + "px"); st.setProperty("--eye-y", y.toFixed(1) + "px"); st.setProperty("--eye-s", Math.max(24, w * .075).toFixed(1) + "px");
    eyeEl.hidden = false;
  }
  var eyeRaf = 0;
  heroBase.addEventListener("load", placeEyes);
  window.addEventListener("resize", function () { cancelAnimationFrame(eyeRaf); eyeRaf = requestAnimationFrame(placeEyes); });
  $$(".layer, .slice img").forEach(function (img) { img.src = heroSrc; });
  if (heroBase.complete) placeEyes();
  $("#heroImg").alt = cfg.heroAlt || "Арт героя";
  root.style.setProperty("--hero", 'url("' + heroSrc + '")');
  doc.documentElement.classList.add("js");
  var slogan = $("#slogan"); slogan.setAttribute("data-text", slogan.textContent);
  $$(".sec-title").forEach(function (t) { t.setAttribute("data-text", t.textContent); });
  $$("[data-demo]").forEach(function (t) { t.hidden = cfg.demo === false; });

  /* ---------- 1c. Секции ниже первого экрана ---------- */
  function el(tag, cls, html) { var e = doc.createElement(tag); if (cls) e.className = cls; if (html != null) e.textContent = html; return e; }
  // Включение/выключение секций из config.js (sections.about / sections.highlights)
  var secCfg = cfg.sections || {};
  [["about", "#about"], ["highlights", "#moments"]].forEach(function (s) {
    if (secCfg[s[0]] === false) {
      var node = $(s[1]); if (node) node.remove();
      var link = $('.strip-nav a[href="' + s[1] + '"]'); if (link) link.remove();
    }
  });
  if (!$(".strip-nav a")) { var sn = $(".strip-nav"); if (sn) sn.remove(); }

  if (cfg.about && $("#about")) {
    $("#aboutText").textContent = cfg.about.text || "";
    (cfg.about.facts || []).forEach(function (f) {
      var li = el("li"); li.appendChild(el("span", "fact-k", f.k)); li.appendChild(el("span", "fact-v", f.v));
      $("#aboutFacts").appendChild(li);
    });
  }
  var thumbPos = ["60% 6%", "20% 30%", "80% 15%", "50% 40%", "35% 8%", "70% 55%"];
  ($("#momentsGrid") ? (cfg.highlights || []) : []).slice(0, 6).forEach(function (h, i) {
    var a = el("a", "clip");
    a.href = h.url || (cfg.links && cfg.links.highlights) || "#";
    a.target = "_blank"; a.rel = "noopener noreferrer";
    var th = el("div", "thumb");
    if (h.thumb) { th.style.backgroundImage = 'url("' + h.thumb + '")'; th.style.backgroundSize = "cover"; th.style.backgroundPosition = "center"; }
    else { th.style.setProperty("--pos", thumbPos[i % thumbPos.length]); th.style.setProperty("--zoom", (150 + (i % 3) * 25) + "%"); }
    th.appendChild(el("span", "thumb-shade"));
    th.appendChild(el("span", "thumb-play"));
    if (h.meta) th.appendChild(el("span", "thumb-dur", h.meta));
    a.appendChild(th); a.appendChild(el("div", "clip-title", h.title));
    a.classList.add("reveal"); a.style.transitionDelay = (i % 3) * 80 + "ms";
    $("#momentsGrid").appendChild(a);
  });
  if ($("#momentsGrid")) $("#momentsGrid").setAttribute("data-count", $("#momentsGrid").children.length);   // CSS подбирает число колонок
  // Появление секций при прокрутке
  var revealEls = $$(".reveal");
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: .15 });
    revealEls.forEach(function (e) { io.observe(e); });
  } else { revealEls.forEach(function (e) { e.classList.add("in"); }); }
  $("#toTop").addEventListener("click", function (e) { e.preventDefault(); window.scrollTo({ top: 0, behavior: reducedNow() ? "auto" : "smooth" }); });
  function reducedNow() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

  /* ---------- 2. Build glitch layers ---------- */
  var art = $("#art");
  var artStack = $(".art-stack", art);
  var chM = $(".ch-m"), chG = $(".ch-g"), base = $("#heroImg");
  var slicesBox = $("#slices");
  var isMobile = window.matchMedia("(max-width: 760px)");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  var SLICE_COUNT = 4;
  var slices = [];
  for (var i = 0; i < SLICE_COUNT; i++) {
    var s = doc.createElement("div");
    s.className = "slice";
    var im = doc.createElement("img");
    im.alt = ""; im.src = heroSrc;
    s.appendChild(im);
    slicesBox.appendChild(s);
    slices.push({ box: s, img: im });
  }

  var nick = $("#nick");
  var nickMain = nick.firstElementChild;
  var ghosts = {};
  ["m", "g", "s"].forEach(function (k) {
    var g = doc.createElement("span");
    g.className = "ghost ghost-" + k;
    g.setAttribute("aria-hidden", "true");
    g.textContent = nickMain.textContent;
    nick.appendChild(g);
    ghosts[k] = g;
  });

  var flash = $(".fx-flash");

  /* ---------- helpers ---------- */
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  var pick = function (arr) { return arr[(Math.random() * arr.length) | 0]; };
  var sign = function () { return Math.random() < .5 ? -1 : 1; };
  var mob = function () { return isMobile.matches ? .55 : 1; };
  var K = function () { return (parseFloat(getComputedStyle(root).getPropertyValue("--k")) || 1) * mob(); };

  function anim(el, frames, opts) {
    if (!el.animate) return null;
    return el.animate(frames, Object.assign({ fill: "none", easing: "steps(1)" }, opts));
  }

  /* ---------- 3. Effects ---------- */

  // RGB-раздвоение арта + кратковременное изменение яркости/цвета
  function artRgbSplit(power) {
    var d = rnd(180, 380), k = K() * (power || 1);
    var x = rnd(6, 16) * k * sign(), y = rnd(-2, 2) * k;
    var f = function (m, g, o) {
      return [
        { transform: "translate3d(0,0,0)", opacity: 0 },
        { transform: "translate3d(" + (m * x) + "px," + (m * y) + "px,0)", opacity: o, offset: .15 },
        { transform: "translate3d(" + (g * x * .6) + "px," + (-m * y) + "px,0)", opacity: o, offset: .5 },
        { transform: "translate3d(" + (m * x * .3) + "px,0,0)", opacity: o * .6, offset: .8 },
        { transform: "translate3d(0,0,0)", opacity: 0 }
      ];
    };
    anim(chM, f(-1, -1, .85), { duration: d, easing: "linear" });
    anim(chG, f(1, 1, .7), { duration: d, easing: "linear" });
    anim(base, [
      { filter: "none" },
      { filter: "brightness(1.25) saturate(1.5) hue-rotate(-12deg)", offset: .2 },
      { filter: "brightness(.85) contrast(1.15)", offset: .55 },
      { filter: "none" }
    ], { duration: d, easing: "linear" });
  }

  // Горизонтальные разрывы / digital tearing: несколько полос смещаются независимо
  function artTear(count, power) {
    var n = Math.min(count || 3, slices.length), k = K() * (power || 1);
    for (var i = 0; i < n; i++) {
      (function (sl, delay) {
        var top = rnd(4, 92), h = rnd(2.5, 11);
        sl.box.style.clipPath = "inset(" + top.toFixed(1) + "% 0 " + Math.max(0, 100 - top - h).toFixed(1) + "% 0)";
        var dx = rnd(14, 60) * k * sign();
        var d = rnd(70, 220);
        anim(sl.img, [
          { transform: "translate3d(" + dx + "px,0,0)" },
          { transform: "translate3d(" + (-dx * .5) + "px,0,0)", offset: .45 },
          { transform: "translate3d(" + (dx * .2) + "px,0,0)", offset: .8 },
          { transform: "translate3d(0,0,0)" }
        ], { duration: d, delay: delay });
        anim(sl.box, [{ opacity: 1 }, { opacity: 1 }], { duration: d, delay: delay });
        // цветной контур на полосе
        anim(sl.box, [
          { filter: "drop-shadow(3px 0 0 rgba(181,44,255,.9)) drop-shadow(-3px 0 0 rgba(198,255,0,.7))" },
          { filter: "none" }
        ], { duration: d, delay: delay });
      })(slices[i], i * rnd(15, 60));
    }
  }

  // Короткий сдвиг/цветовой контур всего арта (не всей композиции)
  function artJolt() {
    var k = K();
    anim(artStack, [
      { transform: "translate3d(0,0,0)" },
      { transform: "translate3d(" + (rnd(-8, 8) * k) + "px," + (rnd(-2, 2)) + "px,0)" },
      { transform: "translate3d(" + (rnd(-4, 4) * k) + "px,0,0)" },
      { transform: "translate3d(0,0,0)" }
    ], { duration: rnd(90, 170) });
  }

  // Глитч ника: RGB + смещение фрагментов + моментальный возврат
  function nickGlitch(power) {
    var k = K() * (power || 1), d = rnd(160, 340);
    var x = rnd(3, 8) * k * sign();
    anim(ghosts.m, [
      { opacity: 1, transform: "translate3d(" + (-x) + "px,0,0)" },
      { opacity: 1, transform: "translate3d(" + (x * .6) + "px," + (rnd(-1, 1) * k) + "px,0)" },
      { opacity: 1, transform: "translate3d(" + (-x * .4) + "px,0,0)" },
      { opacity: 0, transform: "none" }
    ], { duration: d });
    anim(ghosts.g, [
      { opacity: 1, transform: "translate3d(" + x + "px,0,0)" },
      { opacity: 1, transform: "translate3d(" + (-x * .5) + "px,0,0)" },
      { opacity: 0, transform: "none" }
    ], { duration: d * .8 });
    // горизонтальные фрагменты основного текста
    var steps = 3 + ((Math.random() * 2) | 0), frames = [];
    for (var i = 0; i < steps; i++) {
      var top = rnd(5, 85), h = rnd(8, 24);
      frames.push({
        opacity: 1,
        clipPath: "inset(" + top.toFixed(0) + "% 0 " + Math.max(0, 100 - top - h).toFixed(0) + "% 0)",
        transform: "translate3d(" + (rnd(10, 34) * k * sign()) + "px,0,0)"
      });
    }
    frames.push({ opacity: 0, clipPath: "inset(0 0 100% 0)", transform: "none" });
    anim(ghosts.s, frames, { duration: d });
  }

  // Редкая горизонтальная цифровая вспышка (тонкая линия)
  function lineFlash() {
    var h = rnd(1, 4), y = rnd(8, 92);
    flash.style.height = h + "px";
    flash.style.top = y + "vh";
    flash.style.background = Math.random() < .5 ? "var(--lime)" : "var(--purple)";
    anim(flash, [
      { opacity: .35, transform: "translateX(" + rnd(-20, 20) + "%) scaleX(" + rnd(.2, .8) + ")" },
      { opacity: .15, transform: "translateX(" + rnd(-20, 20) + "%) scaleX(" + rnd(.2, 1) + ")", offset: .5 },
      { opacity: 0, transform: "none" }
    ], { duration: rnd(80, 160) });
  }

  // Лёгкое дыхание свечения у героя во время сбоя
  function glowPulse() {
    anim($(".art-glow", art), [{ opacity: 1 }, { opacity: .45 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
  }

  /* ---------- 4. Sequences ---------- */
  var sequences = [
    { w: 28, run: function () { artRgbSplit(); } },
    { w: 22, run: function () { artTear(2); } },
    { w: 18, run: function () { nickGlitch(); } },
    { w: 10, run: function () { lineFlash(); } },
    { w: 8,  run: function () { artJolt(); artRgbSplit(.7); } },
    // комбо — редко
    { w: 9, run: function () {
        artRgbSplit(1.2); artTear(3); glowPulse();
        setTimeout(nickGlitch, rnd(60, 160));
        setTimeout(function () { artTear(2, .8); lineFlash(); }, rnd(200, 360));
      } },
    { w: 5, run: function () {
        nickGlitch(1.2); setTimeout(artRgbSplit, rnd(80, 200));
        setTimeout(function () { nickGlitch(.7); artJolt(); }, rnd(300, 450));
      } }
  ];
  var totalW = sequences.reduce(function (a, s) { return a + s.w; }, 0);
  var last = null;
  function pickSequence() {
    for (var tries = 0; tries < 4; tries++) {
      var r = Math.random() * totalW, s = sequences[0];
      for (var i = 0; i < sequences.length; i++) { r -= sequences[i].w; if (r <= 0) { s = sequences[i]; break; } }
      if (s !== last) { last = s; return s; }
    }
    return s;
  }

  // Псевдослучайные интервалы: в основном долгие паузы, иногда серия быстрых сбоев
  var timer = 0, burst = 0;
  function nextDelay() {
    if (burst > 0) { burst--; return rnd(300, 700); }
    if (Math.random() < .12) { burst = 1 + ((Math.random() * 2) | 0); return rnd(1200, 2200); }
    return rnd(1800, 6500) * (art.classList.contains("is-hot") ? .6 : 1);
  }
  function tick() {
    timer = 0;
    if (doc.hidden || reduced.matches) return;
    pickSequence().run();
    // независимые одиночные эффекты, чтобы слои не синхронизировались
    if (Math.random() < .25) setTimeout(lineFlash, rnd(100, 900));
    timer = setTimeout(tick, nextDelay());
  }
  function start(first) {
    if (timer || reduced.matches) return;
    timer = setTimeout(tick, first || nextDelay());
  }
  function stop() { clearTimeout(timer); timer = 0; }

  // Световой импульс по активным дням расписания: редко, волной в случайную сторону
  var pTimer = 0;
  function pulseTick() {
    pTimer = 0;
    if (doc.hidden || reduced.matches || !pulseEls.length) return;
    var list = Math.random() < .5 ? pulseEls.slice() : pulseEls.slice().reverse();
    list.forEach(function (el, i) {
      setTimeout(function () {
        el.classList.remove("go"); void el.offsetWidth; el.classList.add("go");
      }, i * rnd(90, 170));
    });
    pTimer = setTimeout(pulseTick, rnd(6000, 13000));
  }
  function pStart(first) { if (!pTimer && !reduced.matches && pulseEls.length) pTimer = setTimeout(pulseTick, first); }
  function pStop() { clearTimeout(pTimer); pTimer = 0; }

  doc.addEventListener("visibilitychange", function () {
    doc.body.classList.toggle("is-paused", doc.hidden);
    if (doc.hidden) { stop(); pStop(); cdStop(); } else { start(1200); pStart(2500); cdStart(); }
  });
  reduced.addEventListener && reduced.addEventListener("change", function () {
    if (reduced.matches) { stop(); pStop(); } else { start(1500); pStart(2500); }
  });

  /* ---------- 5. Interaction ---------- */
  art.addEventListener("pointerenter", function () {
    art.classList.add("is-hot");
    root.style.setProperty("--k", "1.35");
    if (!reduced.matches) { artRgbSplit(.8); }
  });
  art.addEventListener("pointerleave", function () {
    art.classList.remove("is-hot");
    root.style.setProperty("--k", "1");
  });

  // первый сбой — сразу после интро, показывает, что эффект живой
  if (!reduced.matches) {
    // глитч-интро (~1 с): короткая серия, пока гаснет загрузочный экран
    setTimeout(function () { nickGlitch(1.1); artRgbSplit(.9); }, 350);
    setTimeout(function () { artTear(3); artJolt(); }, 650);
    setTimeout(function () { nickGlitch(.8); artRgbSplit(1.1); }, 950);
    start(rnd(3600, 5200));
    pStart(rnd(2200, 3200));
  }
  var boot = $(".boot");
  if (boot) setTimeout(function () { boot.remove(); }, 1100);

  /* ---------- 6. «Мои сети» / «Поддержать»: глитч страницы -> модальное меню ---------- */
  (function () {
    var btnNets = $("#socialsBtn"), btnSup = $("#supportBtn"), modal = $("#socialsModal");
    var closeBtn = $("#socialsClose"), list = $("#socialsList"), layer = $("#pgLayer");
    var titleEl = $("#socialsTitle"), noteEl = $(".modal-note", modal);
    if (!btnNets || !modal) return;
    var L = cfg.links || {};
    var modes = {
      nets: {
        title: "МОИ СЕТИ",
        note: "Нажмите Esc или кликните вне окна, чтобы закрыть",
        items: [["Twitch", L.twitch], ["YouTube", L.youtube], ["Telegram", L.telegram], ["Discord", L.discord]]
      },
      support: {
        title: "ПОДДЕРЖКА",
        note: "Это добровольно: канал живёт на вкладе зрителей и ничего не блокирует",
        items: [[cfg.donateLabel || "DonationAlerts", L.donate], [cfg.boostyLabel || "Boosty", L.boosty]]
      }
    };
    function fill(mode) {
      var m = modes[mode];
      titleEl.textContent = m.title; noteEl.textContent = m.note; list.textContent = "";
      m.items.forEach(function (n) {
        if (!n[1]) return;
        var li = doc.createElement("li"), a = doc.createElement("a");
        a.className = "modal-link"; a.href = n[1]; a.target = "_blank"; a.rel = "noopener noreferrer";
        var nm = doc.createElement("span"); nm.className = "ml-name"; nm.textContent = n[0]; nm.setAttribute("data-text", n[0]);
        var host = doc.createElement("i");
        try { host.textContent = n[2] || new URL(n[1]).host; } catch (e) { host.textContent = n[2] || ""; }
        a.appendChild(nm); a.appendChild(host); li.appendChild(a); list.appendChild(li);
      });
    }

    var busy = false, isOpen = false, lastFocus = null, opener = null;

    // сильный, но короткий сбой всей страницы: смещение + RGB + рябь полосами (без белых вспышек)
    function pageGlitch(ms) {
      layer.textContent = "";
      var colors = ["rgba(181,44,255,.45)", "rgba(198,255,0,.35)", "rgba(244,244,244,.12)", "rgba(8,9,11,.9)"];
      for (var i = 0; i < 9; i++) {
        var b = doc.createElement("div"); b.className = "pg-bar";
        b.style.top = rnd(0, 96) + "%"; b.style.height = rnd(1, 9) + "%"; b.style.background = pick(colors);
        layer.appendChild(b);
        var dx = rnd(40, 260) * sign(), d = rnd(40, 80), delay = rnd(0, ms - d - 40);
        anim(b, [
          { opacity: .9, transform: "translateX(" + dx + "px)" },
          { opacity: .7, transform: "translateX(" + (-dx * .6) + "px)", offset: .5 },
          { opacity: 0, transform: "none" }
        ], { duration: d, delay: delay, easing: "steps(3)" });
      }
      doc.body.classList.add("glitching");
      setTimeout(function () { doc.body.classList.remove("glitching"); layer.textContent = ""; }, ms);
    }

    function openMenu(mode, btn) {
      if (busy || isOpen) return;
      busy = true; lastFocus = doc.activeElement; opener = btn;
      fill(mode);
      var finish = function () {
        modal.hidden = false; modal.classList.remove("closing"); modal.classList.add("open");
        isOpen = true; busy = false; btn.setAttribute("aria-expanded", "true");
        root.style.overflow = "hidden";
        closeBtn.focus();
      };
      if (reduced.matches) { finish(); return; }
      pageGlitch(rnd(230, 260));
      setTimeout(finish, 190);
    }
    function closeMenu() {
      if (!isOpen || busy) return;
      busy = true;
      var done = function () {
        modal.hidden = true; modal.classList.remove("open", "closing");
        isOpen = false; busy = false; opener.setAttribute("aria-expanded", "false");
        root.style.overflow = "";
        if (lastFocus && lastFocus.focus) lastFocus.focus();
      };
      if (reduced.matches) { done(); return; }
      modal.classList.add("closing");
      setTimeout(done, 300);
    }

    btnNets.addEventListener("click", function () { openMenu("nets", btnNets); });
    if (btnSup) btnSup.addEventListener("click", function () { openMenu("support", btnSup); });
    closeBtn.addEventListener("click", closeMenu);
    modal.addEventListener("click", function (e) { if (e.target === modal) closeMenu(); });
    doc.addEventListener("keydown", function (e) {
      if (!isOpen) return;
      if (e.key === "Escape") { closeMenu(); return; }
      if (e.key === "Tab") {   // фокус остаётся внутри окна
        var f = $$("a, button", modal);
        var first = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && doc.activeElement === lastEl) { e.preventDefault(); first.focus(); }
      }
    });
  })();
})();