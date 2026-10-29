import { json, handle, readJson } from "../../_lib/http.js";
import { requireAdmin } from "../../_lib/auth.js";
import { mutate, purgePublicCache } from "../../_lib/store.js";
import { setWeekly } from "../../_lib/schedule.js";

export const onRequestPost = handle(async (ctx) => {
  await requireAdmin(ctx);
  const args = await readJson(ctx.request);
  const now = new Date();
  const { version } = await mutate(ctx.env.DB, (doc) => setWeekly(doc, args, now), now);
  await purgePublicCache(ctx.request);
  return json({ ok: true, version });
});