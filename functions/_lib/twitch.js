// Автоматический статус «в эфире» через Twitch Helix API (только на сервере).
// Секреты TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET никогда не попадают в браузер.
// Результат проверки кэшируется в D1 (таблица kv), поэтому к Twitch идёт не больше одного запроса в минуту
// на сайт, сколько бы ни было посетителей.
//
// Состояния: "live" | "offline" | "unknown".
// Ошибка или недоступность Twitch НЕ означает «офлайн»: последний успешный результат используется
// не дольше STALE_MS, после чего честно показывается «неизвестно».

export const FRESH_MS = 60 * 1000;          // как часто обновлять результат
export const STALE_MS = 10 * 60 * 1000;     // сколько времени доверять последнему успешному результату
const ERROR_BACKOFF_MS = 30 * 1000;         // пауза после обычной ошибки
const AUTH_BACKOFF_MS = 5 * 60 * 1000;      // пауза после ошибки ключей (неверные Client ID / Secret)
const LOGIN_RE = /^[A-Za-z0-9_]{1,25}$/;

export const twitchLogin = (env) => (env && typeof env.TWITCH_LOGIN === "string" ? env.TWITCH_LOGIN.trim().replace(/^@/, "") : "");
export const twitchConfigured = (env) =>
  !!(env && env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && LOGIN_RE.test(twitchLogin(env)));

const authBase = (env) => (env.TWITCH_AUTH_URL || "https://id.twitch.tv").replace(/\/$/, "");   // переопределяется только в тестах
const apiBase = (env) => (env.TWITCH_API_URL || "https://api.twitch.tv").replace(/\/$/, "");

class TwitchError extends Error {
  constructor(code, backoffMs) { super(code); this.code = code; this.backoffMs = backoffMs; }
}

async function kvGet(db, key) {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}
async function kvSet(db, key, value, now) {
  await db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(value), new Date(now).toISOString())
    .run();
}

const timeout = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined);

async function fetchToken(env, db, now, force) {
  if (!force) {
    const t = await kvGet(db, "twitch_token");
    if (t && t.token && t.exp > now + 60 * 1000) return t.token;
  }
  let res;
  try {
    res = await fetch(`${authBase(env)}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" }),
      signal: timeout(),
    });
  } catch (e) { throw new TwitchError("network", ERROR_BACKOFF_MS); }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new TwitchError("auth", AUTH_BACKOFF_MS);
  if (res.status === 429) throw new TwitchError("rate_limit", retryAfter(res));
  if (!res.ok) throw new TwitchError("http_" + res.status, ERROR_BACKOFF_MS);
  let data; try { data = await res.json(); } catch (e) { throw new TwitchError("bad_response", ERROR_BACKOFF_MS); }
  if (!data || typeof data.access_token !== "string") throw new TwitchError("bad_response", ERROR_BACKOFF_MS);
  await kvSet(db, "twitch_token", { token: data.access_token, exp: now + Math.max(0, +data.expires_in || 3600) * 1000 }, now);
  return data.access_token;
}

function retryAfter(res) {
  const s = +res.headers.get("Retry-After");
  if (s > 0) return Math.min(s, 600) * 1000;
  const reset = +res.headers.get("Ratelimit-Reset");                 // секунды Unix-времени
  if (reset > 0) return Math.min(Math.max(reset * 1000 - Date.now(), 5000), 600 * 1000);
  return 60 * 1000;
}

// Запрос к Twitch: true — идёт трансляция, false — нет. Бросает TwitchError, если ответить не удалось.
async function queryLive(env, db, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await fetchToken(env, db, now, attempt > 0);
    let res;
    try {
      res = await fetch(`${apiBase(env)}/helix/streams?user_login=${encodeURIComponent(twitchLogin(env))}`, {
        headers: { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        signal: timeout(),
      });
    } catch (e) { throw new TwitchError("network", ERROR_BACKOFF_MS); }
    if (res.status === 401 && attempt === 0) continue;               // токен устарел — берём новый
    if (res.status === 401 || res.status === 403) throw new TwitchError("auth", AUTH_BACKOFF_MS);
    if (res.status === 429) throw new TwitchError("rate_limit", retryAfter(res));
    if (!res.ok) throw new TwitchError("http_" + res.status, ERROR_BACKOFF_MS);
    let data; try { data = await res.json(); } catch (e) { throw new TwitchError("bad_response", ERROR_BACKOFF_MS); }
    if (!data || !Array.isArray(data.data)) throw new TwitchError("bad_response", ERROR_BACKOFF_MS);
    return data.data.some((s) => s && s.type === "live");           // пустой список = канал сейчас не в эфире
  }
  throw new TwitchError("auth", AUTH_BACKOFF_MS);
}

function derive(row, now) {
  if (!row || !row.okAt || now - row.okAt > STALE_MS) return { state: "unknown", checkedAt: row && row.okAt || null, error: row && row.error || null };
  return { state: row.live ? "live" : "offline", checkedAt: row.okAt, error: row.error || null };
}

// Текущий статус канала. Никогда не бросает исключений: при любой проблеме вернёт "unknown" (или недавний результат).
export async function twitchStatus(env, now = Date.now()) {
  if (!twitchConfigured(env)) return { state: "unknown", checkedAt: null, error: "not_configured" };
  const db = env.DB;
  let row = null;
  try {
    row = await kvGet(db, "twitch");
    if (row && now - row.okAt < FRESH_MS && row.login === twitchLogin(env)) return derive(row, now);
    if (row && row.retryAt > now && row.login === twitchLogin(env)) return derive(row, now);   // пауза после ошибки
    if (row && row.login !== twitchLogin(env)) row = null;                                      // сменили канал — старый результат не годится
    try {
      const live = await queryLive(env, db, now);
      row = { login: twitchLogin(env), live, okAt: now, retryAt: 0, error: null };
    } catch (e) {
      const code = e instanceof TwitchError ? e.code : "network";
      const wait = e instanceof TwitchError ? e.backoffMs : ERROR_BACKOFF_MS;
      row = { ...(row || { login: twitchLogin(env), live: false, okAt: 0 }), retryAt: now + wait, error: code };
    }
    await kvSet(db, "twitch", row, now);
    return derive(row, now);
  } catch (e) {
    console.error("Twitch status error:", e && e.stack ? e.stack : e);
    return derive(row, now);                                         // например, недоступна база
  }
}

export const TWITCH_ERRORS = {
  not_configured: "Twitch не настроен.",
  auth: "Twitch отклонил ключи приложения. Проверьте TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET.",
  rate_limit: "Twitch временно ограничил запросы. Повторная проверка будет позже.",
  network: "Сервер не смог связаться с Twitch.",
  bad_response: "Twitch вернул непонятный ответ.",
};
