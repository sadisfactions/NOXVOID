// Подставляет данные из public/config.js в мета-теги и заголовки public/index.html.
//   npm run brand           — обновить index.html и показать, что изменилось
//   npm run brand -- --check — только проверить (ничего не писать); код 1, если index.html расходится с config.js
// Ничего не публикует и не коммитит. Cloudflare Pages отдаёт public/ как есть, поэтому запускать нужно до коммита.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = new URL("../public/", import.meta.url);
const configPath = fileURLToPath(new URL("config.js", dir));
const htmlPath = fileURLToPath(new URL("index.html", dir));
const check = process.argv.includes("--check");

function fail(lines) {
  console.error("brand: ошибка\n" + lines.map((l) => "  - " + l).join("\n"));
  process.exit(1);
}

// config.js — обычный браузерный скрипт (window.GLITCH_CONFIG = {...}); выполняем его в изолированном контексте
const sandbox = { window: {} };
try { vm.runInNewContext(readFileSync(configPath, "utf8"), sandbox, { timeout: 1000 }); }
catch (e) { fail([`не удалось прочитать public/config.js: ${e.message}`]); }
const cfg = sandbox.window.GLITCH_CONFIG;
if (!cfg || typeof cfg !== "object") fail(["в public/config.js нет window.GLITCH_CONFIG"]);

const str = (v) => (typeof v === "string" ? v.trim() : "");
const seo = cfg.seo || {};
const problems = [];
const need = (name, v) => { if (!v) problems.push(`не задано: ${name}`); };
need("nickname", str(cfg.nickname));
need("siteUrl", str(cfg.siteUrl));
need("seo.title", str(seo.title));
need("seo.description", str(seo.description));
need("seo.shareDescription", str(seo.shareDescription));
if (str(cfg.siteUrl) && !/^https:\/\/[^\s/]+\.[^\s/]+\/.*$/.test(str(cfg.siteUrl))) problems.push("siteUrl должен быть полным адресом с https:// и слэшем в конце, например https://example.com/");
if (problems.length) fail(problems);

const nick = str(cfg.nickname), url = str(cfg.siteUrl), title = str(seo.title);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const imageUrl = url + "assets/og.jpg";

// [название, шаблон поиска (первая группа — начало, вторая — конец), новое значение]
const meta = (attr, name) => new RegExp(`(<meta ${attr}="${name}" content=")[^"]*(")`);
const rules = [
  ["title",                    /(<title>)[^<]*(<\/title>)/,                         escText(title)],
  ["description",              meta("name", "description"),                         esc(str(seo.description))],
  ["canonical",                /(<link rel="canonical" href=")[^"]*(")/,            esc(url)],
  ["og:site_name",             meta("property", "og:site_name"),                    esc(nick)],
  ["og:title",                 meta("property", "og:title"),                        esc(title)],
  ["og:description",           meta("property", "og:description"),                  esc(str(seo.shareDescription))],
  ["og:url",                   meta("property", "og:url"),                          esc(url)],
  ["og:image",                 meta("property", "og:image"),                        esc(imageUrl)],
  ["og:image:alt",             meta("property", "og:image:alt"),                    esc(title + ": заголовок и фирменный персонаж")],
  ["twitter:title",            meta("name", "twitter:title"),                       esc(title)],
  ["twitter:description",      meta("name", "twitter:description"),                 esc(str(seo.shareDescription))],
  ["twitter:image",            meta("name", "twitter:image"),                       esc(imageUrl)],
  // запасной текст для случая, когда скрипт не выполнился (заменяется script.js из config.js)
  ["ник в шапке",              /(<span class="brand-logo" data-bind="nickname" data-text=")[^"]*(">)[^<]*(<\/span>)/, null],
  ["ник в заголовке h1",       /(<h1 class="nick" id="nick"><span data-bind="nickname">)[^<]*(<\/span>)/,            escText(nick)],
];

let html = readFileSync(htmlPath, "utf8");
const changed = [], same = [], missing = [];
for (const [name, re, val] of rules) {
  const m = html.match(re);
  if (!m) { missing.push(name); continue; }
  let next;
  if (name === "ник в шапке") next = `${m[1]}${esc(nick)}${m[2]}${escText(nick)}${m[3]}`;
  else next = m[1] + val + m[2];
  if (next === m[0]) { same.push(name); continue; }
  html = html.replace(re, () => next);
  changed.push(`${name} → ${val ?? nick}`);
}
if (missing.length) fail(missing.map((n) => `в index.html не найден тег: ${n} (шаблон изменён вручную?)`));

console.log(`brand: ${nick} · ${url}`);
if (changed.length) changed.forEach((c) => console.log("  обновлено  " + c));
console.log(`  без изменений: ${same.length} из ${rules.length}`);
if (!changed.length) { console.log("brand: index.html уже соответствует config.js"); process.exit(0); }
if (check) { console.error("brand: index.html расходится с config.js — выполните npm run brand"); process.exit(1); }
writeFileSync(htmlPath, html);
console.log("brand: public/index.html обновлён");
console.log("Напоминание: картинки (assets/og.jpg, favicon, арт) скрипт не меняет, их заменяют вручную (SETUP.md, раздел 8).");
