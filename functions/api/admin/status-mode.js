import { json, handle, readJson } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { mutate, purgePublicCache } from "../../_lib/store.js";
import { ApiError, setStatusMode } from "../../_lib/schedule.js";
import { twitchConfigured } from "../../_lib/twitch.js";

export const onRequestPost = handle(async (ctx) => {
  await requireAdmin(ctx);
  const args = await readJson(ctx.request);
  if (args && args.mode === "twitch" && !twitchConfigured(ctx.env)) {
    throw new ApiError(409, "twitch_not_configured", "Twitch не настроен: добавьте TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET и TWITCH_LOGIN в настройках Cloudflare (см. DEPLOY.md) и опубликуйте заново.");
  }
  const now = new Date();
  const { version } = await mutate(ctx.env.DB, (doc) => setStatusMode(doc, args), now);
  await purgePublicCache(ctx.request);
  return json({ ok: true, version });
});
