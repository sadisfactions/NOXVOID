import test from "node:test";
import assert from "node:assert/strict";
import { checkPassword, makeSessionCookie, isAdmin, assertNotBlocked, MAX_FAILS } from "../functions/_lib/auth.js";
import { mutate } from "../functions/_lib/store.js";
import { moveStream } from "../functions/_lib/schedule.js";

const env = { ADMIN_PASSWORD: "правильный-пароль", SESSION_SECRET: "x".repeat(40) };
const req = (cookie) => new Request("https://site.example/api/admin/state", { headers: cookie ? { Cookie: cookie } : {} });
const cookieValue = (setCookie) => setCookie.split(";")[0];

test("пароль: верный проходит, неверный и пустой нет", async () => {
  assert.equal(await checkPassword(env, "правильный-пароль"), true);
  assert.equal(await checkPassword(env, "неправильный"), false);
  assert.equal(await checkPassword(env, ""), false);
  assert.equal(await checkPassword(env, undefined), false);
});

test("без секретов вход невозможен (даже с пустым паролем)", async () => {
  await assert.rejects(() => checkPassword({}, ""), (e) => e.code === "not_configured");
  await assert.rejects(() => checkPassword({ ADMIN_PASSWORD: "a", SESSION_SECRET: "коротко" }, "a"), (e) => e.code === "not_configured");
});

test("сессия: cookie защищена, подделка и чужой секрет отклоняются", async () => {
  const set = await makeSessionCookie(env, new Request("https://site.example/api/admin/login"));
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Secure/); assert.match(set, /Path=\/api\/admin/);
  const good = cookieValue(set);
  assert.equal(await isAdmin(req(good), env), true);
  assert.equal(await isAdmin(req(), env), false);
  assert.equal(await isAdmin(req(good.slice(0, -3) + "AAA"), env), false);                    // подпись подделана
  assert.equal(await isAdmin(req("gc_admin=a.b"), env), false);
  assert.equal(await isAdmin(req(good), { ...env, SESSION_SECRET: "y".repeat(40) }), false);  // подписано другим секретом
});

test("сессия истекает", async () => {
  const real = Date.now;
  const set = await makeSessionCookie(env, req());
  Date.now = () => real() + 9 * 3600 * 1000;
  try { assert.equal(await isAdmin(req(cookieValue(set)), env), false); } finally { Date.now = real; }
});

test("на http (localhost) cookie без Secure", async () => {
  const set = await makeSessionCookie(env, new Request("http://localhost:8788/api/admin/login"));
  assert.doesNotMatch(set, /Secure/);
});

// Простая модель D1 для проверки записи с версией
function fakeDb(row, { failFirstUpdates = 0 } = {}) {
  let failing = failFirstUpdates;
  const stmt = (sql) => ({
    bind: (...a) => ({
      first: async () => (sql.includes("COUNT") ? { n: row.attempts || 0 } : null),
      run: async () => {
        if (sql.startsWith("UPDATE")) {
          if (failing > 0) { failing--; row.version++; row.data = row.concurrent ? row.concurrent() : row.data; return { meta: { changes: 0 } }; }
          if (a[2] !== row.version) return { meta: { changes: 0 } };
          row.data = a[0]; row.version++; return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
    }),
    first: async () => ({ data: row.data, version: row.version }),
  });
  return { prepare: (sql) => stmt(sql) };
}
const docJson = () => JSON.stringify({
  timezone: "Europe/Moscow", timezoneLabel: "МСК", overrides: [], live: { on: false, since: null },
  days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ short: "Д" + i, full: "День " + i, active: i === 4 || i === 5, start: i === 4 ? "20:00" : i === 5 ? "18:00" : "", end: "" })),
});
const NOW = new Date("2026-10-29T16:37:00Z");

test("запись в базу: операция применяется к свежим данным, чужое изменение не теряется", async () => {
  // между чтением и записью «другой администратор» успел включить статус «в эфире»
  const row = { data: docJson(), version: 1, concurrent: () => JSON.stringify({ ...JSON.parse(docJson()), live: { on: true, since: "x" } }) };
  const db = fakeDb(row, { failFirstUpdates: 1 });
  const res = await mutate(db, (doc) => moveStream(doc, { fromDate: "2026-10-30", toDate: "2026-11-01", toTime: "21:00" }, NOW), NOW);
  const saved = JSON.parse(row.data);
  assert.equal(saved.live.on, true);                     // чужое изменение сохранилось
  assert.equal(saved.overrides.length, 2);               // наше применено
  assert.equal(res.version, row.version);
});

test("при постоянном конфликте версий честная ошибка, ничего не записывается", async () => {
  const row = { data: docJson(), version: 1 };
  const db = fakeDb(row, { failFirstUpdates: 99 });
  await assert.rejects(() => mutate(db, (d) => d, NOW), (e) => e.code === "conflict");
});

test("пустая база: понятная ошибка", async () => {
  const db = { prepare: () => ({ first: async () => null }) };
  await assert.rejects(() => mutate(db, (d) => d, NOW), (e) => e.code === "not_initialized");
});

test("блокировка после серии неудачных попыток входа", async () => {
  await assert.doesNotReject(() => assertNotBlocked(fakeDb({ attempts: MAX_FAILS - 1 }), "1.2.3.4"));
  await assert.rejects(() => assertNotBlocked(fakeDb({ attempts: MAX_FAILS }), "1.2.3.4"), (e) => e.status === 429 && !!e.headers["Retry-After"]);
});
