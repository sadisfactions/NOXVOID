// Публичный эндпоинт: актуальное расписание и статус «в эфире» для всех посетителей.
// Кэш: 15 секунд в дата-центре (Cache API) + ETag, поэтому браузер получает 304 без тела, а база читается редко.
import { json, fail, handle } from "../_lib/http.js";
import { loadDoc } from "../_lib/store.js";
import { publicView } from "../_lib/schedule.js";

const EDGE_TTL = 15;

export const onRequestGet = handle(async ({ request, env }) => {
  const cache = caches.default;
  const key = new Request(new URL("/api/schedule", request.url).toString());

  let res = await cache.match(key);
  if (!res) {
    const cur = await loadDoc(env.DB);
    if (!cur) return fail(404, "not_initialized", "Расписание ещё не создано.");
    const body = JSON.stringify(publicView(cur.doc, cur.version));
    res = new Response(body, {
      headers: { "Content-Type": "application/json; charset=utf-8", ETag: `"${cur.version}"`, "Cache-Control": `public, max-age=${EDGE_TTL}` },
    });
    await cache.put(key, res.clone());
  }

  const etag = res.headers.get("ETag");
  const headers = { ETag: etag, "Cache-Control": "no-cache" };             // браузер всегда сверяется по ETag
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return new Response(res.body, { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
});