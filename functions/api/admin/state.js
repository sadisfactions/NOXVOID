// Всё, что нужно панели: полное расписание, предстоящие стримы, изменения, статус
import { json, handle } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { loadDoc } from "../../_lib/store.js";
import { upcoming, startedToday, liveStatus, statusMode } from "../../_lib/schedule.js";
import { twitchStatus, twitchConfigured, twitchLogin, TWITCH_ERRORS } from "../../_lib/twitch.js";

export const onRequestGet = handle(async (ctx) => {
  await requireAdmin(ctx);
  const cur = await loadDoc(ctx.env.DB);
  if (!cur) return json({ initialized: false });
  const now = new Date();
  const configured = twitchConfigured(ctx.env);
  const mode = statusMode(cur.doc);
  const tw = mode === "twitch" ? await twitchStatus(ctx.env) : null;     // кэшируется, не чаще раза в минуту
  return json({
    liveStatus: {
      ...liveStatus(cur.doc, tw),
      mode,
      twitchConfigured: configured,
      twitchLogin: configured ? twitchLogin(ctx.env) : null,
      checkedAt: tw ? tw.checkedAt : null,
      error: tw && tw.error ? (TWITCH_ERRORS[tw.error] || "Ошибка проверки Twitch.") : null,
    },
    initialized: true,
    version: cur.version,
    schedule: cur.doc,
    upcoming: upcoming(cur.doc, now, 8),
    startedToday: startedToday(cur.doc, now),
    serverNow: now.toISOString(),
  });
});