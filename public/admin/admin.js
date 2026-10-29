/* Панель управления расписанием. Все изменения идут через /api/admin/* (проверка пароля на сервере). */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var cfg = window.GLITCH_CONFIG || {};
  var state = null;            // последнее состояние с сервера
  var moveFrom = null;         // стрим, который переносим

  if (cfg.nickname) { $("#brand").textContent = cfg.nickname; document.title = "Панель управления — " + cfg.nickname; }

  /* ---------- вспомогательное ---------- */
  function h(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "class") e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return e;
  }
  function btn(label, cls, onClick) {
    var b = h("button", { type: "button", class: "btn " + cls });
    b.appendChild(h("span", { class: "btn-label", "data-text": label, text: label }));
    b.addEventListener("click", function () { onClick(b); });
    return b;
  }
  function show(el, on) { el.hidden = !on; }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  var DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function tzParts(date, tz) {
    var p = {};
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
      .formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function dowOf(iso) { return (Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000) + 3) % 7; }
  function fmtDate(iso) { return iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4); }
  function dayName(iso, full) { var d = state.schedule.days[dowOf(iso)]; return d ? (full ? d.full : d.short) : ""; }
  function tzLabel() { return state.schedule.timezoneLabel || state.schedule.timezone; }
  function todayIso() { var p = tzParts(new Date(state ? state.serverNow : Date.now()), state.schedule.timezone); return p.year + "-" + p.month + "-" + p.day; }

  var toastTimer = 0;
  function toast(kind, html) {
    var t = $("#toast");
    clear(t); t.className = "ad-toast" + (kind === "err" ? " err" : "");
    html.forEach(function (x) { t.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
    show(t, true);
    clearTimeout(toastTimer);
    if (kind !== "err") toastTimer = setTimeout(function () { show(t, false); }, 9000);
    t.scrollIntoView({ block: "nearest" });
  }
  var ok = function (title, rest) { toast("ok", [h("b", { text: "✔ " + title + " " }), rest || ""]); };
  var bad = function (msg) { toast("err", [h("b", { text: "Ошибка: " }), msg]); };
  var PUBLISH_NOTE = "Посетители увидят изменения в течение 1–2 минут.";

  // Запрос к API: возвращает { status, data }. Сетевая ошибка превращается в понятное сообщение.
  function api(path, body) {
    var opt = body === undefined ? { method: "GET", credentials: "same-origin", cache: "no-store" }
      : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return fetch(path, opt).then(function (res) {
      return res.text().then(function (text) {
        var data = null; try { data = JSON.parse(text); } catch (e) { /* не JSON */ }
        return { status: res.status, data: data };
      });
    }, function () { return { status: 0, data: null }; });
  }
  function explain(r) {
    if (r.status === 0) return "Нет связи с сервером. Изменения не сохранены.";
    if (r.data && r.data.message) return r.data.message;
    return "Сервер вернул неожиданный ответ (" + r.status + "). Изменения не сохранены.";
  }

  // Выполнить действие: блокирует кнопку, показывает итог, обновляет состояние
  function act(button, path, body, success) {
    show($("#toast"), false);
    if (button) button.disabled = true;
    return api(path, body).then(function (r) {
      if (button) button.disabled = false;
      if (r.status === 401) { state = null; render(); return false; }
      if (r.status >= 200 && r.status < 300 && r.data && r.data.ok) { success(); return refresh().then(function () { return true; }); }
      bad(explain(r));
      return refresh().then(function () { return false; });
    });
  }

  /* ---------- экраны ---------- */
  function showOnly(which) {
    show($("#loginView"), which === "login"); show($("#offlineView"), which === "offline"); show($("#appView"), which === "app");
    show($("#logoutBtn"), which === "app");
  }

  function refresh() {
    return api("/api/admin/state").then(function (r) {
      if (r.status === 401) { state = null; showOnly("login"); return; }
      if (r.status === 200 && r.data) { state = r.data; render(); return; }
      var msg = r.status === 0 ? "Нет связи с сервером."
        : r.status === 404 || !r.data ? "Серверная часть недоступна: страница открыта без Cloudflare Functions (например, как обычный файл)."
        : explain(r);
      $("#offlineText").textContent = msg; showOnly("offline");
    });
  }

  function render() {
    if (!state) { showOnly("login"); return; }
    showOnly("app");
    var ready = !!state.initialized;
    show($("#initView"), !ready); show($("#panels"), ready);
    if (!ready) return;
    renderNext(); renderUpcoming(); renderChanges(); renderWeek(); renderLive();
  }

  function streamLabel(s) {
    return h("span", { class: "ad-row-t" }, h("b", { text: dayName(s.date, true) + ", " + fmtDate(s.date) }), "  ·  " + s.start + " " + tzLabel(),
      s.changed ? h("span", { class: "ad-badge", text: "ИЗМЕНЁН" }) : null);
  }

  function renderNext() {
    var box = $("#nextBox"); clear(box);
    var n = state.upcoming[0];
    if (!n) {
      box.appendChild(h("p", { class: "ad-text", text: "Ближайших стримов нет. Включите дни в регулярном расписании ниже." }));
    } else {
      var when = h("div", { class: "ad-when" }, n.start, h("small", {}, dayName(n.date, true) + ", " + fmtDate(n.date) + " · " + tzLabel(),
        n.changed ? h("span", { class: "ad-badge", text: "ИЗМЕНЁН" }) : null));
      var acts = h("div", { class: "ad-row-a" },
        btn("Перенести стрим", "btn-primary", function () { openMove(n); }),
        btn("Отменить стрим", "btn-danger", function (b) { cancel(n, b); }));
      box.appendChild(h("div", { class: "ad-next" }, when, acts));
    }
    if (state.startedToday) {
      box.appendChild(h("p", { class: "ad-note", text: "По плану сегодняшний стрим начался в " + state.startedToday.start + ". Начавшийся стрим перенести нельзя; «В эфире» переключается вручную в блоке статуса ниже." }));
    }
  }

  function renderUpcoming() {
    var list = $("#upList"); clear(list);
    var rest = state.upcoming.slice(1);
    show($("#upCard"), rest.length > 0);
    rest.forEach(function (s) {
      list.appendChild(h("li", { class: "ad-row" }, streamLabel(s), h("span", { class: "ad-row-a" },
        btn("Перенести", "btn-ghost sm", function () { openMove(s); }),
        btn("Отменить", "btn-danger sm", function (b) { cancel(s, b); }))));
    });
  }

  // Изменения: перенос = пара записей с общим moveId
  function renderChanges() {
    var list = $("#chgList"); clear(list);
    var groups = [], byId = {};
    state.schedule.overrides.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (o) {
      if (o.moveId) { if (!byId[o.moveId]) { byId[o.moveId] = []; groups.push(byId[o.moveId]); } byId[o.moveId].push(o); }
      else groups.push([o]);
    });
    var today = todayIso();
    groups.forEach(function (g) {
      var cancel = g.filter(function (o) { return !o.active; })[0], add = g.filter(function (o) { return o.active; })[0];
      var text, key = g[0].date;
      var wd = function (iso) { return dayName(iso, false) + " " + fmtDate(iso).slice(0, 5); };
      if (cancel && add) text = ["Перенос: ", wd(cancel.date), " → ", wd(add.date) + " в " + add.start];
      else if (cancel) text = ["Отмена: ", wd(cancel.date)];
      else {
        var wk = state.schedule.days[dowOf(add.date)];
        text = wk && wk.active ? ["Другое время: ", wd(add.date) + " → " + add.start] : ["Добавлен стрим: ", wd(add.date) + " в " + add.start];
      }
      var past = g[g.length - 1].date < today;
      list.appendChild(h("li", { class: "ad-row" },
        h("span", { class: "ad-row-t" }, h("b", { text: text[0] }), text.slice(1).join("") + (past ? "  (прошедшее)" : "")),
        h("span", { class: "ad-row-a" }, btn("Вернуть исходное", "btn-ghost sm", function (b) { restore(key, b); }))));
    });
    show($("#chgEmpty"), groups.length === 0);
  }

  function renderWeek() {
    var box = $("#weekList"); clear(box);
    $("#tzNote").textContent = "Время указано по часовому поясу: " + state.schedule.timezone + " (" + tzLabel() + "). Изменения здесь действуют на все будущие недели; разовые переносы остаются как есть.";
    state.schedule.days.forEach(function (d, i) {
      var active = h("input", { type: "checkbox", id: "wd-a" + i }); active.checked = !!d.active;
      var start = h("input", { class: "ad-input", type: "time", "aria-label": d.full + ": начало" }); start.value = d.start || "";
      var end = h("input", { class: "ad-input", type: "time", "aria-label": d.full + ": окончание (необязательно)" }); end.value = d.end || "";
      var sync = function () { start.disabled = end.disabled = !active.checked; row.classList.toggle("on", active.checked); };
      var row = h("div", { class: "ad-day" },
        h("span", { class: "ad-day-n", text: d.full }),
        h("label", { class: "ad-check" }, active, "Стрим"),
        start, end,
        btn("Сохранить", "btn-ghost sm", function (b) {
          if (active.checked && !start.value) { bad("Для дня со стримом укажите время начала (" + d.full + ")."); start.focus(); return; }
          act(b, "/api/admin/weekly", { index: i, active: active.checked, start: start.value, end: end.value },
            function () { ok("Сохранено:", d.full + (active.checked ? " — стрим в " + start.value : " — выходной") + ". " + PUBLISH_NOTE); });
        }));
      active.addEventListener("change", sync); sync();
      box.appendChild(row);
    });
  }

  function renderLive() {
    var box = $("#liveBox"); clear(box);
    var live = state.schedule.live || { on: false };
    var since = "";
    if (live.on && live.since) {
      var hours = (new Date(state.serverNow) - new Date(live.since)) / 3600000;
      since = "Включён " + new Intl.DateTimeFormat("ru-RU", { timeZone: state.schedule.timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(live.since)) + " (" + tzLabel() + ")";
      if (hours >= 8) since += ". Уже больше " + Math.floor(hours) + " ч — не забыли выключить?";
    }
    box.appendChild(h("div", { class: "ad-sw" },
      h("div", {}, h("div", { class: "ad-state" + (live.on ? " live" : "") }, h("span", { class: "dot" }), live.on ? "СЕЙЧАС В ЭФИРЕ" : "НЕ В ЭФИРЕ"),
        since ? h("p", { class: "ad-text ad-muted", text: since }) : null),
      btn(live.on ? "Выключить «В эфире»" : "Включить «В эфире»", live.on ? "btn-ghost" : "btn-primary", function (b) {
        act(b, "/api/admin/live", { on: !live.on }, function () { ok(live.on ? "Статус выключен." : "Статус «В эфире» включён.", "На сайте он обновится в течение минуты."); });
      })));
    box.appendChild(h("p", { class: "ad-text ad-muted", text: "Статус не зависит от расписания и сам не выключается: его включаете и выключаете вы." }));
  }

  /* ---------- действия ---------- */
  function cancel(s, b) {
    if (!window.confirm("Отменить стрим " + dayName(s.date, true) + ", " + fmtDate(s.date) + " в " + s.start + "?\nРегулярное расписание не изменится, отмену можно вернуть.")) return;
    act(b, "/api/admin/cancel", { date: s.date }, function () { ok("Стрим отменён:", dayName(s.date, true) + ", " + fmtDate(s.date) + ". " + PUBLISH_NOTE); });
  }
  function restore(date, b) {
    act(b, "/api/admin/restore", { date: date }, function () { ok("Исходное расписание возвращено.", PUBLISH_NOTE); });
  }

  /* ---------- форма переноса ---------- */
  var modal = $("#moveModal");
  function openMove(s) {
    moveFrom = s;
    show($("#toast"), false);
    $("#moveInfo").textContent = "Переносим: " + dayName(s.date, true) + ", " + fmtDate(s.date) + " в " + s.start + " (" + tzLabel() + "). Остальные стримы не изменятся.";
    var d = $("#moveDate"); d.min = todayIso(); d.value = s.date;
    $("#moveTime").value = s.start;
    show($("#moveErr"), false);
    show(modal, true); modal.classList.add("open");
    d.focus();
  }
  function closeMove() { show(modal, false); modal.classList.remove("open"); moveFrom = null; }
  $("#moveClose").addEventListener("click", closeMove);
  $("#moveCancel").addEventListener("click", closeMove);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeMove(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeMove(); });

  $("#moveForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("#moveErr"), date = $("#moveDate").value, time = $("#moveTime").value;
    var fail = function (m) { err.textContent = m; show(err, true); };
    if (!date) return fail("Укажите новую дату.");
    if (!time) return fail("Укажите новое время.");
    show(err, false);
    var save = $("#moveSave"), from = moveFrom;
    save.disabled = true;
    api("/api/admin/move", { fromDate: from.date, toDate: date, toTime: time }).then(function (r) {
      save.disabled = false;
      if (r.status === 401) { closeMove(); state = null; render(); return; }
      if (r.status === 200 && r.data && r.data.ok) {
        closeMove();
        ok("Стрим перенесён:", dayName(from.date, false) + " " + fmtDate(from.date).slice(0, 5) + " → " + dayName(date, false) + " " + fmtDate(date).slice(0, 5) + " в " + time + " (" + tzLabel() + "). " + PUBLISH_NOTE);
        refresh();
        return;
      }
      fail(explain(r));            // форма остаётся открытой, успех не показывается
    });
  });

  /* ---------- вход, выход, создание расписания ---------- */
  $("#loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = e.target.querySelector("button"); b.disabled = true;
    api("/api/admin/login", { password: $("#password").value }).then(function (r) {
      b.disabled = false;
      if (r.status === 200 && r.data && r.data.ok) { $("#password").value = ""; show($("#toast"), false); refresh(); return; }
      bad(explain(r)); $("#password").select();
    });
  });
  $("#logoutBtn").addEventListener("click", function () {
    api("/api/admin/logout", {}).then(function () { state = null; showOnly("login"); show($("#toast"), false); });
  });
  $("#retryBtn").addEventListener("click", refresh);
  $("#initBtn").addEventListener("click", function (e) {
    var s = cfg.schedule;
    if (!s) { bad("В config.js не найден блок schedule."); return; }
    act(e.currentTarget, "/api/admin/init", { schedule: s }, function () { ok("Расписание создано.", "Теперь им можно управлять здесь."); });
  });

  refresh();
})();
