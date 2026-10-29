// Интеграционная проверка: настоящие функции Pages + локальная D1 (запущенный `npm run dev`).
// Запуск: npm run test:local   (перед этим в другом окне: npm run dev)
import { execSync } from "node:child_process";
import { tzNow, isoOf } from "../functions/_lib/schedule.js";

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const PASS = process.env.ADMIN_PASSWORD || "test-pass-123";
let cookie = "", failures = 0, checks = 0;

const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`);
};

async function api(path, { method = "GET", body, cookieOverride, headers = {}, origin = BASE, raw } = {}) {
  const h = { ...headers };
  const ck = cookieOverride !== undefined ? cookieOverride : cookie;
  if (ck) h.Cookie = ck;
  if (method === "POST") { if (origin) h.Origin = origin; h["Content-Type"] = raw ? "text/plain" : "application/json"; }
  const res = await fetch(BASE + path, { method, headers: h, body: method === "POST" ? JSON.stringify(body || {}) : undefined });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { /* не JSON */ }
  return { status: res.status, data, headers: res.headers, text };
}
const post = (p, body, o) => api(p, { method: "POST", body, ...o });
const sh = (cmd) => execSync(cmd, { stdio: "pipe" }).toString();   // запускать из корня проекта
const D1 = (sql) => sh(`npx wrangler d1 execute DB --local --config wrangler.local.toml --command "${sql}"`);

// чистое состояние базы
D1("DELETE FROM schedule; DELETE FROM login_attempts;");

const sched = {
  timezone: "Europe/Moscow", timezoneLabel: "МСК",
  days: [
    ["ПН", "Понедельник", true, "19:00", "23:00"], ["ВТ", "Вторник", false], ["СР", "Среда", true, "19:00", "23:00"],
    ["ЧТ", "Четверг", false], ["ПТ", "Пятница", true, "20:00", "00:00"], ["СБ", "Суббота", true, "18:00"], ["ВС", "Воскресенье", false],
  ].map(([short, full, active, start, end]) => ({ short, full, active, start: start || "", end: end || "" })),
  overrides: [],
};

// ---------- до входа ----------
let r = await api("/api/schedule");
if (r.status === 200) {   // база сброшена напрямую, а в кэше ещё прошлый ответ (15 с) — ждём его истечения
  console.log("      (ожидание истечения кэша от прошлого запуска...)");
  await new Promise((res) => setTimeout(res, 16500));
  r = await api("/api/schedule");
}
check("публично: расписание ещё не создано -> 404", r.status === 404 && r.data.error === "not_initialized", r.text);

r = await api("/api/admin/state", { cookieOverride: "" });
check("без входа: состояние панели -> 401", r.status === 401, r.status);
for (const op of ["move", "cancel", "restore", "weekly", "live", "init"]) {
  r = await post(`/api/admin/${op}`, { date: "2030-01-01" }, { cookieOverride: "" });
  check(`без входа: изменение «${op}» отклонено (401)`, r.status === 401, r.status);
}

r = await post("/api/admin/login", { password: "неверный" });
check("неверный пароль -> 401 и понятное сообщение", r.status === 401 && /Неверный пароль/.test(r.data.message), r.text);
r = await post("/api/admin/login", { password: PASS }, { origin: null });
check("вход без заголовка Origin -> 403", r.status === 403, r.status);
r = await post("/api/admin/login", { password: PASS }, { origin: "https://evil.example" });
check("вход с чужого сайта (Origin) -> 403", r.status === 403, r.status);
r = await post("/api/admin/login", { password: PASS }, { raw: true });
check("вход не в JSON -> 415", r.status === 415, r.status);

// ---------- вход ----------
r = await post("/api/admin/login", { password: PASS });
const setCookie = r.headers.get("set-cookie") || "";
check("верный пароль -> 200 и cookie HttpOnly + SameSite=Strict", r.status === 200 && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie);
check("пароль не попал в ответ и cookie", !r.text.includes(PASS) && !setCookie.includes(PASS));
cookie = setCookie.split(";")[0];

r = await api("/api/admin/state", { cookieOverride: cookie.slice(0, -3) + "AAA" });
check("поддельная cookie -> 401", r.status === 401, r.status);

r = await api("/api/admin/state");
check("после входа: база пуста, панель предлагает создать расписание", r.status === 200 && r.data.initialized === false, r.text);

// ---------- создание расписания ----------
r = await post("/api/admin/init", { schedule: { ...sched, timezone: "Mars/Base" } });
check("создание с неверным часовым поясом -> 400", r.status === 400 && r.data.error === "bad_timezone", r.text);
r = await post("/api/admin/init", { schedule: { ...sched, days: sched.days.slice(0, 3) } });
check("создание с неполной неделей -> 400", r.status === 400, r.text);
r = await post("/api/admin/init", { schedule: sched });
check("создание расписания -> 200", r.status === 200, r.text);
r = await post("/api/admin/init", { schedule: sched });
check("повторное создание запрещено -> 409", r.status === 409, r.text);

// ---------- публичная страница ----------
r = await api("/api/schedule", { cookieOverride: "" });
const etag1 = r.headers.get("etag");
check("публично: расписание доступно без входа, есть ETag", r.status === 200 && !!etag1 && r.data.days.length === 7, r.text);
check("публично: браузеру отдаётся no-cache (сверка по ETag)", /no-cache/.test(r.headers.get("cache-control") || ""));
check("публично: нет служебных данных", !r.text.includes("moveId") && !("password" in r.data));
r = await api("/api/schedule", { cookieOverride: "", headers: { "If-None-Match": etag1 } });
check("публично: повторный запрос по ETag -> 304 без тела", r.status === 304 && r.text === "", r.status);

// ---------- ближайший стрим и перенос ----------
r = await api("/api/admin/state");
const st0 = r.data;
check("панель: есть ближайший стрим и список предстоящих", st0.initialized && st0.upcoming.length >= 3, r.text);
const next = st0.upcoming[0], second = st0.upcoming[1], third = st0.upcoming[2];
const tn = tzNow("Europe/Moscow");
const taken = new Set(st0.upcoming.map((s) => s.date));
let freeDate = null;                                              // свободная дата через 9+ дней
for (let i = 9; i < 40 && !freeDate; i++) { const d = isoOf(tn.dayNum + i); const dow = (tn.dayNum + i + 3) % 7; if (!sched.days[dow].active) freeDate = d; }

r = await post("/api/admin/move", { fromDate: next.date, toDate: freeDate, toTime: "22:30" });
check("перенос ближайшего стрима на другую дату -> 200", r.status === 200, r.text);
r = await api("/api/schedule", { cookieOverride: "" });
const pubAfter = r.data;
check("публично: ETag сменился, перенос виден сразу", r.headers.get("etag") !== etag1 && pubAfter.overrides.some((o) => o.date === freeDate && o.active && o.start === "22:30"), r.text);
check("публично: исходная дата отменена (старое время не показывается)", pubAfter.overrides.some((o) => o.date === next.date && o.active === false));
r = await api("/api/admin/state");
const st1 = r.data;
check("панель: другие стримы не затронуты", st1.upcoming.some((s) => s.date === second.date && s.start === second.start) && st1.upcoming.some((s) => s.date === third.date && s.start === third.start));
check("панель: регулярное расписание не изменилось", JSON.stringify(st1.schedule.days) === JSON.stringify(st0.schedule.days));

// на другое время в тот же день
r = await post("/api/admin/move", { fromDate: second.date, toDate: second.date, toTime: second.start === "23:00" ? "22:00" : "23:00" });
check("перенос на другое время в тот же день -> 200", r.status === 200, r.text);

// ошибки
r = await post("/api/admin/move", { fromDate: third.date, toDate: isoOf(tn.dayNum - 1), toTime: "20:00" });
check("дата в прошлом -> 400 (past)", r.status === 400 && r.data.error === "past" && /будущем/.test(r.data.message), r.text);
r = await post("/api/admin/move", { fromDate: third.date, toDate: "2026-02-31", toTime: "20:00" });
check("несуществующая дата -> 400", r.status === 400 && r.data.error === "bad_date", r.text);
r = await post("/api/admin/move", { fromDate: third.date, toDate: freeDate, toTime: "99:99" });
check("некорректное время -> 400", r.status === 400 && r.data.error === "bad_time", r.text);
r = await post("/api/admin/move", { fromDate: third.date, toDate: freeDate });
check("нет времени -> 400", r.status === 400, r.text);
r = await post("/api/admin/move", { fromDate: freeDate.replace(/\d\d$/, "01"), toDate: freeDate, toTime: "20:00" });
check("перенос стрима, которого нет -> 409", r.status === 409, r.text);
r = await post("/api/admin/move", "not json", { raw: true });
check("мусор вместо JSON -> ошибка, не успех", r.status >= 400, r.status);

// возврат
r = await post("/api/admin/restore", { date: freeDate });
check("возврат исходного после переноса -> 200", r.status === 200, r.text);
r = await post("/api/admin/restore", { date: second.date });
check("возврат времени в тот же день -> 200", r.status === 200, r.text);
r = await api("/api/schedule", { cookieOverride: "" });
check("публично: после возврата нет разовых изменений", r.data.overrides.length === 0, r.text);

// отмена и возврат
r = await post("/api/admin/cancel", { date: next.date });
check("отмена одного стрима -> 200", r.status === 200, r.text);
r = await api("/api/admin/state");
check("панель: отменённый стрим исчез из предстоящих, остальные на месте", !r.data.upcoming.some((s) => s.date === next.date) && r.data.upcoming.some((s) => s.date === second.date));
r = await post("/api/admin/restore", { date: next.date });
check("возврат отменённого -> 200", r.status === 200, r.text);

// параллельные правки разных стримов не затирают друг друга
const [a, b] = await Promise.all([post("/api/admin/cancel", { date: next.date }), post("/api/admin/cancel", { date: second.date })]);
r = await api("/api/schedule", { cookieOverride: "" });
check("две одновременные правки: обе сохранены", a.status === 200 && b.status === 200 && r.data.overrides.length === 2, `${a.status}/${b.status} ${r.text}`);
await post("/api/admin/restore", { date: next.date }); await post("/api/admin/restore", { date: second.date });

// регулярное расписание
r = await post("/api/admin/weekly", { index: 1, active: true, start: "21:00", end: "" });
check("регулярное расписание: включить вторник -> 200", r.status === 200, r.text);
r = await post("/api/admin/weekly", { index: 1, active: true, start: "" });
check("регулярное расписание: день без времени -> 400", r.status === 400, r.text);
r = await api("/api/schedule", { cookieOverride: "" });
check("публично: вторник теперь со стримом, остальные дни как были", r.data.days[1].active && r.data.days[1].start === "21:00" && r.data.days[0].start === "19:00" && r.data.days[4].start === "20:00", r.text);
await post("/api/admin/weekly", { index: 1, active: false, start: "", end: "" });

// статус эфира
r = await post("/api/admin/live", { on: true });
check("включить «в эфире» -> 200", r.status === 200, r.text);
r = await api("/api/schedule", { cookieOverride: "" });
check("публично: статус «в эфире» виден, расписание не изменилось", r.data.live.on === true && !!r.data.live.since && r.data.overrides.length === 0, r.text);
await post("/api/admin/live", { on: false });
r = await api("/api/schedule", { cookieOverride: "" });
check("публично: статус выключается только вручную", r.data.live.on === false);

// ---------- недоступность хранилища ----------
D1("ALTER TABLE schedule RENAME TO schedule_broken;");
r = await post("/api/admin/move", { fromDate: next.date, toDate: freeDate, toTime: "22:00" });
check("хранилище недоступно: перенос -> ошибка 5xx, а не успех", r.status >= 500 && r.data && /не сохранен/i.test(r.data.message), r.text);
r = await api("/api/schedule", { cookieOverride: "" });
check("хранилище недоступно: пока не истёк кэш (15 с), посетители получают последнюю версию", r.status === 200, r.status);
await new Promise((res) => setTimeout(res, 16500));
r = await api("/api/schedule", { cookieOverride: "" });
check("хранилище недоступно, кэш истёк: публичный API честно отвечает ошибкой (сайт берёт запасные данные из config.js)", r.status >= 500, r.status);
D1("ALTER TABLE schedule_broken RENAME TO schedule;");
r = await api("/api/schedule", { cookieOverride: "" });
check("хранилище вернулось: всё работает", r.status === 200, r.status);

// ---------- выход ----------
r = await post("/api/admin/logout", {});
check("выход очищает cookie (Max-Age=0)", r.status === 200 && /Max-Age=0/.test(r.headers.get("set-cookie") || ""));

// ---------- ограничение попыток входа (в конце; отдельный IP) ----------
const ip = { headers: { "CF-Connecting-IP": "203.0.113.77" } };
let last;
for (let i = 0; i < 6; i++) last = await post("/api/admin/login", { password: "x" + i }, ip);
check("после 5 неверных попыток вход блокируется (429)", last.status === 429 && !!last.headers.get("retry-after"), last.status);
r = await post("/api/admin/login", { password: PASS }, ip);
check("во время блокировки даже верный пароль не принимается", r.status === 429, r.status);
r = await post("/api/admin/login", { password: PASS });
check("другой IP не заблокирован", r.status === 200, r.status);

D1("DELETE FROM schedule; DELETE FROM login_attempts;");
console.log(`\nИтого: ${checks - failures}/${checks} успешно${failures ? `, ПРОВАЛЕНО: ${failures}` : ""}`);
process.exit(failures ? 1 : 0);
