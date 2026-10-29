import { json, fail, handle, readJson } from "../../_lib/http.js";
import { checkPassword, makeSessionCookie, assertNotBlocked, recordFailure, clearFailures, clientIp } from "../../_lib/auth.js";

export const onRequestPost = handle(async ({ request, env }) => {
  const { password } = await readJson(request);
  const ip = clientIp(request);
  await assertNotBlocked(env.DB, ip);
  if (!(await checkPassword(env, password))) {
    await recordFailure(env.DB, ip);
    await new Promise((r) => setTimeout(r, 300));          // небольшая задержка против перебора
    return fail(401, "bad_password", "Неверный пароль.");
  }
  await clearFailures(env.DB, ip);
  return json({ ok: true }, 200, { "Set-Cookie": await makeSessionCookie(env, request) });
});