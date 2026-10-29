// Общие помощники для ответов API
import { ApiError } from "./schedule.js";

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

export const fail = (status, error, message, headers) => json({ error, message }, status, headers);

// Оборачивает обработчик: понятные сообщения вместо падения, без утечки подробностей наружу
export const handle = (fn) => async (context) => {
  try {
    return await fn(context);
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.code, e.message, e.headers);
    console.error("API error:", e && e.stack ? e.stack : e);
    return fail(503, "storage", "Не удалось выполнить операцию: хранилище недоступно или произошла ошибка. Изменения не сохранены.");
  }
};

// Тело запроса: только JSON, небольшой размер, запрос с того же сайта (защита от подделки запросов)
export async function readJson(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== url.host) throw new ApiError(403, "origin", "Запрос отклонён: неверный источник.");
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "content_type", "Ожидается JSON.");
  }
  const text = await request.text();
  if (text.length > 20000) throw new ApiError(413, "too_large", "Слишком большой запрос.");
  try { return JSON.parse(text || "{}"); } catch (e) { throw new ApiError(400, "bad_json", "Некорректный запрос."); }
}
