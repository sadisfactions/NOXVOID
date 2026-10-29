import { json, handle, readJson } from "../../_lib/http.js";
import { clearSessionCookie } from "../../_lib/auth.js";

export const onRequestPost = handle(async ({ request }) => {
  await readJson(request);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(request) });
});