-- Кэш для автоматического статуса Twitch (результат проверки и токен приложения).
-- Только добавляет таблицу: существующие данные не затрагиваются, повторный запуск безопасен.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
