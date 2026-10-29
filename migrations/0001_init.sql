-- GLITCH//CORE: расписание стримов и защита входа в админку
CREATE TABLE IF NOT EXISTS schedule (
  id         INTEGER PRIMARY KEY CHECK (id = 1),   -- всегда одна строка
  data       TEXT    NOT NULL,                     -- JSON: часовой пояс, дни, разовые изменения, статус «в эфире»
  version    INTEGER NOT NULL,                     -- растёт при каждом изменении
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (        -- неудачные попытки входа
  ip TEXT    NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (ip, ts);