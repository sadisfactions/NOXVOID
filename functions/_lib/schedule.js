// Чистая логика расписания (без обращения к базе и сети) — легко тестируется.
// Документ расписания:
// { timezone, timezoneLabel,
//   days: [7 × { short, full, active, start, end }],      // регулярный план ПН..ВС
//   overrides: [{ date, active, start?, end?, moveId? }],  // разовые изменения по датам
//   live: { on, since, mode? } }                           // ручной статус «в эфире»; mode: "manual" (по умолчанию) | "twitch"

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const err = (status, code, message) => new ApiError(status, code, message);

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HORIZON_DAYS = 366;     // как далеко вперёд можно переносить
export const KEEP_PAST_DAYS = 30;    // сколько дней хранить прошедшие изменения
export const MAX_OVERRIDES = 200;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* ---------- даты и время в часовом поясе стримера ---------- */

export function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
}

// «Сейчас» в часовом поясе расписания: день недели (0 = ПН), номер дня, минуты и секунды
export function tzNow(timezone, now = new Date()) {
  const p = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).forEach((x) => { p[x.type] = x.value; });
  return {
    dow: DOW.indexOf(p.weekday),
    dayNum: Date.UTC(+p.year, +p.month - 1, +p.day) / 86400000,
    mins: (+p.hour % 24) * 60 + (+p.minute),
    sec: +p.second,
  };
}

export const isoOf = (dayNum) => new Date(dayNum * 86400000).toISOString().slice(0, 10);

// "2026-10-30" -> номер дня; null, если формат или календарная дата неверны (например 2026-02-31)
export function dayNumOf(iso) {
  if (typeof iso !== "string" || !DATE_RE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return isoOf(ms / 86400000) === iso ? ms / 86400000 : null;
}
export const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);

// Будущее ли момент (день dayNum, время HH:MM) относительно «сейчас» t
const isFuture = (t, dayNum, time) => ((dayNum - t.dayNum) * 1440 + toMin(time) - t.mins) * 60 - t.sec > 0;

/* ---------- план на день, ближайшие стримы ---------- */

export function planFor(doc, dayNum) {
  const dow = (dayNum + 3) % 7;                 // 1970-01-01 был четвергом
  const w = doc.days[dow] || {};
  const o = doc.overrides.find((x) => x.date === isoOf(dayNum));
  if (o) return { active: !!(o.active && o.start), start: o.start || "", end: o.end || "", changed: true, moveId: o.moveId || null, dow };
  return { active: !!(w.active && w.start), start: w.start || "", end: w.end || "", changed: false, moveId: null, dow };
}

// Предстоящие стримы (только будущие по времени начала)
export function upcoming(doc, now = new Date(), limit = 10, horizon = 60) {
  const t = tzNow(doc.timezone, now), out = [];
  for (let off = 0; off <= horizon && out.length < limit; off++) {
    const dn = t.dayNum + off, p = planFor(doc, dn);
    if (!p.active) continue;
    const rem = ((off * 1440 + toMin(p.start) - t.mins) * 60) - t.sec;
    if (rem <= 0) continue;
    out.push({ date: isoOf(dn), dow: p.dow, start: p.start, end: p.end, changed: p.changed, moveId: p.moveId, rem });
  }
  return out;
}
export const nextStream = (doc, now) => upcoming(doc, now, 1)[0] || null;

// Сегодняшний стрим по плану, время начала которого уже наступило (только справочная информация, не статус эфира)
export function startedToday(doc, now = new Date()) {
  const t = tzNow(doc.timezone, now), p = planFor(doc, t.dayNum);
  return p.active && toMin(p.start) <= t.mins ? { date: isoOf(t.dayNum), start: p.start, end: p.end } : null;
}

/* ---------- проверка и очистка входных данных ---------- */

const str = (v, max, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw err(400, "bad_data", `Поле «${name}» заполнено неверно.`);
  return v.trim();
};
const optTime = (v, name) => {
  if (v == null || v === "") return "";
  if (typeof v !== "string" || !TIME_RE.test(v)) throw err(400, "bad_time", `Время («${name}») нужно указать в формате ЧЧ:ММ.`);
  return v;
};

function cleanDay(d, i) {
  if (!d || typeof d !== "object") throw err(400, "bad_data", "Неверные данные дня недели.");
  const active = d.active === true;
  const start = optTime(d.start, "начало"), end = optTime(d.end, "конец");
  if (active && !start) throw err(400, "bad_time", "Для дня со стримом нужно указать время начала.");
  return { short: str(d.short, 12, "день"), full: str(d.full || d.short, 24, "название дня"), active, start, end };
}

function cleanOverride(o) {
  if (!o || dayNumOf(o.date) == null) throw err(400, "bad_date", "Неверная дата в разовых изменениях.");
  const active = o.active === true;
  const out = { date: o.date, active };
  if (active) {
    out.start = optTime(o.start, "начало");
    if (!out.start) throw err(400, "bad_time", "Для стрима нужно время начала.");
    const end = optTime(o.end, "конец"); if (end) out.end = end;
  }
  if (typeof o.moveId === "string" && /^[A-Za-z0-9-]{1,36}$/.test(o.moveId)) out.moveId = o.moveId;
  return out;
}

// Первичное создание расписания (из config.js): проверяет и приводит к безопасному виду
export function sanitizeSchedule(input) {
  if (!input || typeof input !== "object") throw err(400, "bad_data", "Нет данных расписания.");
  if (!isValidTimezone(input.timezone)) throw err(400, "bad_timezone", "Неизвестный часовой пояс.");
  if (!Array.isArray(input.days) || input.days.length !== 7) throw err(400, "bad_data", "В расписании должно быть ровно 7 дней.");
  const overrides = (Array.isArray(input.overrides) ? input.overrides : []).map(cleanOverride);
  if (overrides.length > MAX_OVERRIDES) throw err(400, "too_many", "Слишком много разовых изменений.");
  return {
    timezone: input.timezone,
    timezoneLabel: typeof input.timezoneLabel === "string" ? input.timezoneLabel.slice(0, 10) : "",
    days: input.days.map(cleanDay),
    overrides,
    live: { on: false, since: null },
  };
}

export const statusMode = (doc) => (doc.live && doc.live.mode === "twitch" ? "twitch" : "manual");

// Итоговый статус эфира для сайта. Источник — ручной переключатель или Twitch (twitch = результат twitchStatus).
// state: "live" | "offline" | "unknown"; on — true только при state === "live".
export function liveStatus(doc, twitch) {
  const live = doc.live || {};
  if (statusMode(doc) === "twitch") {
    const state = twitch && twitch.state ? twitch.state : "unknown";
    return { on: state === "live", state, source: "twitch", since: null };
  }
  return { on: !!live.on, state: live.on ? "live" : "offline", source: "manual", since: live.since || null };
}

// Что видит любой посетитель сайта
export function publicView(doc, version, twitch) {
  return {
    version,
    timezone: doc.timezone,
    timezoneLabel: doc.timezoneLabel,
    days: doc.days,
    overrides: doc.overrides.map((o) => ({ date: o.date, active: o.active, start: o.start, end: o.end })),
    live: liveStatus(doc, twitch),
  };
}

/* ---------- операции (каждая меняет только нужные записи) ---------- */

const newId = () => crypto.randomUUID().slice(0, 8);
const ovAt = (doc, date) => doc.overrides.find((o) => o.date === date);
const without = (doc, pred) => { doc.overrides = doc.overrides.filter((o) => !pred(o)); };

export function prune(doc, now = new Date()) {
  const t = tzNow(doc.timezone, now);
  doc.overrides = doc.overrides.filter((o) => dayNumOf(o.date) >= t.dayNum - KEEP_PAST_DAYS);
  return doc;
}

function checkFutureStream(doc, t, date) {
  const dn = dayNumOf(date);
  if (dn == null) throw err(400, "bad_date", "Некорректная дата.");
  const p = planFor(doc, dn);
  if (!p.active) throw err(409, "not_planned", "На эту дату стрим не запланирован (возможно, он уже изменён). Обновите страницу.");
  if (!isFuture(t, dn, p.start)) throw err(400, "started", "Этот стрим уже начался или прошёл — изменить его нельзя.");
  return { dn, p };
}

export function moveStream(doc, args, now = new Date()) {
  const { fromDate, toDate, toTime } = args || {};
  const t = tzNow(doc.timezone, now);
  const toN = dayNumOf(toDate);
  if (toN == null) throw err(400, "bad_date", "Укажите корректную новую дату.");
  if (typeof toTime !== "string" || !TIME_RE.test(toTime)) throw err(400, "bad_time", "Укажите время в формате ЧЧ:ММ.");
  const { dn: fromN, p: fromPlan } = checkFutureStream(doc, t, fromDate);
  if (!isFuture(t, toN, toTime)) throw err(400, "past", "Новая дата и время должны быть в будущем.");
  if (toN - t.dayNum > HORIZON_DAYS) throw err(400, "too_far", "Нельзя переносить стрим больше чем на год вперёд.");

  const fromOv = ovAt(doc, fromDate);
  const regularActive = !!(doc.days[fromPlan.dow] && doc.days[fromPlan.dow].active && doc.days[fromPlan.dow].start);

  if (toN === fromN) {                                    // то же число, другое время
    if (toTime === fromPlan.start) throw err(400, "same", "Время не изменилось.");
    if (fromOv) { fromOv.start = toTime; delete fromOv.end; }
    else doc.overrides.push({ date: fromDate, active: true, start: toTime, moveId: newId() });
  } else {                                                // другая дата
    if (planFor(doc, toN).active) throw err(409, "busy", "На новую дату уже запланирован стрим.");
    if (ovAt(doc, toDate)) throw err(409, "has_override", "На новую дату уже есть изменение. Сначала верните его в списке изменений.");
    const moveId = (fromOv && fromOv.moveId) || newId();
    if (fromOv) {
      without(doc, (o) => o.date === fromDate);
      if (regularActive) doc.overrides.push({ date: fromDate, active: false, moveId });   // исходный день остаётся отменённым
    } else {
      doc.overrides.push({ date: fromDate, active: false, moveId });
    }
    doc.overrides.push({ date: toDate, active: true, start: toTime, moveId });
  }
  if (doc.overrides.length > MAX_OVERRIDES) throw err(400, "too_many", "Слишком много разовых изменений.");
  return prune(doc, now);
}

export function cancelStream(doc, args, now = new Date()) {
  const date = args && args.date;
  const t = tzNow(doc.timezone, now);
  const { p } = checkFutureStream(doc, t, date);
  const ov = ovAt(doc, date);
  const regularActive = !!(doc.days[p.dow] && doc.days[p.dow].active && doc.days[p.dow].start);
  if (ov) {
    if (regularActive) { ov.active = false; delete ov.start; delete ov.end; ov.moveId = ov.moveId || newId(); }
    else without(doc, (o) => o.date === date);            // добавленный стрим просто убираем
  } else {
    doc.overrides.push({ date, active: false, moveId: newId() });
  }
  return prune(doc, now);
}

// Возвращает исходное расписание: снимает перенос/отмену (вместе со связанной парой записей)
export function restoreDate(doc, args) {
  const date = args && args.date;
  if (dayNumOf(date) == null) throw err(400, "bad_date", "Некорректная дата.");
  const ov = ovAt(doc, date);
  if (!ov) throw err(409, "no_change", "На эту дату нет изменений. Обновите страницу.");
  if (ov.moveId) without(doc, (o) => o.moveId === ov.moveId);
  else without(doc, (o) => o.date === date);
  return doc;
}

export function setWeekly(doc, args) {
  const { index, active, start, end } = args || {};
  if (!Number.isInteger(index) || index < 0 || index > 6) throw err(400, "bad_data", "Неверный день недели.");
  if (typeof active !== "boolean") throw err(400, "bad_data", "Укажите, есть ли стрим в этот день.");
  const s = optTime(start, "начало"), e = optTime(end, "конец");
  if (active && !s) throw err(400, "bad_time", "Для дня со стримом нужно указать время начала.");
  const d = doc.days[index];
  d.active = active;
  if (s) d.start = s;
  d.end = e;
  return doc;
}

export function setLive(doc, args, now = new Date()) {
  if (!args || typeof args.on !== "boolean") throw err(400, "bad_data", "Неверный статус.");
  doc.live = { ...doc.live, ...(args.on ? { on: true, since: now.toISOString() } : { on: false, since: null }) };
  return doc;
}

// Источник статуса: "manual" (переключатель в панели) или "twitch" (автоматически)
export function setStatusMode(doc, args) {
  if (!args || (args.mode !== "manual" && args.mode !== "twitch")) throw err(400, "bad_data", "Неверный режим статуса.");
  doc.live = { ...doc.live, mode: args.mode };
  return doc;
}
