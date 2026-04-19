CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  run_at   TIMESTAMPTZ DEFAULT now()
);

INSERT INTO game_tables (name, status)
SELECT name, 'waiting'
FROM (VALUES ('Table 1'), ('Table 2')) AS t(name)
WHERE NOT EXISTS (SELECT 1 FROM game_tables WHERE game_tables.name = t.name);
