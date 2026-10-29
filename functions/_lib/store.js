// Работа с D1: чтение документа расписания и безопасная запись (с проверкой версии)
import { ApiError, prune } from "./schedule.js";

const notReady = () => new ApiError(404, "not_initialized", "Расписание ещё не создано.");

export async function loadDoc(db) {
  const row = await db.prepare("SELECT data, version FROM schedule WHERE id = 1").first();
  return row ? { doc: JSON.parse(row.data), version: row.version } : null;
}

// Читает свежий документ, применяет операцию и записывает, только если версия не изменилась.
// При одновременной правке повторяет операцию на новых данных, поэтому чужие изменения не теряются.
export async function mutate(db, op, now = new Date()) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await loadDoc(db);
    if (!cur) throw notReady();
    const next = op(structuredClone(cur.doc));
    const res = await db
      .prepare("UPDATE schedule SET data = ?1, version = version + 1, updated_at = ?2 WHERE id = 1 AND version = ?3")
      .bind(JSON.stringify(next), now.toISOString(), cur.version)
      .run();
    if (res.meta && res.meta.changes === 1) return { doc: next, version: cur.version + 1 };
  }
  throw new ApiError(409, "conflict", "Расписание одновременно изменили в другом окне. Обновите страницу и повторите.");
}

export async function createDoc(db, doc, now = new Date()) {
  const res = await db
    .prepare("INSERT INTO schedule (id, data, version, updated_at) VALUES (1, ?1, 1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(JSON.stringify(prune(doc, now)), now.toISOString())
    .run();
  if (!res.meta || res.meta.changes !== 1) {
    throw new ApiError(409, "exists", "Расписание уже создано. Изменяйте его в панели управления.");
  }
}

// Сброс кэша публичного ответа после изменений (кэш действует в пределах одного дата-центра)
export async function purgePublicCache(request) {
  try {
    await caches.default.delete(new Request(new URL("/api/schedule", request.url).toString()));
  } catch (e) { /* кэш необязателен */ }
}
