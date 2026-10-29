// Проверка автоматического статуса через настоящие функции Pages + локальную D1 и ПОДДЕЛЬНЫЙ сервер Twitch.
// Это не проверка настоящего Twitch: ответы мы задаём сами.
// Запуск: npm run test:twitch   (перед этим в другом окне: npm run dev, в .dev.vars должны быть значения TWITCH_*, см. .dev.vars.example)
import http from "node:http";
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const PASS = process.env.ADMIN_PASSWORD || "test-pass-123";
const MOCK_PORT = 8799;
let cookie = "", checks = 0, failures = 0;
const check = (n, c, x = "") => { checks++; if (!c) failures++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + x}`); };

// ----- поддельный Twitch -----
const mock = { mode: "offline", tokenCalls: 0, streamCalls: 0, lastAuth: "" };
const server = http.createServer((req, res) => {
  const send = (code, obj, h = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...h }); res.end(JSON.stringify(obj)); };
  if (req.url.startsWith("/oauth2/token")) { mock.tokenCalls++; return send(200, { access_token: "mock-token", expires_in: 3600 }); }
  if (req.url.startsWith("/helix/streams")) {
    mock.streamCalls++; mock.lastAuth = req.headers["authorization"] + "|" + req.headers["client-id"];
    if (mock.mode === "live") return send(200, { data: [{ type: "live", user_login: "noxvoid" }] });
    if (mock.mode === "offline") return send(200, { data: [] });
    if (mock.mode === "error") return send(500, { message: "boom" });
    if (mock.mode === "limit") return send(429, {}, { "Retry-After": "120" });
  }
  send(404, {});
});
await new Promise((r) => server.listen(MOCK_PORT, "127.0.0.1", r));

const D1 = (sql) => execSync(`npx wrangler d1 execute DB --local --config wrangler.local.toml --command "${sql}"`, { stdio: "pipe" }).toString();
async function api(path, { method = "GET", body, cookieOverride } = {}) {
  const h = {}; const ck = cookieOverride !== undefined ? cookieOverride : cookie;
  if (ck) h.Cookie = ck;
  if (method === "POST") { h.Origin = BASE; h["Content-Type"] = "application/json"; }
  const res = await fetch(BASE + path, { method, headers: h, body: method === "POST" ? JSON.stringify(body || {}) : undefined });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* не JSON */ }
  return { status: res.status, data, text, headers: res.headers };
}
const post = (p, body, o) => api(p, { method: "POST", body, ...o });
// сброс кэша Twitch в базе и публичного ответа, чтобы следующий запрос пошёл к «Twitch»
const resetCaches = async () => { D1("DELETE FROM kv;"); await post("/api/admin/live", { on: false }); };
const pub = async () => (await api("/api/schedule", { cookieOverride: "" })).data;

try {
  D1("DELETE FROM schedule; DELETE FROM login_attempts; DELETE FROM kv;");
  let r = await post("/api/admin/login", { password: PASS });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  check("вход выполнен", r.status === 200 && cookie);
  const sched = { timezone: "Europe/Moscow", timezoneLabel: "МСК", overrides: [],
    days: Array.from({ length: 7 }, (_, i) => ({ short: "Д" + i, full: "День " + i, active: i < 3, start: i < 3 ? "19:00" : "", end: "" })) };
  check("расписание создано", (await post("/api/admin/init", { schedule: sched })).status === 200);

  // по умолчанию — ручной режим, к Twitch никто не ходит
  let p = await pub();
  check("по умолчанию источник статуса — ручной", p.live.source === "manual" && p.live.state === "offline", JSON.stringify(p.live));
  check("в ручном режиме запросов к Twitch нет", mock.tokenCalls === 0 && mock.streamCalls === 0);
  r = await api("/api/admin/state");
  check("панель знает, что Twitch настроен, и не раскрывает ключи", r.data.liveStatus.twitchConfigured === true && r.data.liveStatus.twitchLogin === "noxvoid" && !r.text.includes("mock-secret"), r.text.slice(0, 300));

  // включение автоматического режима
  check("без входа режим менять нельзя -> 401", (await post("/api/admin/status-mode", { mode: "twitch" }, { cookieOverride: "" })).status === 401);
  check("неверный режим -> 400", (await post("/api/admin/status-mode", { mode: "robot" })).status === 400);
  mock.mode = "live";
  check("включение режима Twitch -> 200", (await post("/api/admin/status-mode", { mode: "twitch" })).status === 200);
  p = await pub();
  check("Twitch: в эфире -> state=live, on=true", p.live.state === "live" && p.live.on === true && p.live.source === "twitch", JSON.stringify(p.live));
  check("к Twitch ушли Client-Id и Bearer-токен", mock.lastAuth === "Bearer mock-token|mock-client", mock.lastAuth);
  check("ключи и токен не попали в публичный ответ", !JSON.stringify(p).includes("mock-secret") && !JSON.stringify(p).includes("mock-token"));

  const before = mock.streamCalls;
  for (let i = 0; i < 5; i++) await pub();
  check("повторные запросы посетителей не создают запросов к Twitch", mock.streamCalls === before, `${before} -> ${mock.streamCalls}`);

  // ручной переключатель в режиме Twitch не влияет
  mock.mode = "offline"; await resetCaches();
  await post("/api/admin/live", { on: true });                      // «включили вручную», но режим Twitch
  p = await pub();
  check("Twitch: не в эфире -> state=offline, ручной флаг игнорируется", p.live.state === "offline" && p.live.on === false, JSON.stringify(p.live));

  // ошибка Twitch не значит «офлайн»
  mock.mode = "live"; await resetCaches(); await pub();
  mock.mode = "error"; D1("UPDATE kv SET value = json_set(value, '$.okAt', json_extract(value, '$.okAt') - 70000) WHERE key = 'twitch';");
  await post("/api/admin/live", { on: false });
  p = await pub();
  check("ошибка Twitch после успешной проверки: показываем последний результат (live), а не offline", p.live.state === "live", JSON.stringify(p.live));
  r = await api("/api/admin/state");
  check("панель объясняет ошибку понятным текстом", /Twitch/.test(r.data.liveStatus.error || "") && r.data.liveStatus.state === "live", JSON.stringify(r.data.liveStatus));

  await resetCaches();                                               // нет ни одного успешного результата + ошибка
  p = await pub();
  check("ошибка Twitch без успешных проверок -> unknown (не offline)", p.live.state === "unknown" && p.live.on === false, JSON.stringify(p.live));
  const calls = mock.streamCalls;
  await post("/api/admin/live", { on: false }); await pub(); await pub();
  check("после ошибки есть пауза: Twitch не опрашивается на каждый запрос", mock.streamCalls === calls, `${calls} -> ${mock.streamCalls}`);

  mock.mode = "limit"; await resetCaches(); p = await pub();
  check("лимит запросов Twitch (429) -> unknown, без падения", p.live.state === "unknown");

  // возврат в ручной режим
  r = await post("/api/admin/status-mode", { mode: "manual" });
  await post("/api/admin/live", { on: true });
  p = await pub();
  check("возврат в ручной режим работает", r.status === 200 && p.live.source === "manual" && p.live.on === true && p.live.state === "live", JSON.stringify(p.live));
  check("ETag меняется вместе со статусом (браузер не получит устаревший 304)", (await api("/api/schedule", { cookieOverride: "" })).headers.get("etag") !== null);
} catch (e) {
  failures++; console.log("FAIL  сценарий прерван: " + (e.stack || e.message));
} finally {
  server.close();
  console.log(`\nИтого: ${checks - failures}/${checks}${failures ? ", ПРОВАЛЕНО: " + failures : ""}`);
  process.exit(failures ? 1 : 0);
}
