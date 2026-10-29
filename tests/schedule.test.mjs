import test from "node:test";
import assert from "node:assert/strict";
import {
  tzNow, upcoming, nextStream, startedToday, planFor, dayNumOf, isoOf,
  moveStream, cancelStream, restoreDate, setWeekly, setLive, sanitizeSchedule, prune, publicView,
} from "../functions/_lib/schedule.js";

// «Сейчас»: четверг 29.10.2026, 19:37 по Москве (16:37 UTC)
const NOW = new Date("2026-10-29T16:37:00Z");

const base = () => ({
  timezone: "Europe/Moscow", timezoneLabel: "МСК",
  days: [
    { short: "ПН", full: "Понедельник", active: true,  start: "19:00", end: "23:00" },
    { short: "ВТ", full: "Вторник",     active: false, start: "", end: "" },
    { short: "СР", full: "Среда",       active: true,  start: "19:00", end: "23:00" },
    { short: "ЧТ", full: "Четверг",     active: false, start: "", end: "" },
    { short: "ПТ", full: "Пятница",     active: true,  start: "20:00", end: "00:00" },
    { short: "СБ", full: "Суббота",     active: true,  start: "18:00", end: "" },
    { short: "ВС", full: "Воскресенье", active: false, start: "", end: "" },
  ],
  overrides: [],
  live: { on: false, since: null },
});
const err = (code) => (e) => e && e.code === code;
const dates = (doc) => upcoming(doc, NOW, 6).map((s) => `${s.date} ${s.start}`);

test("часовой пояс стримера, а не браузера", () => {
  const t = tzNow("Europe/Moscow", NOW);
  assert.equal(t.dow, 3);                               // четверг
  assert.equal(t.mins, 19 * 60 + 37);
  const night = new Date("2026-10-29T21:30:00Z");       // тот же момент: в Москве уже пятница, в Нью-Йорке ещё четверг
  assert.equal(tzNow("Europe/Moscow", night).dow, 4);
  assert.equal(tzNow("America/New_York", night).dow, 3);
});

test("ближайший стрим и список предстоящих", () => {
  const doc = base();
  assert.equal(nextStream(doc, NOW).date, "2026-10-30");
  assert.deepEqual(dates(doc), ["2026-10-30 20:00", "2026-10-31 18:00", "2026-11-02 19:00", "2026-11-04 19:00", "2026-11-06 20:00", "2026-11-07 18:00"]);
});

test("стрим сегодня, который уже начался по плану, не считается ближайшим", () => {
  const wedEvening = new Date("2026-10-28T17:00:00Z");  // среда 20:00 МСК, стрим в 19:00
  const doc = base();
  assert.equal(startedToday(doc, wedEvening).start, "19:00");
  assert.equal(nextStream(doc, wedEvening).date, "2026-10-30");
  assert.equal(startedToday(doc, NOW), null);           // в четверг стримов нет
});

test("перенос пятницы на воскресенье: остальные события не затронуты", () => {
  const doc = base();
  moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-01", toTime: "21:00" }, NOW);
  assert.equal(doc.overrides.length, 2);
  assert.equal(doc.overrides[0].moveId, doc.overrides[1].moveId);
  assert.deepEqual(dates(doc), ["2026-10-31 18:00", "2026-11-01 21:00", "2026-11-02 19:00", "2026-11-04 19:00", "2026-11-06 20:00", "2026-11-07 18:00"]);
  assert.deepEqual(doc.days, base().days);              // регулярный план не тронут
});

test("перенос на другое время в тот же день", () => {
  const doc = base();
  moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-10-30", toTime: "22:00" }, NOW);
  assert.equal(doc.overrides.length, 1);
  assert.equal(dates(doc)[0], "2026-10-30 22:00");
  restoreDate(doc, { date: "2026-10-30" });
  assert.equal(dates(doc)[0], "2026-10-30 20:00");
});

test("отмена одного стрима не трогает регулярное расписание, возврат восстанавливает", () => {
  const doc = base();
  cancelStream(doc, { date: "2026-10-31" }, NOW);
  assert.equal(dates(doc)[1], "2026-11-02 19:00");
  assert.deepEqual(doc.days, base().days);
  restoreDate(doc, { date: "2026-10-31" });
  assert.deepEqual(dates(doc), dates(base()));
  assert.equal(doc.overrides.length, 0);
});

test("перенос уже перенесённого стрима и полный возврат", () => {
  const doc = base();
  moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-01", toTime: "20:00" }, NOW);   // ПТ -> ВС
  moveStream(doc, { fromDate: "2026-11-01", toDate: "2026-11-03", toTime: "18:00" }, NOW);   // ВС -> ВТ
  assert.equal(doc.overrides.length, 2);
  assert.ok(dates(doc).includes("2026-11-03 18:00") && !dates(doc).includes("2026-11-01 20:00"));
  restoreDate(doc, { date: "2026-11-03" });                                                  // снимает всю цепочку
  assert.equal(doc.overrides.length, 0);
  assert.deepEqual(dates(doc), dates(base()));
});

test("отмена перенесённого стрима", () => {
  const doc = base();
  moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-01", toTime: "20:00" }, NOW);
  cancelStream(doc, { date: "2026-11-01" }, NOW);
  assert.ok(!dates(doc).some((x) => x.startsWith("2026-11-01")) && !dates(doc).some((x) => x.startsWith("2026-10-30")));
  restoreDate(doc, { date: "2026-10-30" });                                                  // возврат исходного
  assert.deepEqual(dates(doc), dates(base()));
});

test("ошибки: прошлое, неверные данные, чужие даты", () => {
  const doc = base();
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-10-28", toTime: "20:00" }, NOW), err("past"));   // вчера
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-10-29", toTime: "19:00" }, NOW), err("past"));   // сегодня, но время уже прошло
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-02-31", toTime: "20:00" }, NOW), err("bad_date"));
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-01", toTime: "25:00" }, NOW), err("bad_time"));
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-01" }, NOW), err("bad_time"));
  assert.throws(() => moveStream(doc, { fromDate: "2026-11-01", toDate: "2026-11-03", toTime: "20:00" }, NOW), err("not_planned"));
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-10-31", toTime: "20:00" }, NOW), err("busy"));
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2028-10-30", toTime: "20:00" }, NOW), err("too_far"));
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-10-30", toTime: "20:00" }, NOW), err("same"));
  assert.throws(() => cancelStream(doc, { date: "2026-11-01" }, NOW), err("not_planned"));
  assert.throws(() => restoreDate(doc, { date: "2026-10-30" }), err("no_change"));
  assert.deepEqual(doc, base());                         // при ошибках ничего не изменилось
});

test("нельзя переносить стрим, который уже начался", () => {
  const doc = base();
  const wedEvening = new Date("2026-10-28T17:00:00Z");   // среда 20:00 МСК
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-28", toDate: "2026-10-29", toTime: "21:00" }, wedEvening), err("started"));
  assert.throws(() => cancelStream(doc, { date: "2026-10-28" }, wedEvening), err("started"));
});

test("перенос на дату с другим изменением запрещён", () => {
  const doc = base();
  cancelStream(doc, { date: "2026-11-02" }, NOW);        // ПН отменён
  assert.throws(() => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-02", toTime: "20:00" }, NOW), err("has_override"));
});

test("правка регулярного дня меняет только этот день и не теряет разовые изменения", () => {
  const doc = base();
  cancelStream(doc, { date: "2026-10-31" }, NOW);
  setWeekly(doc, { index: 1, active: true, start: "21:00", end: "" });   // ВТ становится стримовым
  assert.equal(doc.days[1].active, true);
  assert.deepEqual(doc.days.filter((_, i) => i !== 1), base().days.filter((_, i) => i !== 1));
  assert.equal(doc.overrides.length, 1);
  assert.throws(() => setWeekly(doc, { index: 9, active: true, start: "20:00" }), err("bad_data"));
  assert.throws(() => setWeekly(doc, { index: 0, active: true, start: "" }), err("bad_time"));
  setWeekly(doc, { index: 1, active: false, start: "", end: "" });
  assert.equal(doc.days[1].active, false);
});

test("статус «в эфире» переключается вручную и не зависит от расписания", () => {
  const doc = base();
  setLive(doc, { on: true }, NOW);
  assert.deepEqual(doc.live, { on: true, since: NOW.toISOString() });
  assert.deepEqual(dates(doc), dates(base()));
  setLive(doc, { on: false }, NOW);
  assert.deepEqual(doc.live, { on: false, since: null });
  assert.throws(() => setLive(doc, { on: "yes" }, NOW), err("bad_data"));
});

test("старые изменения удаляются, будущие остаются", () => {
  const doc = base();
  doc.overrides = [{ date: "2026-08-01", active: false }, { date: "2026-10-20", active: false }, { date: "2026-11-02", active: false }];
  prune(doc, NOW);
  assert.deepEqual(doc.overrides.map((o) => o.date), ["2026-10-20", "2026-11-02"]);
});

test("создание расписания проверяет данные", () => {
  const good = sanitizeSchedule({ ...base(), overrides: [{ date: "2026-10-30", active: false, evil: "<script>" }] });
  assert.deepEqual(good.overrides, [{ date: "2026-10-30", active: false }]);
  assert.throws(() => sanitizeSchedule({ ...base(), timezone: "Mars/Base" }), err("bad_timezone"));
  assert.throws(() => sanitizeSchedule({ ...base(), days: [] }), err("bad_data"));
  assert.throws(() => sanitizeSchedule({ ...base(), overrides: [{ date: "2026-13-40", active: false }] }), err("bad_date"));
  assert.throws(() => sanitizeSchedule({ ...base(), days: base().days.map((d, i) => (i === 0 ? { ...d, start: "7pm" } : d)) }), err("bad_time"));
});

test("публичный ответ не раскрывает служебные поля", () => {
  const doc = base();
  moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-01", toTime: "21:00" }, NOW);
  const pub = publicView(doc, 5);
  assert.equal(pub.version, 5);
  assert.ok(pub.overrides.every((o) => !("moveId" in o)));
});

test("даты: проверка календаря", () => {
  assert.equal(dayNumOf("2026-02-31"), null);
  assert.equal(dayNumOf("2026-2-3"), null);
  assert.equal(isoOf(dayNumOf("2026-10-30")), "2026-10-30");
  assert.equal(planFor(base(), dayNumOf("2026-10-30")).start, "20:00");
});
