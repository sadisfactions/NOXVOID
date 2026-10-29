// Первое создание расписания (из config.js). Работает только пока в базе пусто.
import { json, handle, readJson } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { createDoc, purgePublicCache } from "../../_lib/store.js";
import { sanitizeSchedule } from "../../_lib/schedule.js";

export const onRequestPost = handle(async (ctx) => {
  await requireAdmin(ctx);
  const body = await readJson(ctx.request);
  await createDoc(ctx.env.DB, sanitizeSchedule(body.schedule));
  await purgePublicCache(ctx.request);
  return json({ ok: true });
});