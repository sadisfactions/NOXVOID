import test from "node:test";
import assert from "node:assert/strict";
import { twitchStatus, twitchConfigured, FRESH_MS, STALE_MS } from "../functions/_lib/twitch.js";
import { liveStatus, publicView, setStatusMode, setLive } from "../functions/_lib/schedule.js";

// Простейшая замена D1 для таблицы kv
function kvDb({ broken = false } = {}) {
  const m = new Map();
  return {
    m,
    prepare: (sql) => ({
      bind: (...a) => ({
        first: async () => { if (broken) throw new Error("db down"); return m.has(a[0]) ? { value: m.get(a[0]) } : null; },
        run: async () => { if (broken) throw new Error("db down"); m.set(a[0], a[1]); return { meta: { changes: 1 } }; },
      }),
    }),
  };
}

const baseEnv = (db) => ({ DB: db, TWITCH_CLIENT_ID: "id", TWITCH_CLIENT_SECRET: "secret", TWITCH_LOGIN: "noxvoid" });

// Подмена fetch: сценарий задаёт ответы на токен и на /helix/streams
function mockFetch(handlers) {
  const calls = { token: 0, streams: 0 };
  globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) { calls.token++; return handlers.token(opt, calls); }
    if (u.includes("/helix/streams")) { calls.streams++; return handlers.streams(opt, calls, u); }
    throw new Error("неожиданный запрос " + u);
  };
  return calls;
}
const j = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers });
const tokenOk = () => j({ access_token: "tok1", expires_in: 3600 });
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("twitchConfigured: нужны все три значения и корректный логин", () => {
  assert.equal(twitchConfigured(baseEnv({})), true);
  assert.equal(twitchConfigured({ TWITCH_CLIENT_ID: "a", TWITCH_CLIENT_SECRET: "b" }), false);
  assert.equal(twitchConfigured({ ...baseEnv({}), TWITCH_LOGIN: "bad login!" }), false);
  assert.equal(twitchConfigured({ ...baseEnv({}), TWITCH_LOGIN: "@noxvoid" }), true);
});

test("не настроен -> unknown, в сеть не ходим", async () => {
  const calls = mockFetch({ token: tokenOk, streams: () => j({ data: [] }) });
  const r = await twitchStatus({ DB: kvDb() });
  assert.equal(r.state, "unknown"); assert.equal(calls.token + calls.streams, 0);
});

test("стример в эфире -> live; запрос с Client-Id и Bearer", async () => {
  let hdr;
  mockFetch({ token: tokenOk, streams: (opt) => { hdr = opt.headers; return j({ data: [{ type: "live", user_login: "noxvoid" }] }); } });
  const r = await twitchStatus(baseEnv(kvDb()), 1000);
  assert.equal(r.state, "live"); assert.equal(hdr["Client-Id"], "id"); assert.equal(hdr.Authorization, "Bearer tok1");
});

test("пустой список -> offline", async () => {
  mockFetch({ token: tokenOk, streams: () => j({ data: [] }) });
  assert.equal((await twitchStatus(baseEnv(kvDb()), 1000)).state, "offline");
});

test("кэш: в течение минуты Twitch не опрашивается повторно; токен переиспользуется", async () => {
  const db = kvDb();
  const calls = mockFetch({ token: tokenOk, streams: () => j({ data: [] }) });
  await twitchStatus(baseEnv(db), 1000);
  await twitchStatus(baseEnv(db), 1000 + FRESH_MS - 1);
  assert.equal(calls.streams, 1);
  await twitchStatus(baseEnv(db), 1000 + FRESH_MS + 1);
  assert.equal(calls.streams, 2); assert.equal(calls.token, 1);
});

test("ошибка Twitch не превращается в offline: недавний результат сохраняется, затем unknown", async () => {
  const db = kvDb();
  mockFetch({ token: tokenOk, streams: () => j({ data: [{ type: "live" }] }) });
  await twitchStatus(baseEnv(db), 1000);
  mockFetch({ token: tokenOk, streams: () => j({}, 500) });
  const soon = await twitchStatus(baseEnv(db), 1000 + FRESH_MS + 5000);
  assert.equal(soon.state, "live"); assert.equal(soon.error, "http_500");
  const late = await twitchStatus(baseEnv(db), 1000 + STALE_MS + 60000);
  assert.equal(late.state, "unknown");
});

test("без единого успешного ответа -> unknown (не offline)", async () => {
  mockFetch({ token: tokenOk, streams: () => { throw new Error("сеть"); } });
  const r = await twitchStatus(baseEnv(kvDb()), 1000);
  assert.equal(r.state, "unknown"); assert.equal(r.error, "network");
});

test("пауза после ошибки: повторные запросы не бомбят Twitch", async () => {
  const db = kvDb();
  const calls = mockFetch({ token: tokenOk, streams: () => j({}, 500) });
  await twitchStatus(baseEnv(db), 1000);
  await twitchStatus(baseEnv(db), 1000 + 5000);
  assert.equal(calls.streams, 1);
});

test("429: учитывается Retry-After", async () => {
  const db = kvDb();
  const calls = mockFetch({ token: tokenOk, streams: () => j({}, 429, { "Retry-After": "120" }) });
  const r = await twitchStatus(baseEnv(db), 1000);
  assert.equal(r.error, "rate_limit");
  await twitchStatus(baseEnv(db), 1000 + 100000);
  assert.equal(calls.streams, 1);                                 // 100 с < 120 с — ещё ждём
  await twitchStatus(baseEnv(db), 1000 + 121000);
  assert.equal(calls.streams, 2);
});

test("неверные ключи: ошибка auth, долгая пауза, статус unknown", async () => {
  const db = kvDb();
  const calls = mockFetch({ token: () => j({ message: "invalid client" }, 400), streams: () => j({ data: [] }) });
  const r = await twitchStatus(baseEnv(db), 1000);
  assert.equal(r.state, "unknown"); assert.equal(r.error, "auth");
  await twitchStatus(baseEnv(db), 1000 + 120000);
  assert.equal(calls.token, 1);
});

test("токен отозван (401): берётся новый и запрос повторяется один раз", async () => {
  let n = 0;
  const calls = mockFetch({
    token: () => j({ access_token: "tok" + (++n), expires_in: 3600 }),
    streams: (opt) => opt.headers.Authorization === "Bearer tok1" ? j({}, 401) : j({ data: [{ type: "live" }] }),
  });
  const r = await twitchStatus(baseEnv(kvDb()), 1000);
  assert.equal(r.state, "live"); assert.equal(calls.token, 2); assert.equal(calls.streams, 2);
});

test("недоступная база не роняет сайт", async () => {
  mockFetch({ token: tokenOk, streams: () => j({ data: [] }) });
  const r = await twitchStatus(baseEnv(kvDb({ broken: true })), 1000);
  assert.equal(r.state, "unknown");
});

test("смена канала сбрасывает старый результат", async () => {
  const db = kvDb();
  mockFetch({ token: tokenOk, streams: () => j({ data: [{ type: "live" }] }) });
  await twitchStatus(baseEnv(db), 1000);
  const calls = mockFetch({ token: tokenOk, streams: () => j({ data: [] }) });
  const r = await twitchStatus({ ...baseEnv(db), TWITCH_LOGIN: "other" }, 1500);
  assert.equal(calls.streams, 1); assert.equal(r.state, "offline");
});

test("liveStatus: ручной режим по умолчанию; Twitch-режим берёт состояние Twitch", () => {
  const doc = { live: { on: true, since: "x" } };
  assert.deepEqual(liveStatus(doc, { state: "offline" }), { on: true, state: "live", source: "manual", since: "x" });
  setStatusMode(doc, { mode: "twitch" });
  assert.equal(liveStatus(doc, { state: "offline" }).state, "offline");
  assert.equal(liveStatus(doc, { state: "unknown" }).on, false);
  assert.equal(liveStatus(doc, null).state, "unknown");
  setLive(doc, { on: false });
  assert.equal(doc.live.mode, "twitch");                          // ручное переключение не сбрасывает режим
  assert.throws(() => setStatusMode(doc, { mode: "auto" }), (e) => e.status === 400);
  assert.equal(publicView({ ...doc, days: [], overrides: [] }, 3, { state: "live" }).live.on, true);
});
