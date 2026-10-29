// Авторизация администратора: пароль в секретах окружения, сессия — подписанный токен в HttpOnly-cookie
import { ApiError } from "./schedule.js";

const COOKIE = "gc_admin";
const SESSION_SECONDS = 8 * 3600;
export const MAX_FAILS = 5;
export const FAIL_WINDOW_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function secrets(env) {
  const password = env.ADMIN_PASSWORD, secret = env.SESSION_SECRET;
  if (!password || !secret || String(secret).length < 16) {
    throw new ApiError(500, "not_configured", "Панель не настроена: задайте секреты ADMIN_PASSWORD и SESSION_SECRET (не короче 16 символов).");
  }
  return { password: String(password), secret: String(secret) };
}

const hmacKey = (secret, usage) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

// Сравнение пароля без утечки по времени: сравниваем SHA-256 хэши за постоянное время
export async function checkPassword(env, given) {
  const { password } = secrets(env);
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(password)),
    crypto.subtle.digest("SHA-256", enc.encode(String(given || ""))),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function makeSessionCookie(env, request) {
  const { secret } = secrets(env);
  const payload = b64u(enc.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, n: crypto.randomUUID() })));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(payload)));
  return cookie(`${payload}.${sig}`, SESSION_SECONDS, request);
}
export const clearSessionCookie = (request) => cookie("", 0, request);

function cookie(value, maxAge, request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";   // на localhost (http) без Secure
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}${secure}`;
}

export async function isAdmin(request, env) {
  const { secret } = secrets(env);
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return false;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), unb64u(sig), enc.encode(payload));
    if (!ok) return false;
    return JSON.parse(new TextDecoder().decode(unb64u(payload))).exp > Date.now() / 1000;
  } catch (e) { return false; }
}

export async function requireAdmin({ request, env }) {
  if (!(await isAdmin(request, env))) throw new ApiError(401, "unauthorized", "Нужно войти в панель управления.");
}

/* ---------- ограничение числа попыток входа (по IP, в D1) ---------- */

export const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "local";

export async function assertNotBlocked(db, ip, now = Date.now()) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?1 AND ts > ?2").bind(ip, now - FAIL_WINDOW_MS).first();
  if (row && row.n >= MAX_FAILS) {
    const e = new ApiError(429, "rate_limited", "Слишком много неудачных попыток входа. Подождите 15 минут и попробуйте снова.");
    e.headers = { "Retry-After": String(FAIL_WINDOW_MS / 1000) };
    throw e;
  }
}
export async function recordFailure(db, ip, now = Date.now()) {
  await db.batch([
    db.prepare("INSERT INTO login_attempts (ip, ts) VALUES (?1, ?2)").bind(ip, now),
    db.prepare("DELETE FROM login_attempts WHERE ts < ?1").bind(now - 24 * 3600 * 1000),
  ]);
}
export const clearFailures = (db, ip) => db.prepare("DELETE FROM login_attempts WHERE ip = ?1").bind(ip).run();
