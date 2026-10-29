// Всё, что нужно панели: полное расписание, предстоящие стримы, изменения, статус
import { json, handle } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { loadDoc } from "../../_lib/store.js";
import { upcoming, startedToday } from "../../_lib/schedule.js";

export const onRequestGet = handle(async (ctx) => {
  await requireAdmin(ctx);
  const cur = await loadDoc(ctx.env.DB);
  if (!cur) return json({ initialized: false });
  const now = new Date();
  return json({
    initialized: true,
    version: cur.version,
    schedule: cur.doc,
    upcoming: upcoming(cur.doc, now, 8),
    startedToday: startedToday(cur.doc, now),
    serverNow: now.toISOString(),
  });
});